import { NextRequest, NextResponse } from 'next/server';
import { s3Storage } from '@/lib/storage/s3-storage';
import { validateApiAccess, authErrorHeaders } from '@/lib/api-keys/guard';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import { STORAGE_OBJECT_NOT_FOUND, resolveObjectOwnership } from '@/lib/api-keys/owner-access';
import type { UserTier } from '@/lib/auth/types';

export const dynamic = 'force-dynamic';

const MAX_PART_BYTES = 64 * 1024 * 1024; // 64 MiB

const TIER_MAX_MULTIPART_BYTES: Record<UserTier | 'anonymous', number> = {
  anonymous: 50 * 1024 * 1024,
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
  const auth = await validateApiAccess(req, {
    requiredUnits: 0,
    requiredScope: 'convert:write',
  });
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

      if (!filename || typeof totalSize !== 'number' || !Number.isFinite(totalSize)) {
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

      const effectiveTier = currentUser.id.startsWith('anon:') ? 'anonymous' : currentUser.tier;
      const maxAllowedBytes =
        (effectiveTier && TIER_MAX_MULTIPART_BYTES[effectiveTier]) || MAX_MULTIPART_TOTAL_BYTES;

      if (totalSize > maxAllowedBytes) {
        return createProblemDetailsResponse(
          413,
          `Requested total size ${totalSize} bytes exceeds maximum allowed upload size of ${maxAllowedBytes} bytes for tier '${effectiveTier}'.`,
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

      const session = s3Storage.getUploadSession(uploadId);
      if (!session || !session.ownerUserId || session.ownerUserId !== currentUser.id) {
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

      const maxAllowedBytes =
        (currentUser.tier && TIER_MAX_MULTIPART_BYTES[currentUser.tier]) || MAX_MULTIPART_TOTAL_BYTES;

      let currentSessionBytes = 0;
      for (const [pNum, partInfo] of session.parts.entries()) {
        if (pNum !== partNumber) {
          currentSessionBytes += partInfo.size;
        }
      }

      const contentLengthHeader = req.headers.get('content-length');
      if (contentLengthHeader) {
        const declaredLength = parseInt(contentLengthHeader, 10);
        if (declaredLength > MAX_PART_BYTES) {
          return createProblemDetailsResponse(
            413,
            `Part size exceeds maximum allowed part size of ${MAX_PART_BYTES} bytes (64 MiB).`,
            instanceUri
          );
        }
        if (currentSessionBytes + declaredLength > maxAllowedBytes) {
          return createProblemDetailsResponse(
            413,
            `Total upload size exceeds maximum allowed size of ${maxAllowedBytes} bytes for tier '${currentUser.tier}'.`,
            instanceUri
          );
        }
      }

      if (!req.body) {
        return createProblemDetailsResponse(
          400,
          'Chunk payload is empty (0 bytes).',
          instanceUri
        );
      }

      try {
        const partResult = await s3Storage.uploadPartStream(
          uploadId,
          partNumber,
          req.body,
          MAX_PART_BYTES,
          maxAllowedBytes,
          currentSessionBytes
        );
        return NextResponse.json({ success: true, ...partResult });
      } catch (err: any) {
        const statusCode = err?.statusCode || (err?.message?.includes('exceeds') ? 413 : 400);
        return createProblemDetailsResponse(
          statusCode,
          err?.message || 'Error processing multipart chunk',
          instanceUri
        );
      }
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

      const session = s3Storage.getUploadSession(uploadId);
      if (!session || !session.ownerUserId || session.ownerUserId !== currentUser.id) {
        return createProblemDetailsResponse(
          404,
          STORAGE_OBJECT_NOT_FOUND,
          instanceUri
        );
      }

      if (parts !== undefined) {
        if (!Array.isArray(parts) || parts.length === 0) {
          return createProblemDetailsResponse(
            400,
            'Missing or empty "parts" array in complete request.',
            instanceUri
          );
        }
        for (const p of parts) {
          if (!p || typeof p.partNumber !== 'number' || p.partNumber < 1 || p.partNumber > 10000) {
            return createProblemDetailsResponse(
              400,
              `Invalid part number in parts list.`,
              instanceUri
            );
          }
          const sessionPart = session.parts.get(p.partNumber);
          if (!sessionPart) {
            return createProblemDetailsResponse(
              400,
              `Missing part number ${p.partNumber} in multipart upload session.`,
              instanceUri
            );
          }
          if (p.etag && p.etag !== sessionPart.etag) {
            return createProblemDetailsResponse(
              400,
              `ETag mismatch for part number ${p.partNumber}.`,
              instanceUri
            );
          }
        }
      }

      let totalPartBytes = 0;
      const targetParts = parts && Array.isArray(parts)
        ? parts.map((p: any) => session.parts.get(p.partNumber)!)
        : Array.from(session.parts.values());

      for (const partInfo of targetParts) {
        if (partInfo) {
          totalPartBytes += partInfo.size;
        }
      }
      const maxAllowedBytes =
        (currentUser.tier && TIER_MAX_MULTIPART_BYTES[currentUser.tier]) || MAX_MULTIPART_TOTAL_BYTES;
      if (totalPartBytes > maxAllowedBytes) {
        return createProblemDetailsResponse(
          413,
          `Completed upload size ${totalPartBytes} bytes exceeds maximum allowed upload size of ${maxAllowedBytes} bytes for tier '${currentUser.tier}'.`,
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
    console.error('Storage operation error:', error);
    const safeMessage = error instanceof Error && !error.message.includes('/') && !error.message.includes('\\')
      ? error.message
      : 'Storage operation error';
    return createProblemDetailsResponse(
      500,
      safeMessage,
      instanceUri
    );
  }
}
