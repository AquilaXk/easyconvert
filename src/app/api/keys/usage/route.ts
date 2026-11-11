import { NextRequest, NextResponse } from 'next/server';
import { resolveDashboardCaller } from '@/lib/api/dashboard-refusal';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';
import { authStoreUnavailableRefusal } from '@/lib/api/problem-details';
import { AuthStoreUnavailableError } from '@/lib/auth/store-unavailable';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const caller = await resolveDashboardCaller(req, { action: 'read the usage' });
  if ('refused' in caller) return caller.refused;

  let usage;
  try {
    usage = await redisKeyStore.getQuotaUsage(caller.user.id);
  } catch (error) {
    if (error instanceof AuthStoreUnavailableError) return authStoreUnavailableRefusal(error);
    throw error;
  }
  return NextResponse.json({
    success: true,
    usage,
  });
}
