import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/auth/session';
import { validateApiAccess, authErrorHeaders } from '@/lib/api-keys/guard';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';
import { toPublicApiKey } from '@/lib/api-keys/public-views';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }> | { id: string };
}

const MAX_GRACE_PERIOD_SECONDS = 7 * 24 * 3600; // 7 days

export async function POST(req: NextRequest, context: RouteContext) {
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
        { success: false, error: 'Forbidden: API key lacks admin wildcard (*) scope to rotate API keys.' },
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

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  let gracePeriodSeconds = 3600; // 1 hour default

  if (body.gracePeriodSeconds !== undefined) {
    if (
      typeof body.gracePeriodSeconds !== 'number' ||
      !Number.isFinite(body.gracePeriodSeconds) ||
      body.gracePeriodSeconds < 0 ||
      body.gracePeriodSeconds > MAX_GRACE_PERIOD_SECONDS
    ) {
      return NextResponse.json(
        {
          success: false,
          error: `gracePeriodSeconds must be a finite number between 0 and ${MAX_GRACE_PERIOD_SECONDS} seconds (7 days).`,
        },
        { status: 400 }
      );
    }
    gracePeriodSeconds = Math.floor(body.gracePeriodSeconds);
  }

  const result = await redisKeyStore.rotateApiKey(user.id, keyId, { gracePeriodSeconds });
  if (!result) {
    return NextResponse.json(
      { success: false, error: 'API key not found, inactive, or not owned by the current user.' },
      { status: 404 }
    );
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
