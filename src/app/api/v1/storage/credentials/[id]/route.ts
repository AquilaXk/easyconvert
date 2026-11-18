import { NextRequest, NextResponse } from 'next/server';
import { validateApiAccess, authErrorHeaders } from '@/lib/api-keys/guard';
import { credentialsVault, CredentialsVaultPersistenceError } from '@/lib/storage';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import { withRateLimitHeaders } from '@/lib/api/rate-limit';

export const dynamic = 'force-dynamic';

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const instanceUri = req.nextUrl?.pathname || `/api/v1/storage/credentials/${id}`;

  const auth = await validateApiAccess(req, { requiredUnits: 0, requiredScope: 'convert:write' });
  if (!auth.authorized || !auth.user) {
    return withRateLimitHeaders(
      createProblemDetailsResponse(
        auth.status ?? 401,
        auth.error ?? 'Unauthorized',
        instanceUri,
        undefined,
        auth.problemType,
        authErrorHeaders(auth)
      ),
      auth.rateLimit
    );
  }

  return withRateLimitHeaders(await deleteCredentialAuthorized(id, instanceUri, auth.user.id), auth.rateLimit);
}

async function deleteCredentialAuthorized(id: string, instanceUri: string, userId: string): Promise<NextResponse> {
  if (!id?.startsWith('cred_')) {
    return createProblemDetailsResponse(400, 'Invalid credential reference identifier.', instanceUri);
  }

  let deleted: boolean;
  try {
    deleted = await credentialsVault.delete(id, userId);
  } catch (err: unknown) {
    if (err instanceof CredentialsVaultPersistenceError) {
      return createProblemDetailsResponse(503, err.message, instanceUri);
    }
    throw err;
  }
  if (!deleted) {
    return createProblemDetailsResponse(404, `Credential "${id}" not found or unauthorized.`, instanceUri);
  }

  return new NextResponse(null, { status: 204 });
}
