import { NextRequest, NextResponse } from 'next/server';
import { validateApiAccess, authErrorHeaders } from '@/lib/api-keys/guard';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import { s3Storage } from '@/lib/storage/s3-storage';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
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

  // 2. Session and ownership verification (fail-closed against cross-user enumeration)
  const session = s3Storage.getUploadSession(uploadId);
  if (!session) {
    return createProblemDetailsResponse(
      404,
      `Upload session "${uploadId}" not found or already aborted.`,
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

  // 3. Abort multipart session and purge temporary files
  const aborted = s3Storage.abortMultipartUpload(uploadId);
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
