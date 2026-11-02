import { NextRequest, NextResponse } from 'next/server';
import { accessRefusal } from '@/lib/api/dashboard-refusal';
import { codedRefusal } from '@/lib/api/problem-details';
import type { DashboardRefusalCode } from '@/lib/refusal-codes';
import { getSessionFromRequest } from '@/lib/auth/session';
import { validateApiAccess } from '@/lib/api-keys/guard';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';
import { toPublicApiKey } from '@/lib/api-keys/public-views';

export const dynamic = 'force-dynamic';

const refusal = codedRefusal<DashboardRefusalCode>;

interface RouteContext {
  params: Promise<{ id: string }>;
}

const MAX_GRACE_PERIOD_SECONDS = 7 * 24 * 3600; // 7 days

export async function POST(req: NextRequest, context: RouteContext) {
  let user = await getSessionFromRequest(req);
  if (!user) {
    const auth = await validateApiAccess(req, 0);
    if (!auth.authorized || !auth.user) {
      return accessRefusal(auth, 'Unauthorized: Sign in or valid API key required.');
    }
    if (auth.apiKey && !auth.apiKey.scopes?.includes('*')) {
      return refusal(403, 'admin_scope_required', 'Forbidden: API key lacks admin wildcard (*) scope to rotate API keys.');
    }
    user = auth.user;
  }

  const resolvedParams = await Promise.resolve(context.params);
  const keyId = resolvedParams.id;
  if (!keyId) {
    return refusal(400, 'id_required', 'Key ID parameter missing.');
  }

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
    return refusal(404, 'not_found', 'API key not found, inactive, or not owned by the current user.');
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
