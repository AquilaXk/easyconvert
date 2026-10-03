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

  let allowedIps: string[] | undefined;
  if (body?.allowedIps !== undefined) {
    if (!Array.isArray(body.allowedIps)) {
      return { keyName, error: 'allowedIps must be an array of IP addresses or CIDR blocks.' };
    }
    for (const ip of body.allowedIps) {
      if (typeof ip !== 'string' || !ip.trim()) {
        return { keyName, error: 'Every item in allowedIps must be a non-empty string.' };
      }
    }
    allowedIps = body.allowedIps.map((ip) => ip.trim());
  }

  const webhookUrl = typeof body?.webhookUrl === 'string' && body.webhookUrl.trim() ? body.webhookUrl.trim() : undefined;
  const webhookSecret = typeof body?.webhookSecret === 'string' && body.webhookSecret.trim() ? body.webhookSecret.trim() : undefined;

  if (webhookUrl && !webhookSecret) {
    return { keyName, error: 'webhookSecret is required when webhookUrl is provided.' };
  }

  let expiresAt: number | undefined;
  if (typeof body?.expiresAt === 'number' && Number.isFinite(body.expiresAt)) {
    if (body.expiresAt <= Date.now()) {
      return { keyName, error: 'expiresAt must be a timestamp in the future.' };
    }
    expiresAt = body.expiresAt;
  }

  let scopes: ApiKeyScope[];
  if (body?.scopes !== undefined) {
    if (!Array.isArray(body.scopes) || body.scopes.length === 0) {
      return { keyName, error: 'scopes must be a non-empty array of valid scopes or omitted.' };
    }
    const valid = new Set<ApiKeyScope>([...ALL_API_KEY_SCOPES, '*']);
    for (const s of body.scopes) {
      if (typeof s !== 'string' || !valid.has(s as ApiKeyScope)) {
        return {
          keyName,
          error: `Invalid scope '${String(s)}'. Valid scopes are: ${[...ALL_API_KEY_SCOPES, '*'].join(', ')}.`,
        };
      }
    }
    scopes = [...new Set(body.scopes as ApiKeyScope[])];
  } else {
    // Default to least privilege
    scopes = ['convert:read'];
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

