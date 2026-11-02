import { NextRequest, NextResponse } from 'next/server';
import { accessRefusal } from '@/lib/api/dashboard-refusal';
import { getSessionFromRequest } from '@/lib/auth/session';
import { validateApiAccess } from '@/lib/api-keys/guard';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  let user = await getSessionFromRequest(req);
  if (!user) {
    const auth = await validateApiAccess(req, 0);
    if (!auth.authorized || !auth.user) {
      return accessRefusal(auth, 'Unauthorized: Sign in or valid API key required.');
    }
    user = auth.user;
  }

  const usage = await redisKeyStore.getQuotaUsage(user.id);
  return NextResponse.json({
    success: true,
    usage,
  });
}
