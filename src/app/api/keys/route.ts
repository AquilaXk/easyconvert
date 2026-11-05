import { NextRequest, NextResponse } from 'next/server';
import { dashboardRefusal as refusal, resolveDashboardCaller } from '@/lib/api/dashboard-refusal';
import { serverFault } from '@/lib/api/problem-details';
import type { DashboardRefusalCode } from '@/lib/refusal-codes';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';
import { ALL_API_KEY_SCOPES, ApiKeyScope } from '@/lib/api-keys/types';
import { toPublicApiKey } from '@/lib/api-keys/public-views';
import { TERMS_VERSION, termsRefusal, termsRefusalText } from '@/lib/legal/documents';
import { resolveEffectiveWebhook } from '@/lib/security/ssrf';

export const dynamic = 'force-dynamic';

const MANAGE_KEYS = { action: 'manage API keys', adminKey: true };

export async function GET(req: NextRequest) {
  const auth = await resolveDashboardCaller(req, MANAGE_KEYS);
  if ('refused' in auth) return auth.refused;

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

  if (body?.webhookUrl !== undefined && typeof body.webhookUrl !== 'string') {
    return { keyName, error: 'webhookUrl must be a string.' };
  }
  if (body?.webhookSecret !== undefined && typeof body.webhookSecret !== 'string') {
    return { keyName, error: 'webhookSecret must be a string.' };
  }
  const rawWebhookUrl = typeof body?.webhookUrl === 'string' && body.webhookUrl.trim() ? body.webhookUrl.trim() : undefined;
  const rawWebhookSecret = typeof body?.webhookSecret === 'string' && body.webhookSecret.trim() ? body.webhookSecret.trim() : undefined;
  const resolvedWebhook = resolveEffectiveWebhook(rawWebhookUrl, rawWebhookSecret, undefined, undefined);
  if (resolvedWebhook.error) {
    return { keyName, error: resolvedWebhook.error };
  }
  const { webhookUrl, webhookSecret } = resolvedWebhook;

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
  const auth = await resolveDashboardCaller(req, MANAGE_KEYS);
  if ('refused' in auth) return auth.refused;

  try {
    const body = await req.json().catch(() => ({}));
    const termsRefused = termsRefusal(body?.acceptedTermsVersion);
    if (termsRefused) return refusal(400, termsRefused, termsRefusalText(termsRefused));
    const parsed = parseKeyCreationPayload(body);
    if (parsed.error) return refusal(400, 'invalid_key_settings', parsed.error);

    const result = await redisKeyStore.generateApiKey(auth.user.id, parsed.keyName, {
      allowedIps: parsed.allowedIps,
      webhookUrl: parsed.webhookUrl,
      webhookSecret: parsed.webhookSecret,
      scopes: parsed.scopes,
      expiresAt: parsed.expiresAt,
      acceptedTermsVersion: TERMS_VERSION,
    });

    return NextResponse.json({
      success: true,
      key: toPublicApiKey(result.key),
      secretKey: result.secretKey,
      warning: 'Please copy your API key now. You will not be able to see it again.',
    });
  } catch (err: unknown) {
    return serverFault<DashboardRefusalCode>('keys', err, 'Failed to generate API key.', 'key_create_failed');
  }
}

