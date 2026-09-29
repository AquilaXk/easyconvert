import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/auth/session';
import { validateApiAccess, authErrorHeaders } from '@/lib/api-keys/guard';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';
import { ALL_API_KEY_SCOPES, ApiKeyScope } from '@/lib/api-keys/types';
import { toPublicApiKey } from '@/lib/api-keys/public-views';
import type { User } from '@/lib/auth/types';

export const dynamic = 'force-dynamic';

async function resolveAuthenticatedUser(
  req: NextRequest,
  requireAdminKey = false
): Promise<{ user: User | null; error?: string; status: number; headers?: Record<string, string> }> {
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
      headers: authErrorHeaders(auth),
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
  const auth = await resolveAuthenticatedUser(req, true);
  if (!auth.user) {
    return NextResponse.json(
      { success: false, error: auth.error },
      { status: auth.status, headers: auth.headers }
    );
  }

  const keys = await redisKeyStore.listApiKeys(auth.user.id);
  return NextResponse.json({
    success: true,
    keys: keys.map(toPublicApiKey),
  });
}

interface ParsedKeyPayload {
  keyName: string;
  allowedIps?: string[];
  webhookUrl?: string;
  webhookSecret?: string;
  expiresAt?: number;
  scopes?: ApiKeyScope[];
  error?: string;
}

function parseKeyCreationPayload(body: Record<string, unknown> | null | undefined): ParsedKeyPayload {
  const keyName = (typeof body?.name === 'string' && body.name.trim()) || 'Production API Key';
  const allowedIps = Array.isArray(body?.allowedIps) ? body.allowedIps : undefined;
  const webhookUrl = typeof body?.webhookUrl === 'string' && body.webhookUrl.trim() ? body.webhookUrl.trim() : undefined;
  const webhookSecret = typeof body?.webhookSecret === 'string' && body.webhookSecret.trim() ? body.webhookSecret.trim() : undefined;

  let expiresAt: number | undefined;
  if (typeof body?.expiresAt === 'number' && Number.isFinite(body.expiresAt)) {
    if (body.expiresAt <= Date.now()) {
      return { keyName, error: 'expiresAt must be a timestamp in the future.' };
    }
    expiresAt = body.expiresAt;
  }

  let scopes: ApiKeyScope[] | undefined;
  if (Array.isArray(body?.scopes)) {
    const valid = new Set<ApiKeyScope>([...ALL_API_KEY_SCOPES, '*']);
    const filtered = body.scopes.filter((s: unknown): s is ApiKeyScope => typeof s === 'string' && valid.has(s as ApiKeyScope));
    scopes = filtered.length > 0 ? filtered : undefined;
  }

  return { keyName, allowedIps, webhookUrl, webhookSecret, expiresAt, scopes };
}

export async function POST(req: NextRequest) {
  const auth = await resolveAuthenticatedUser(req, true);
  if (!auth.user) {
    return NextResponse.json(
      { success: false, error: auth.error },
      { status: auth.status, headers: auth.headers }
    );
  }

  try {
    const body = await req.json().catch(() => ({}));
    const parsed = parseKeyCreationPayload(body);
    if (parsed.error) {
      return NextResponse.json(
        { success: false, error: parsed.error },
        { status: 400 }
      );
    }

    const result = await redisKeyStore.generateApiKey(auth.user.id, parsed.keyName, {
      allowedIps: parsed.allowedIps,
      webhookUrl: parsed.webhookUrl,
      webhookSecret: parsed.webhookSecret,
      scopes: parsed.scopes,
      expiresAt: parsed.expiresAt,
    });

    return NextResponse.json({
      success: true,
      key: toPublicApiKey(result.key),
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

