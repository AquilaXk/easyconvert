import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/auth/session';
import { validateApiAccess, authErrorHeaders } from '@/lib/api-keys/guard';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }> | { id: string };
}

export async function DELETE(req: NextRequest, context: RouteContext) {
  let user = await getSessionFromRequest(req);
  if (!user) {
    const auth = await validateApiAccess(req, 0);
    if (!auth.authorized || !auth.user) {
      return NextResponse.json(
        { success: false, error: auth.error ?? 'Unauthorized: Sign in or valid API key required.' },
        { status: auth.status ?? 401, headers: authErrorHeaders(auth) }
      );
    }
    if (auth.apiKey && !auth.apiKey.scopes?.includes('*')) {
      return NextResponse.json(
        { success: false, error: 'Forbidden: API key lacks admin wildcard (*) scope to revoke API keys.' },
        { status: 403 }
      );
    }
    user = auth.user;
  }

  const resolvedParams = await Promise.resolve(context.params);
  const keyId = resolvedParams.id;
  if (!keyId) {
    return NextResponse.json(
      { success: false, error: 'Key ID parameter missing.' },
      { status: 400 }
    );
  }

  const revoked = await redisKeyStore.revokeApiKey(user.id, keyId);
  if (!revoked) {
    return NextResponse.json(
      { success: false, error: 'API key not found or not owned by the current user.' },
      { status: 404 }
    );
  }

  return NextResponse.json({
    success: true,
    message: 'API key successfully revoked.',
  });
}
