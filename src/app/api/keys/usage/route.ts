import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/auth/session';
import { validateApiAccess, authErrorHeaders } from '@/lib/api-keys/guard';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  let user = await getSessionFromRequest(req);
  if (!user) {
    const auth = await validateApiAccess(req, 0);
    if (!auth.authorized || !auth.user) {
      return NextResponse.json(
        { success: false, error: auth.error ?? 'Unauthorized: Sign in or valid API key required.' },
        { status: auth.status ?? 401, headers: authErrorHeaders(auth) }
      );
    }
    user = auth.user;
  }

  const usage = await redisKeyStore.getQuotaUsage(user.id);
  return NextResponse.json({
    success: true,
    usage,
  });
}
