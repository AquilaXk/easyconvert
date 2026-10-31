import { NextRequest, NextResponse } from 'next/server';
import type { User } from '@/lib/auth/types';
import { admittingNewFiles } from '@/lib/api/storage-full-response';
import { mayPresignDownload } from '@/lib/storage/retention-service';
import { MULTIPART_MAX_PARTS, storageProvider } from '@/lib/storage';
import type { IStorageBackend } from '@/lib/storage/oci-storage';
import { validateApiAccess, authErrorHeaders } from '@/lib/api-keys/guard';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import { storageErrorResponse } from '@/lib/api/storage-error-response';
import { STORAGE_OBJECT_NOT_FOUND, resolveObjectOwnership } from '@/lib/api-keys/owner-access';
import { callerMaxFileBytes, fileSizeLimitProblem } from '@/lib/api/file-size-limit';
import { UPLOAD_PART_MAX_BYTES } from '@/lib/plan-limits';
import { DOWNLOAD_PRESIGN_MAX_SECONDS, PART_URL_TTL_SECONDS } from '@/lib/storage/presign-limits';
import { PRESIGN_MAX_EXPIRES_SECONDS, PRESIGN_MIN_EXPIRES_SECONDS, SigV4SigningError, assertValidObjectKey } from '@/lib/storage/s3-sigv4';

export const dynamic = 'force-dynamic';

const MAX_PART_BYTES = UPLOAD_PART_MAX_BYTES;
/** The smallest part an object store takes for a part that is not the last (the S3 rule). */
const MIN_PART_BYTES = 5 * 1024 * 1024;

const PRESIGN_UNSUPPORTED = 'Storage provider does not support presigned URLs or invalid type specified.';
const RETAINED_DOWNLOAD_PRESIGN_REFUSED =
  'A conversion result has no signed download link. Download it from /api/storage/file/<key>.';

/** The session operations the multipart actions need; every shipped backend provides them. */
type MultipartCapableStorage = IStorageBackend &
  Required<Pick<IStorageBackend, 'getUploadSession' | 'getUploadOwner' | 'uploadPartStream' | 'getUploadedParts'>>;

function supportsMultipartSessions(storage: IStorageBackend): storage is MultipartCapableStorage {
  return Boolean(
    storage.getUploadSession && storage.getUploadOwner && storage.uploadPartStream && storage.getUploadedParts
  );
}

/** The reason a presign request's key or expiry cannot be used, or undefined when both are acceptable. */
function presignInputProblem(key: unknown, expiresInSeconds: unknown): string | undefined {
  if (typeof key !== 'string' || key.length === 0) {
    return 'Missing required "key" in presign payload.';
  }
  try {
    assertValidObjectKey(key);
  } catch (err: unknown) {
    if (err instanceof SigV4SigningError) return 'The "key" in the presign payload is not a valid object key.';
    throw err;
  }
  if (
    expiresInSeconds !== undefined &&
    (typeof expiresInSeconds !== 'number' ||
      !Number.isInteger(expiresInSeconds) ||
      expiresInSeconds < PRESIGN_MIN_EXPIRES_SECONDS ||
      expiresInSeconds > PRESIGN_MAX_EXPIRES_SECONDS)
  ) {
    return `"expiresInSeconds" must be an integer between ${PRESIGN_MIN_EXPIRES_SECONDS} and ${PRESIGN_MAX_EXPIRES_SECONDS}.`;
  }
  return undefined;
}

interface PresignUploadPartRequest {
  key: string;
  partNumber: unknown;
  uploadId: unknown;
  expiresInSeconds?: number;
}

/** A part upload URL for the caller's own session, signed only for that session's key. */
async function presignUploadPart(
  storage: MultipartCapableStorage,
  { key, partNumber, uploadId, expiresInSeconds }: PresignUploadPartRequest,
  userId: string,
  instanceUri: string
): Promise<Response> {
  if (typeof uploadId !== 'string' || !uploadId || typeof partNumber !== 'number') {
    return createProblemDetailsResponse(
      400,
      'Missing required "uploadId" or "partNumber" for presigned upload URL.',
      instanceUri
    );
  }
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MULTIPART_MAX_PARTS) {
    return createProblemDetailsResponse(
      400,
      `Invalid "partNumber". Must be an integer between 1 and ${MULTIPART_MAX_PARTS}.`,
      instanceUri
    );
  }
  const session = await storage.getUploadSession(uploadId);
  if (!session?.ownerUserId || session.ownerUserId !== userId) {
    return createProblemDetailsResponse(404, STORAGE_OBJECT_NOT_FOUND, instanceUri);
  }
  if (key !== session.key) {
    return createProblemDetailsResponse(400, 'Key does not belong to this multipart upload session.', instanceUri);
  }
  if (!storage.generatePresignedUploadUrl) {
    return createProblemDetailsResponse(400, PRESIGN_UNSUPPORTED, instanceUri);
  }
  const presigned = await storage.generatePresignedUploadUrl(
    key,
    partNumber,
    uploadId,
    Math.min(expiresInSeconds ?? PART_URL_TTL_SECONDS, PART_URL_TTL_SECONDS)
  );
  return NextResponse.json({ success: true, ...presigned });
}

