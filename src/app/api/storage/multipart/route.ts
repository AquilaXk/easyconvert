import { NextRequest, NextResponse } from 'next/server';
import { s3Storage } from '@/lib/storage/s3-storage';
import { validateApiAccess, authErrorHeaders } from '@/lib/api-keys/guard';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import { STORAGE_OBJECT_NOT_FOUND, resolveObjectOwnership } from '@/lib/api-keys/owner-access';
import type { UserTier } from '@/lib/auth/types';

export const dynamic = 'force-dynamic';

const MAX_PART_BYTES = 64 * 1024 * 1024; // 64 MiB

const TIER_MAX_MULTIPART_BYTES: Record<UserTier, number> = {
  free: 100 * 1024 * 1024,
  pro: 1024 * 1024 * 1024,
  enterprise: 5 * 1024 * 1024 * 1024,
};

const MAX_MULTIPART_TOTAL_BYTES = 5 * 1024 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const instanceUri = req.nextUrl?.pathname || '/api/storage/multipart';
  const { searchParams } = new URL(req.url);
  const action = searchParams.get('action') || 'initiate';

  // 1. Guard check: Authenticate and enforce 'convert:write' scope on all multipart actions
  const auth = await validateApiAccess(req, { requiredUnits: 0, requiredScope: 'convert:write' });
  if (!auth.authorized || !auth.user) {
    const headers = authErrorHeaders(auth);
    return createProblemDetailsResponse(
      auth.status ?? 401,
      auth.error ?? 'Unauthorized',
      instanceUri,
      undefined,
      auth.problemType,
      headers
    );
  }

  const currentUser = auth.user;

  try {
    // 1. Initiate Multipart Upload
    if (action === 'initiate') {
      const body = await req.json().catch(() => ({}));
      const { filename, mimeType, totalSize } = body;

      if (!filename || typeof totalSize !== 'number') {
        return createProblemDetailsResponse(
          400,
          'Missing "filename" or "totalSize" in initiation payload.',
          instanceUri
        );
      }

      if (totalSize < 0) {
        return createProblemDetailsResponse(
          400,
          'totalSize cannot be negative.',
          instanceUri
        );
      }

      const maxAllowedBytes =
        (currentUser.tier && TIER_MAX_MULTIPART_BYTES[currentUser.tier]) || MAX_MULTIPART_TOTAL_BYTES;

      if (totalSize > maxAllowedBytes) {
        return createProblemDetailsResponse(
          413,
          `Requested total size ${totalSize} bytes exceeds maximum allowed upload size of ${maxAllowedBytes} bytes for tier '${currentUser.tier}'.`,
          instanceUri
        );
      }

      const initResult = s3Storage.initiateMultipartUpload(
        filename,
        mimeType || 'application/octet-stream',
        totalSize,
        currentUser.id
      );
      return NextResponse.json({ success: true, ...initResult });
    }

    // 2. Upload Chunk Part
    if (action === 'chunk') {
      const uploadId = req.headers.get('x-upload-id') || searchParams.get('uploadId');
      const partNumberStr = req.headers.get('x-part-number') || searchParams.get('partNumber');

      if (!uploadId || !partNumberStr) {
        return createProblemDetailsResponse(
          400,
          'Missing "uploadId" or "partNumber" headers.',
          instanceUri
        );
      }

      const sessionOwner = s3Storage.getUploadOwner(uploadId);
      if (!sessionOwner || sessionOwner !== currentUser.id) {
        return createProblemDetailsResponse(
          404,
          STORAGE_OBJECT_NOT_FOUND,
          instanceUri
        );
      }

      const partNumber = parseInt(partNumberStr, 10);
      if (isNaN(partNumber) || partNumber < 1 || partNumber > 10000) {
        return createProblemDetailsResponse(
          400,
          `Invalid part number: ${partNumberStr}`,
          instanceUri
        );
      }

      const contentLengthHeader = req.headers.get('content-length');
      if (contentLengthHeader && parseInt(contentLengthHeader, 10) > MAX_PART_BYTES) {
        return createProblemDetailsResponse(
          413,
          `Part size exceeds maximum allowed part size of ${MAX_PART_BYTES} bytes (64 MiB).`,
          instanceUri
        );
      }

      const arrayBuffer = await req.arrayBuffer();
      const chunkBuffer = Buffer.from(arrayBuffer);

      if (chunkBuffer.length === 0) {
        return createProblemDetailsResponse(
          400,
          'Chunk payload is empty (0 bytes).',
          instanceUri
        );
      }

      if (chunkBuffer.length > MAX_PART_BYTES) {
        return createProblemDetailsResponse(
          413,
          `Part size ${chunkBuffer.length} bytes exceeds maximum allowed part size of ${MAX_PART_BYTES} bytes (64 MiB).`,
          instanceUri
        );
      }

      const partResult = s3Storage.uploadPart(uploadId, partNumber, chunkBuffer);
      return NextResponse.json({ success: true, ...partResult });
    }

    // 3. Complete Multipart Upload
    if (action === 'complete') {
      const body = await req.json().catch(() => ({}));
      const { uploadId, parts } = body;

      if (!uploadId) {
        return createProblemDetailsResponse(
          400,
          'Missing required "uploadId" in complete request.',
          instanceUri
        );
      }

      const sessionOwner = s3Storage.getUploadOwner(uploadId);
      if (!sessionOwner || sessionOwner !== currentUser.id) {
        return createProblemDetailsResponse(
          404,
          STORAGE_OBJECT_NOT_FOUND,
          instanceUri
        );
      }

      const completeResult = s3Storage.completeMultipartUpload(uploadId, parts);
      return NextResponse.json({ success: true, ...completeResult });
    }

    // 4. Abort Multipart Upload
    if (action === 'abort') {
      const body = await req.json().catch(() => ({}));
      const { uploadId } = body;
      if (!uploadId) {
        return createProblemDetailsResponse(
          400,
          'Missing "uploadId"',
          instanceUri
        );
      }

      const sessionOwner = s3Storage.getUploadOwner(uploadId);
      if (!sessionOwner || sessionOwner !== currentUser.id) {
        return createProblemDetailsResponse(
          404,
          STORAGE_OBJECT_NOT_FOUND,
          instanceUri
        );
      }

      const aborted = s3Storage.abortMultipartUpload(uploadId);
      return NextResponse.json({ success: aborted });
    }

    // 5. Generate Presigned URL for Direct Chunk Streaming
    if (action === 'presign') {
      const body = await req.json().catch(() => ({}));
      const { type = 'upload', key, partNumber, uploadId, expiresInSeconds } = body;

      if (!key) {
        return createProblemDetailsResponse(
          400,
          'Missing required "key" in presign payload.',
          instanceUri
        );
      }

      if (type === 'upload') {
        if (!uploadId || typeof partNumber !== 'number') {
          return createProblemDetailsResponse(
            400,
            'Missing required "uploadId" or "partNumber" for presigned upload URL.',
            instanceUri
          );
        }

        const sessionOwner = s3Storage.getUploadOwner(uploadId);
        if (!sessionOwner || sessionOwner !== currentUser.id) {
          return createProblemDetailsResponse(
            404,
            STORAGE_OBJECT_NOT_FOUND,
            instanceUri
          );
        }

        if (s3Storage.generatePresignedUploadUrl) {
          const presigned = s3Storage.generatePresignedUploadUrl(key, partNumber, uploadId, expiresInSeconds);
          return NextResponse.json({ success: true, ...presigned });
        }
      } else if (type === 'download') {
        const ownership = await resolveObjectOwnership(key);
        if (ownership.resolved && ownership.ownerUserId && ownership.ownerUserId !== currentUser.id) {
          return createProblemDetailsResponse(
            404,
            STORAGE_OBJECT_NOT_FOUND,
            instanceUri
          );
        }

        if (s3Storage.generatePresignedDownloadUrl) {
          const presigned = s3Storage.generatePresignedDownloadUrl(key, expiresInSeconds);
          return NextResponse.json({ success: true, ...presigned });
        }
      }

      return createProblemDetailsResponse(
        400,
        'Storage provider does not support presigned URLs or invalid type specified.',
        instanceUri
      );
    }

    return createProblemDetailsResponse(
      400,
      `Unknown multipart action: "${action}"`,
      instanceUri
    );
  } catch (error: any) {
    return createProblemDetailsResponse(
      500,
      error instanceof Error ? error.message : 'Storage operation error',
      instanceUri
    );
  }
}
