import { NextRequest, NextResponse } from 'next/server';
import { accessRefusal } from '@/lib/api/dashboard-refusal';
import { codedRefusal } from '@/lib/api/problem-details';
import type { DashboardRefusalCode } from '@/lib/refusal-codes';
import { getSessionFromRequest } from '@/lib/auth/session';
import { validateApiAccess } from '@/lib/api-keys/guard';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';
import { ALL_API_KEY_SCOPES, ApiKeyScope, ApiKeyUpdateOptions } from '@/lib/api-keys/types';
import { toPublicApiKey } from '@/lib/api-keys/public-views';

export const dynamic = 'force-dynamic';

const refusal = codedRefusal<DashboardRefusalCode>;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function DELETE(req: NextRequest, context: RouteContext) {
  let user = await getSessionFromRequest(req);
  if (!user) {
    const auth = await validateApiAccess(req, 0);
    if (!auth.authorized || !auth.user) {
      return accessRefusal(auth, 'Unauthorized: Sign in or valid API key required.');
    }
    if (auth.apiKey && !auth.apiKey.scopes?.includes('*')) {
      return refusal(403, 'admin_scope_required', 'Forbidden: API key lacks admin wildcard (*) scope to revoke API keys.');
    }
    user = auth.user;
  }

  const resolvedParams = await Promise.resolve(context.params);
  const keyId = resolvedParams.id;
  if (!keyId) {
    return refusal(400, 'id_required', 'Key ID parameter missing.');
  }

  const revoked = await redisKeyStore.revokeApiKey(user.id, keyId);
  if (!revoked) {
    return refusal(404, 'not_found', 'API key not found or not owned by the current user.');
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
      return accessRefusal(auth, 'Unauthorized: Sign in or valid API key required.');
    }
    if (auth.apiKey && !auth.apiKey.scopes?.includes('*')) {
      return refusal(403, 'admin_scope_required', 'Forbidden: API key lacks admin wildcard (*) scope to update API keys.');
    }
    user = auth.user;
  }

  const resolvedParams = await Promise.resolve(context.params);
  const keyId = resolvedParams.id;
  if (!keyId) {
    return refusal(400, 'id_required', 'Key ID parameter missing.');
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const updates: ApiKeyUpdateOptions = {};

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return refusal(400, 'invalid_key_settings', 'name must be a non-empty string.');
    }
    updates.name = body.name.trim();
  }

  if (body.allowedIps !== undefined) {
    if (!Array.isArray(body.allowedIps)) {
      return refusal(400, 'invalid_key_settings', 'allowedIps must be an array of strings.');
    }
    for (const ip of body.allowedIps) {
      if (typeof ip !== 'string' || !ip.trim()) {
        return refusal(400, 'invalid_key_settings', 'Every item in allowedIps must be a non-empty string.');
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
      return refusal(400, 'invalid_key_settings', 'scopes must be a non-empty array of valid scopes.');
    }
    const valid = new Set<ApiKeyScope>([...ALL_API_KEY_SCOPES, '*']);
    for (const s of body.scopes) {
      if (typeof s !== 'string' || !valid.has(s as ApiKeyScope)) {
        return refusal(400, 'invalid_key_settings', `Invalid scope '${String(s)}'. Valid scopes are: ${[...ALL_API_KEY_SCOPES, '*'].join(', ')}.`);
      }
    }
    updates.scopes = [...new Set(body.scopes as ApiKeyScope[])];
  }

  if (body.expiresAt !== undefined) {
    if (typeof body.expiresAt !== 'number' || !Number.isFinite(body.expiresAt) || body.expiresAt <= Date.now()) {
      return refusal(400, 'invalid_key_settings', 'expiresAt must be a timestamp in the future.');
    }
    updates.expiresAt = body.expiresAt;
  }

  const updatedKey = await redisKeyStore.updateApiKey(user.id, keyId, updates);
  if (!updatedKey) {
    return refusal(404, 'not_found', 'API key not found, inactive, or not owned by the current user.');
  }

  return NextResponse.json({
    success: true,
    key: toPublicApiKey(updatedKey),
    message: 'API key successfully updated.',
  });
}