/**
 * A download URL for an object the caller provably owns. A signed URL needs no further authentication, so an
 * unresolved owner (job record unreadable), an ownerless key and another user's key are all answered like a missing
 * object. A result the retention rule tracks gets none: the bucket would answer the client, so the delivery could
 * not be recorded and the result would not be deleted after it (docs/policy-decisions.md, entry 125).
 */
async function presignDownload(
  storage: MultipartCapableStorage,
  key: string,
  expiresInSeconds: number | undefined,
  userId: string,
  instanceUri: string
): Promise<Response> {
  const ownership = await resolveObjectOwnership(key);
  if (!ownership.resolved || ownership.ownerUserId !== userId) {
    return createProblemDetailsResponse(404, STORAGE_OBJECT_NOT_FOUND, instanceUri);
  }
  if (!(await mayPresignDownload(key))) {
    return createProblemDetailsResponse(400, RETAINED_DOWNLOAD_PRESIGN_REFUSED, instanceUri);
  }
  if (!storage.generatePresignedDownloadUrl) {
    return createProblemDetailsResponse(400, PRESIGN_UNSUPPORTED, instanceUri);
  }
  const presigned = await storage.generatePresignedDownloadUrl(
    key,
    Math.min(expiresInSeconds ?? DOWNLOAD_PRESIGN_MAX_SECONDS, DOWNLOAD_PRESIGN_MAX_SECONDS)
  );
  return NextResponse.json({ success: true, ...presigned });
}

/** The reason a requested part size cannot be used, or undefined when it is absent or in range. */
function partSizeProblemOf(partSize: unknown): string | undefined {
  if (partSize === undefined) return undefined;
  if (typeof partSize !== 'number' || !Number.isInteger(partSize) || partSize < MIN_PART_BYTES || partSize > MAX_PART_BYTES) {
    return `"partSize" must be an integer from ${MIN_PART_BYTES} to ${MAX_PART_BYTES} bytes.`;
  }
  return undefined;
}

/** Opens an upload session for the caller: the declared size is held to the plan limit and the part size to the bounds of a part. */
async function initiateUpload(
  req: NextRequest,
  storage: MultipartCapableStorage,
  currentUser: User,
  instanceUri: string
): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const { filename, mimeType, totalSize, partSize } = body;

  if (!filename || typeof totalSize !== 'number' || !Number.isFinite(totalSize)) {
    return createProblemDetailsResponse(400, 'Missing "filename" or "totalSize" in initiation payload.', instanceUri);
  }

  if (totalSize < 0) {
    return createProblemDetailsResponse(400, 'totalSize cannot be negative.', instanceUri);
  }

  const tooLarge = fileSizeLimitProblem(currentUser, totalSize, instanceUri);
  if (tooLarge) return tooLarge;

  const partSizeProblem = partSizeProblemOf(partSize);
  if (partSizeProblem) {
    return createProblemDetailsResponse(400, partSizeProblem, instanceUri);
  }

  const initResult = await storage.initiateMultipartUpload(
    filename,
    mimeType || 'application/octet-stream',
    totalSize,
    currentUser.id,
    partSize
  );
  return NextResponse.json({ success: true, ...initResult });
}

function sameEtag(a: string, b: string): boolean {
  return a.replace(/"/g, '') === b.replace(/"/g, '');
}

/** Only starting an upload takes new disk space; parts, completion and abort of a running one go on. */
function isNewMultipartUpload(req: NextRequest): boolean {
  return (req.nextUrl?.searchParams.get('action') || 'initiate') === 'initiate';
}

