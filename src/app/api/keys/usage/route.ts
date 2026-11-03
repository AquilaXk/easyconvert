import { NextRequest, NextResponse } from 'next/server';
import { resolveDashboardCaller } from '@/lib/api/dashboard-refusal';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const caller = await resolveDashboardCaller(req, { action: 'read the usage' });
  if ('refused' in caller) return caller.refused;

  const usage = await redisKeyStore.getQuotaUsage(caller.user.id);
  return NextResponse.json({
    success: true,
    usage,
  });
}
