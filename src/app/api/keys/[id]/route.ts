import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/auth/session';
import { validateApiAccess, authErrorHeaders } from '@/lib/api-keys/guard';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';
import { ALL_API_KEY_SCOPES, ApiKeyScope, ApiKeyUpdateOptions } from '@/lib/api-keys/types';
import { toPublicApiKey } from '@/lib/api-keys/public-views';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function DELETE(req: NextRequest, context: RouteContext) {
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
        { success: false, error: 'Forbidden: API key lacks admin wildcard (*) scope to revoke API keys.' },
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

  const revoked = await redisKeyStore.revokeApiKey(user.id, keyId);
  if (!revoked) {
    return NextResponse.json(
      { success: false, error: 'API key not found or not owned by the current user.' },
      { status: 404 }
    );
  }

  return NextResponse.json({
    success: true,
    message: 'API key successfully revoked.',
  });
}

export async function PATCH(req: NextRequest, context: RouteContext) {
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
        { success: false, error: 'Forbidden: API key lacks admin wildcard (*) scope to update API keys.' },
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
  const updates: ApiKeyUpdateOptions = {};

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return NextResponse.json(
        { success: false, error: 'name must be a non-empty string.' },
        { status: 400 }
      );
    }
    updates.name = body.name.trim();
  }

  if (body.allowedIps !== undefined) {
    if (!Array.isArray(body.allowedIps)) {
      return NextResponse.json(
        { success: false, error: 'allowedIps must be an array of strings.' },
        { status: 400 }
      );
    }
    for (const ip of body.allowedIps) {
      if (typeof ip !== 'string' || !ip.trim()) {
        return NextResponse.json(
          { success: false, error: 'Every item in allowedIps must be a non-empty string.' },
          { status: 400 }
        );
      }
    }
    updates.allowedIps = body.allowedIps.map((ip) => ip.trim());
  }

  if (body.webhookUrl !== undefined) {
    updates.webhookUrl = typeof body.webhookUrl === 'string' ? body.webhookUrl.trim() : undefined;
  }

  if (body.webhookSecret !== undefined) {
    updates.webhookSecret = typeof body.webhookSecret === 'string' ? body.webhookSecret.trim() : undefined;
  }

  if (body.scopes !== undefined) {
    if (!Array.isArray(body.scopes) || body.scopes.length === 0) {
      return NextResponse.json(
        { success: false, error: 'scopes must be a non-empty array of valid scopes.' },
        { status: 400 }
      );
    }
    const valid = new Set<ApiKeyScope>([...ALL_API_KEY_SCOPES, '*']);
    for (const s of body.scopes) {
      if (typeof s !== 'string' || !valid.has(s as ApiKeyScope)) {
        return NextResponse.json(
          {
            success: false,
            error: `Invalid scope '${String(s)}'. Valid scopes are: ${[...ALL_API_KEY_SCOPES, '*'].join(', ')}.`,
          },
          { status: 400 }
        );
      }
    }
    updates.scopes = [...new Set(body.scopes as ApiKeyScope[])];
  }

  if (body.expiresAt !== undefined) {
    if (typeof body.expiresAt !== 'number' || !Number.isFinite(body.expiresAt) || body.expiresAt <= Date.now()) {
      return NextResponse.json(
        { success: false, error: 'expiresAt must be a timestamp in the future.' },
        { status: 400 }
      );
    }
    updates.expiresAt = body.expiresAt;
  }

  const updatedKey = await redisKeyStore.updateApiKey(user.id, keyId, updates);
  if (!updatedKey) {
    return NextResponse.json(
      { success: false, error: 'API key not found, inactive, or not owned by the current user.' },
      { status: 404 }
    );
  }

  return NextResponse.json({
    success: true,
    key: toPublicApiKey(updatedKey),
    message: 'API key successfully updated.',
  });
}