export const POST = admittingNewFiles(async function POST(req: NextRequest) {
  const instanceUri = req.nextUrl?.pathname || '/api/storage/multipart';
  const { searchParams } = new URL(req.url);
  const action = searchParams.get('action') || 'initiate';

  // 1. Guard check: Authenticate and enforce 'convert:write' scope on all multipart actions. An anonymous visitor may
  // upload in parts like a signed-in one: the burst limit of the address applies to every request, and a session is
  // reachable only by the caller that opened it (the same address bucket for an anonymous one).
  const auth = await validateApiAccess(req, {
    requiredUnits: 0,
    requiredScope: 'convert:write',
    allowAnonymous: true,
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

  if (!supportsMultipartSessions(storageProvider)) {
    return createProblemDetailsResponse(
      501,
      'The configured storage provider does not support multipart upload sessions.',
      instanceUri
    );
  }
  const storage: MultipartCapableStorage = storageProvider;

  try {
    // 1. Initiate Multipart Upload
    if (action === 'initiate') {
      return await initiateUpload(req, storage, currentUser, instanceUri);
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

      const session = await storage.getUploadSession(uploadId);
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

      const maxAllowedBytes = callerMaxFileBytes(currentUser);

      let currentSessionBytes = 0;
      for (const partInfo of (await storage.getUploadedParts(uploadId)) ?? []) {
        if (partInfo.partNumber !== partNumber) {
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
        const tooLarge = fileSizeLimitProblem(currentUser, currentSessionBytes + declaredLength, instanceUri);
        if (tooLarge) return tooLarge;
      }

      if (!req.body) {
        return createProblemDetailsResponse(
          400,
          'Chunk payload is empty (0 bytes).',
          instanceUri
        );
      }

      try {
        const partResult = await storage.uploadPartStream(
          uploadId,
          partNumber,
          req.body,
          MAX_PART_BYTES,
          maxAllowedBytes,
          currentSessionBytes
        );
        return NextResponse.json({ success: true, ...partResult });
      } catch (err: any) {
        const storageProblem = storageErrorResponse(err, instanceUri);
        if (storageProblem) return storageProblem;
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

      const session = await storage.getUploadSession(uploadId);
      if (!session || !session.ownerUserId || session.ownerUserId !== currentUser.id) {
        return createProblemDetailsResponse(
          404,
          STORAGE_OBJECT_NOT_FOUND,
          instanceUri
        );
      }

      const uploadedParts = new Map(
        ((await storage.getUploadedParts(uploadId)) ?? []).map((part) => [part.partNumber, part] as const)
      );

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
          const sessionPart = uploadedParts.get(p.partNumber);
          if (!sessionPart) {
            return createProblemDetailsResponse(
              400,
              `Missing part number ${p.partNumber} in multipart upload session.`,
              instanceUri
            );
          }
          if (p.etag && !sameEtag(p.etag, sessionPart.etag)) {
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
        ? parts.map((p: any) => uploadedParts.get(p.partNumber)!)
        : Array.from(uploadedParts.values());

      for (const partInfo of targetParts) {
        if (partInfo) {
          totalPartBytes += partInfo.size;
        }
      }
      const tooLarge = fileSizeLimitProblem(currentUser, totalPartBytes, instanceUri);
      if (tooLarge) return tooLarge;

      const completeResult = await storage.completeMultipartUpload(uploadId, parts);
      // Parts can be added to an open session between the listing above and the completion, so
      // the size that was actually assembled is checked again, and an object over the cap is removed.
      const assembledTooLarge = fileSizeLimitProblem(currentUser, completeResult.size, instanceUri);
      if (assembledTooLarge) {
        await storage.deleteObject(completeResult.key);
        return assembledTooLarge;
      }
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

      const sessionOwner = await storage.getUploadOwner(uploadId);
      if (!sessionOwner || sessionOwner !== currentUser.id) {
        return createProblemDetailsResponse(
          404,
          STORAGE_OBJECT_NOT_FOUND,
          instanceUri
        );
      }

      const aborted = await storage.abortMultipartUpload(uploadId);
      return NextResponse.json({ success: aborted });
    }

    // 5. Generate Presigned URL for Direct Chunk Streaming
    if (action === 'presign') {
      const body = await req.json().catch(() => ({}));
      const { type = 'upload', key, partNumber, uploadId, expiresInSeconds } = body;

      const inputProblem = presignInputProblem(key, expiresInSeconds);
      if (inputProblem) {
        return createProblemDetailsResponse(400, inputProblem, instanceUri);
      }

      if (type === 'upload') {
        return await presignUploadPart(storage, { key, partNumber, uploadId, expiresInSeconds }, currentUser.id, instanceUri);
      } else if (type === 'download') {
        return await presignDownload(storage, key, expiresInSeconds, currentUser.id, instanceUri);
      }

      return createProblemDetailsResponse(400, PRESIGN_UNSUPPORTED, instanceUri);
    }

    return createProblemDetailsResponse(
      400,
      `Unknown multipart action: "${action}"`,
      instanceUri
    );
  } catch (error: any) {
    const storageProblem = storageErrorResponse(error, instanceUri);
    if (storageProblem) return storageProblem;
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
}, isNewMultipartUpload);
