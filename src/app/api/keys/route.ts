import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/auth/session';
import { validateApiAccess } from '@/lib/api-keys/guard';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';
import { ALL_API_KEY_SCOPES, ApiKeyScope } from '@/lib/api-keys/types';
import type { User } from '@/lib/auth/types';

export const dynamic = 'force-dynamic';

async function resolveAuthenticatedUser(
  req: NextRequest,
  requireAdminKey = false
): Promise<{ user: User | null; error?: string; status: number }> {
  const sessionUser = await getSessionFromRequest(req);
  if (sessionUser) {
    return { user: sessionUser, status: 200 };
  }

  const auth = await validateApiAccess(req, 0);
  if (!auth.authorized || !auth.user) {
    return {
      user: null,
      error: auth.error ?? 'Unauthorized: Sign in or valid API key required.',
      status: auth.status ?? 401,
    };
  }

  if (requireAdminKey && auth.apiKey) {
    const hasAdminScope = auth.apiKey.scopes?.includes('*');
    if (!hasAdminScope) {
      return {
        user: null,
        error: 'Forbidden: API key lacks admin wildcard (*) scope to manage API keys.',
        status: 403,
      };
    }
  }

  return { user: auth.user, status: 200 };
}

export async function GET(req: NextRequest) {
  const auth = await resolveAuthenticatedUser(req, false);
  if (!auth.user) {
    return NextResponse.json(
      { success: false, error: auth.error },
      { status: auth.status }
    );
  }

  const keys = await redisKeyStore.listApiKeys(auth.user.id);
  return NextResponse.json({
    success: true,
    keys,
  });
}

export async function POST(req: NextRequest) {
  const auth = await resolveAuthenticatedUser(req, true);
  if (!auth.user) {
    return NextResponse.json(
      { success: false, error: auth.error },
      { status: auth.status }
    );
  }

  try {
    const body = await req.json().catch(() => ({}));
    const keyName = (body && typeof body.name === 'string' && body.name.trim()) || 'Production API Key';
    const allowedIps = Array.isArray(body?.allowedIps) ? body.allowedIps : undefined;
    const webhookUrl = typeof body?.webhookUrl === 'string' && body.webhookUrl.trim() ? body.webhookUrl.trim() : undefined;
    const webhookSecret = typeof body?.webhookSecret === 'string' && body.webhookSecret.trim() ? body.webhookSecret.trim() : undefined;

    let expiresAt: number | undefined;
    if (typeof body?.expiresAt === 'number' && Number.isFinite(body.expiresAt)) {
      if (body.expiresAt <= Date.now()) {
        return NextResponse.json(
          { success: false, error: 'expiresAt must be a timestamp in the future.' },
          { status: 400 }
        );
      }
      expiresAt = body.expiresAt;
    }

    let scopes: ApiKeyScope[] | undefined;
    if (Array.isArray(body?.scopes)) {
      const valid = new Set<ApiKeyScope>([...ALL_API_KEY_SCOPES, '*']);
      const filtered = body.scopes.filter((s: unknown): s is ApiKeyScope => typeof s === 'string' && valid.has(s as ApiKeyScope));
      scopes = filtered.length > 0 ? filtered : undefined;
    }

    const result = await redisKeyStore.generateApiKey(auth.user.id, keyName, {
      allowedIps,
      webhookUrl,
      webhookSecret,
      scopes,
      expiresAt,
    });

    return NextResponse.json({
      success: true,
      key: result.key,
      secretKey: result.secretKey,
      warning: 'Please copy your API key now. You will not be able to see it again.',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to generate API key';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
