import { NextRequest, NextResponse } from 'next/server';
import { validateApiAccess, authErrorHeaders } from '@/lib/api-keys/guard';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import { storageErrorResponse } from '@/lib/api/storage-error-response';
import { storageProvider } from '@/lib/storage';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

function internalError(instanceUri: string) {
  return createProblemDetailsResponse(500, 'Storage operation error', instanceUri, 'Internal Server Error');
}

export async function DELETE(req: NextRequest, context: RouteContext) {
  const resolvedParams = await Promise.resolve(context.params);
  const uploadId = resolvedParams?.id;
  const instanceUri = req.nextUrl?.pathname || `/api/v1/uploads/direct/${uploadId || ''}`;

  if (!uploadId) {
    return createProblemDetailsResponse(
      400,
      'Missing upload ID in request path.',
      instanceUri,
      'Bad Request'
    );
  }

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

  if (!storageProvider.getUploadSession) {
    return createProblemDetailsResponse(
      501,
      'The configured storage provider does not support upload sessions.',
      instanceUri,
      'Not Implemented'
    );
  }

  // 2. Session and ownership verification (fail-closed against cross-user enumeration)
  let session;
  try {
    session = await storageProvider.getUploadSession(uploadId);
  } catch (err: unknown) {
    return storageErrorResponse(err, instanceUri) ?? internalError(instanceUri);
  }
  if (!session) {
    return createProblemDetailsResponse(
      404,
      `Upload session "${uploadId}" not found or already aborted.`,
      instanceUri,
      'Not Found'
    );
  }

  // A session without an owner belongs to server-side code, never to a caller.
  if (session.ownerUserId !== auth.user.id) {
    return createProblemDetailsResponse(
      404,
      `Upload session "${uploadId}" not found.`,
      instanceUri,
      'Not Found'
    );
  }

  // 3. Abort multipart session and purge temporary files
  let aborted: boolean;
  try {
    aborted = await storageProvider.abortMultipartUpload(uploadId);
  } catch (err: unknown) {
    return storageErrorResponse(err, instanceUri) ?? internalError(instanceUri);
  }
  if (!aborted) {
    return createProblemDetailsResponse(
      404,
      `Failed to abort upload session "${uploadId}".`,
      instanceUri,
      'Not Found'
    );
  }

  return new NextResponse(null, { status: 204 });
}
