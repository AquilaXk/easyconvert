import { NextRequest, NextResponse } from 'next/server';
import { dashboardRefusal as refusal, notFoundRefusal, resolveDashboardCaller } from '@/lib/api/dashboard-refusal';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';
import { toPublicApiKey } from '@/lib/api-keys/public-views';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const MAX_GRACE_PERIOD_SECONDS = 7 * 24 * 3600; // 7 days

export async function POST(req: NextRequest, context: RouteContext) {
  const caller = await resolveDashboardCaller(req, { action: 'rotate API keys', adminKey: true });
  if ('refused' in caller) return caller.refused;
  const { user } = caller;
  const { id: keyId } = await context.params;

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  let gracePeriodSeconds = 3600; // 1 hour default

  if (body.gracePeriodSeconds !== undefined) {
    if (
      typeof body.gracePeriodSeconds !== 'number' ||
      !Number.isFinite(body.gracePeriodSeconds) ||
      body.gracePeriodSeconds < 0 ||
      body.gracePeriodSeconds > MAX_GRACE_PERIOD_SECONDS
    ) {
      return refusal(400, 'invalid_grace_period', `gracePeriodSeconds must be a finite number between 0 and ${MAX_GRACE_PERIOD_SECONDS} seconds (7 days).`);
    }
    gracePeriodSeconds = Math.floor(body.gracePeriodSeconds);
  }

  const result = await redisKeyStore.rotateApiKey(user.id, keyId, { gracePeriodSeconds });
  if (!result) {
    return notFoundRefusal('API key not found, inactive, or not owned by the current user.');
  }

  return NextResponse.json({
    success: true,
    key: toPublicApiKey(result.key),
    secretKey: result.newSecretKey,
    graceExpiresAt: result.graceExpiresAt,
    warning: 'Please copy your new API key now. You will not be able to see it again.',
    message: 'API key successfully rotated. The previous key remains valid until the grace period expires.',
  });
}
