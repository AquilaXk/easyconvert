import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { validateApiAccess, authErrorHeaders } from '@/lib/api-keys/guard';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import { s3Storage } from '@/lib/storage/s3-storage';
import { assertNotSpoofedFilePath } from '@/lib/security/file-guard';
import { FileExtensionSpoofError, FORMAT_REGISTRY } from '@/lib/registry';

export const dynamic = 'force-dynamic';

interface DirectUploadCompleteBody {
  uploadId?: string;
  parts?: Array<{ partNumber: number; etag: string }>;
}

export async function POST(req: NextRequest) {
  const instanceUri = req.nextUrl?.pathname || '/api/v1/uploads/direct/complete';

  // 1. Guard check: Authenticate and require 'convert:write' scope
  const auth = await validateApiAccess(req, { requiredUnits: 0, requiredScope: 'convert:write' });
  if (!auth.authorized || !auth.user) {
    return createProblemDetailsResponse(
      auth.status ?? 401,
      auth.error ?? 'Unauthorized',
      instanceUri,
      undefined,
      auth.problemType,
      authErrorHeaders(auth)
    );
  }

  // 2. Parse payload
  const body: DirectUploadCompleteBody = await req.json().catch(() => ({}));
  const { uploadId, parts } = body;

  if (!uploadId || typeof uploadId !== 'string' || uploadId.trim().length === 0) {
    return createProblemDetailsResponse(
      400,
      'Missing or invalid "uploadId" in complete payload.',
      instanceUri,
      'Bad Request'
    );
  }

  if (!Array.isArray(parts) || parts.length === 0) {
    return createProblemDetailsResponse(
      400,
      'Missing or invalid "parts" array in complete payload.',
      instanceUri,
      'Bad Request'
    );
  }

  // 3. Session & Ownership validation (fail-closed against cross-user discovery)
  const session = s3Storage.getUploadSession(uploadId);
  if (!session) {
    return createProblemDetailsResponse(
      404,
      `Upload session "${uploadId}" not found or has expired.`,
      instanceUri,
      'Not Found'
    );
  }

  if (session.ownerUserId && session.ownerUserId !== auth.user.id) {
    return createProblemDetailsResponse(
      404,
      `Upload session "${uploadId}" not found.`,
      instanceUri,
      'Not Found'
    );
  }

  const sessionFilename = session.filename;
  const sessionMimeType = session.mimeType;

  // 4. Assemble multipart stream
  let completedObject: ReturnType<typeof s3Storage.completeMultipartUpload>;
  try {
    completedObject = s3Storage.completeMultipartUpload(uploadId, parts);
  } catch (err: any) {
    return createProblemDetailsResponse(
      400,
      err?.message || 'Failed to complete multipart assembly.',
      instanceUri,
      'Bad Request'
    );
  }

  // 5. Verify magic bytes on assembled file using assertNotSpoofedFilePath on first 64 KiB
  const stored = s3Storage.getObject(completedObject.key);
  if (!stored?.filePath) {
    s3Storage.deleteObject(completedObject.key);
    return createProblemDetailsResponse(
      500,
      'Assembled file not found in storage. Operation failed closed.',
      instanceUri,
      'Internal Server Error'
    );
  }

  try {
    const ext = sessionFilename
      ? path.extname(sessionFilename).replace(/^\./, '').toLowerCase().trim()
      : '';
    let declaredFormat = ext;
    if (!declaredFormat && sessionMimeType && sessionMimeType !== 'application/octet-stream') {
      const found = Object.values(FORMAT_REGISTRY).find((f) => f.mimeType === sessionMimeType);
      if (found) {
        declaredFormat = found.extension;
      } else {
        const subtype = sessionMimeType.split('/').pop()?.toLowerCase().trim();
        declaredFormat = subtype || 'bin';
      }
    }
    if (!declaredFormat) {
      declaredFormat = 'bin';
    }

    assertNotSpoofedFilePath(stored.filePath, declaredFormat, sessionFilename);
  } catch (err: unknown) {
    // Purge spoofed file immediately
    s3Storage.deleteObject(completedObject.key);

    const errorMessage = err instanceof Error ? err.message : 'File content magic bytes mismatch.';
    return createProblemDetailsResponse(
      422,
      errorMessage,
      instanceUri,
      'Unprocessable Entity'
    );
  }

  return NextResponse.json(
    {
      location: completedObject.location,
      key: completedObject.key,
      size: completedObject.size,
      etag: completedObject.etag,
      storageKey: completedObject.key,
    },
    { status: 200 }
  );
}
