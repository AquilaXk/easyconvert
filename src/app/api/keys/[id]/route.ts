import { NextRequest, NextResponse } from 'next/server';
import { dashboardRefusal as refusal, notFoundRefusal, resolveDashboardCaller } from '@/lib/api/dashboard-refusal';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';
import { ALL_API_KEY_SCOPES, ApiKeyScope, ApiKeyUpdateOptions } from '@/lib/api-keys/types';
import { toPublicApiKey } from '@/lib/api-keys/public-views';
import { InvalidWebhookConfigError, validateWebhookUrl } from '@/lib/security/ssrf';

export const dynamic = 'force-dynamic';

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
    return notFoundRefusal('API key not found or not owned by the current user.');
  }

  return NextResponse.json({
    success: true,
    message: 'API key successfully revoked.',
  });
}

function parseWebhookUpdates(
  body: Record<string, unknown>,
  updates: ApiKeyUpdateOptions
): string | null {
  if (body.webhookUrl !== undefined) {
    if (typeof body.webhookUrl !== 'string') {
      return 'webhookUrl must be a string.';
    }
    updates.webhookUrl = body.webhookUrl.trim();
    if (updates.webhookUrl) {
      const urlCheck = validateWebhookUrl(updates.webhookUrl);
      if (!urlCheck.valid) {
        return urlCheck.error!;
      }
    }
  }

  if (body.webhookSecret !== undefined) {
    if (typeof body.webhookSecret !== 'string') {
      return 'webhookSecret must be a string.';
    }
    updates.webhookSecret = body.webhookSecret.trim();
  }

  return null;
}

function parseAccessUpdates(
  body: Record<string, unknown>,
  updates: ApiKeyUpdateOptions
): string | null {
  if (body.allowedIps !== undefined) {
    if (!Array.isArray(body.allowedIps)) {
      return 'allowedIps must be an array of strings.';
    }
    for (const ip of body.allowedIps) {
      if (typeof ip !== 'string' || !ip.trim()) {
        return 'Every item in allowedIps must be a non-empty string.';
      }
    }
    updates.allowedIps = body.allowedIps.map((ip) => ip.trim());
  }

  if (body.scopes !== undefined) {
    if (!Array.isArray(body.scopes) || body.scopes.length === 0) {
      return 'scopes must be a non-empty array of valid scopes.';
    }
    const valid = new Set<ApiKeyScope>([...ALL_API_KEY_SCOPES, '*']);
    for (const s of body.scopes) {
      if (typeof s !== 'string' || !valid.has(s as ApiKeyScope)) {
        return `Invalid scope '${String(s)}'. Valid scopes are: ${[...ALL_API_KEY_SCOPES, '*'].join(', ')}.`;
      }
    }
    updates.scopes = [...new Set(body.scopes as ApiKeyScope[])];
  }

  return null;
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

  const accessError = parseAccessUpdates(body, updates);
  if (accessError) {
    return refusal(400, 'invalid_key_settings', accessError);
  }

  const webhookError = parseWebhookUpdates(body, updates);
  if (webhookError) {
    return refusal(400, 'invalid_key_settings', webhookError);
  }

  if (body.expiresAt !== undefined) {
    if (typeof body.expiresAt !== 'number' || !Number.isFinite(body.expiresAt) || body.expiresAt <= Date.now()) {
      return refusal(400, 'invalid_key_settings', 'expiresAt must be a timestamp in the future.');
    }
    updates.expiresAt = body.expiresAt;
  }

  let updatedKey;
  try {
    updatedKey = await redisKeyStore.updateApiKey(user.id, keyId, updates);
  } catch (err: unknown) {
    if (err instanceof InvalidWebhookConfigError) {
      return refusal(400, 'invalid_key_settings', err.message);
    }
    throw err;
  }
  if (!updatedKey) {
    return notFoundRefusal('API key not found, inactive, or not owned by the current user.');
  }

  return NextResponse.json({
    success: true,
    key: toPublicApiKey(updatedKey),
    message: 'API key successfully updated.',
  });
}
