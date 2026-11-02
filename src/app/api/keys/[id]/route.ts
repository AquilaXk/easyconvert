import { NextRequest, NextResponse } from 'next/server';
import { dashboardRefusal as refusal, resolveDashboardCaller } from '@/lib/api/dashboard-refusal';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';
import { ALL_API_KEY_SCOPES, ApiKeyScope, ApiKeyUpdateOptions } from '@/lib/api-keys/types';
import { toPublicApiKey } from '@/lib/api-keys/public-views';

export const dynamic = 'force-dynamic';

const HTTP_NOT_FOUND = 404;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function DELETE(req: NextRequest, context: RouteContext) {
  const caller = await resolveDashboardCaller(req, { action: 'revoke API keys', adminKey: true });
  if ('refused' in caller) return caller.refused;
  const { user } = caller;
  const { id: keyId } = await context.params;

  const revoked = await redisKeyStore.revokeApiKey(user.id, keyId);
  if (!revoked) {
    return refusal(HTTP_NOT_FOUND, undefined, 'API key not found or not owned by the current user.');
  }

  return NextResponse.json({
    success: true,
    message: 'API key successfully revoked.',
  });
}

export async function PATCH(req: NextRequest, context: RouteContext) {
  const caller = await resolveDashboardCaller(req, { action: 'update API keys', adminKey: true });
  if ('refused' in caller) return caller.refused;
  const { user } = caller;
  const { id: keyId } = await context.params;

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
    return refusal(HTTP_NOT_FOUND, undefined, 'API key not found, inactive, or not owned by the current user.');
  }

  return NextResponse.json({
    success: true,
    key: toPublicApiKey(updatedKey),
    message: 'API key successfully updated.',
  });
}
