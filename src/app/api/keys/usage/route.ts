import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/auth/session';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await getSessionFromRequest(req);
  if (!user) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized: Sign in required.' },
      { status: 401 }
    );
  }

  const usage = await redisKeyStore.getQuotaUsage(user.id);
  return NextResponse.json({
    success: true,
    usage,
  });
}
