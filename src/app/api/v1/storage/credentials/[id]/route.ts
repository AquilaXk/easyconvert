import { NextRequest, NextResponse } from 'next/server';
import { validateApiAccess, authErrorHeaders } from '@/lib/api-keys/guard';
import { credentialsVault } from '@/lib/storage';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';

export const dynamic = 'force-dynamic';

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const instanceUri = req.nextUrl?.pathname || `/api/v1/storage/credentials/${id}`;

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

  if (!id?.startsWith('cred_')) {
    return createProblemDetailsResponse(400, 'Invalid credential reference identifier.', instanceUri);
  }

  const deleted = await credentialsVault.delete(id, auth.user.id);
  if (!deleted) {
    return createProblemDetailsResponse(404, `Credential "${id}" not found or unauthorized.`, instanceUri);
  }

  return new NextResponse(null, { status: 204 });
}
