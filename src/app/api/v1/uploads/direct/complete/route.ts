import { NextRequest, NextResponse } from 'next/server';
import { validateApiAccess, authErrorHeaders } from '@/lib/api-keys/guard';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import { storageErrorResponse } from '@/lib/api/storage-error-response';
import { storageProvider } from '@/lib/storage';
import { readObjectHeader } from '@/lib/storage/object-header';
import { assertNotSpoofedFile } from '@/lib/registry';
import { UNKNOWN_FORMAT_PROBLEM_TYPE, UnknownDeclaredFormatError, resolveDeclaredFormat } from '@/lib/storage/declared-format';

export const dynamic = 'force-dynamic';

interface DirectUploadCompleteBody {
  uploadId?: string;
  parts?: Array<{ partNumber: number; etag: string }>;
}

function internalError(instanceUri: string) {
  return createProblemDetailsResponse(500, 'Storage operation error', instanceUri, 'Internal Server Error');
}

/** Deletes a rejected assembled object; a response is returned only when the store fails the delete. */
async function purgeAssembled(key: string, instanceUri: string) {
  try {
    await storageProvider.deleteObject(key);
    return undefined;
  } catch (err: unknown) {
    return storageErrorResponse(err, instanceUri) ?? internalError(instanceUri);
  }
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

  if (!storageProvider.getUploadSession) {
    return createProblemDetailsResponse(
      501,
      'The configured storage provider does not support upload sessions.',
      instanceUri,
      'Not Implemented'
    );
  }

  // 3. Session & Ownership validation (fail-closed against cross-user discovery)
  let session;
  try {
    session = await storageProvider.getUploadSession(uploadId);
  } catch (err: unknown) {
    return storageErrorResponse(err, instanceUri) ?? internalError(instanceUri);
  }
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
  let completedObject: Awaited<ReturnType<typeof storageProvider.completeMultipartUpload>>;
  try {
    completedObject = await storageProvider.completeMultipartUpload(uploadId, parts);
  } catch (err: any) {
    return (
      storageErrorResponse(err, instanceUri) ??
      createProblemDetailsResponse(400, err?.message || 'Failed to complete multipart assembly.', instanceUri, 'Bad Request')
    );
  }

  // Parts of an object-store upload go straight to the store, past this application's size
  // limits, so the assembled object must be exactly the size that was declared.
  if (storageProvider.kind === 'remote' && completedObject.size !== session.totalSize) {
    const purged = await purgeAssembled(completedObject.key, instanceUri);
    if (purged) return purged;
    return createProblemDetailsResponse(
      400,
      `Uploaded size ${completedObject.size} bytes does not match the declared totalSize ${session.totalSize} bytes.`,
      instanceUri,
      'Bad Request'
    );
  }

  // 5. Verify magic bytes on the assembled object (first 64 KiB)
  let header: Buffer | null;
  try {
    header = await readObjectHeader(storageProvider, completedObject.key);
  } catch (err: unknown) {
    return storageErrorResponse(err, instanceUri) ?? internalError(instanceUri);
  }
  if (!header) {
    const purged = await purgeAssembled(completedObject.key, instanceUri);
    if (purged) return purged;
    return createProblemDetailsResponse(
      500,
      'Assembled file not found in storage. Operation failed closed.',
      instanceUri,
      'Internal Server Error'
    );
  }

  try {
    const declaredFormat = resolveDeclaredFormat(sessionFilename, sessionMimeType);
    assertNotSpoofedFile(header, declaredFormat, sessionFilename);
  } catch (err: unknown) {
    // Purge the assembled object immediately: it matches no declared format
    const purged = await purgeAssembled(completedObject.key, instanceUri);
    if (purged) return purged;

    if (err instanceof UnknownDeclaredFormatError) {
      return createProblemDetailsResponse(
        400,
        err.message,
        instanceUri,
        'Unknown Format',
        UNKNOWN_FORMAT_PROBLEM_TYPE
      );
    }

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
