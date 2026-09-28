import { redisKeyStore } from './redis-key-store';
import { getSessionFromRequest } from '../auth/session';
import type { User } from '../auth/types';
import type { ApiKey, ApiKeyScope, QuotaUsage } from './types';
import { webhookDispatcher } from './webhook-dispatcher';

export interface ApiAuthResult {
  authorized: boolean;
  user?: User;
  apiKey?: ApiKey;
  authMethod?: 'api_key' | 'session';
  error?: string;
  status?: number;
}

export function extractClientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  let candidate = '';
  if (forwarded) {
    candidate = forwarded.split(',')[0].trim();
  } else {
    const realIp = request.headers.get('x-real-ip');
    if (realIp) {
      candidate = realIp.trim();
    } else {
      const cfIp = request.headers.get('cf-connecting-ip');
      if (cfIp) candidate = cfIp.trim();
    }
  }

  if (candidate) {
    // Strip brackets and optional port from IPv6, e.g. [2001:db8::1]:8080 or [::1]
    const bracketMatch = /^\[([a-fA-F0-9:]+)\](?::\d+)?$/.exec(candidate);
    if (bracketMatch) return bracketMatch[1];
    // Strip trailing port from IPv4, e.g. 192.168.1.1:8080
    const portMatch = /^(\d+\.\d+\.\d+\.\d+):\d+$/.exec(candidate);
    if (portMatch) return portMatch[1];
    return candidate;
  }

  return '127.0.0.1';
}

function extractApiKeySecret(request: Request): string | null {
  const customHeader = request.headers.get('x-api-key');
  if (customHeader) {
    return customHeader.trim();
  }

  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.substring(7).trim();
    if (token.startsWith('ec_live_')) {
      return token;
    }
  }

  return null;
}

function checkPreExpiryNotification(key: ApiKey): void {
  if (!key.expiresAt || key.expiresAt <= Date.now() || !key.webhookUrl) {
    return;
  }
  const timeUntilExpiry = key.expiresAt - Date.now();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  if (timeUntilExpiry <= sevenDaysMs) {
    const oneDayMs = 24 * 60 * 60 * 1000;
    if (key.lastExpiryNotifiedAt && Date.now() - key.lastExpiryNotifiedAt < oneDayMs) {
      return;
    }
    key.lastExpiryNotifiedAt = Date.now();
    webhookDispatcher.dispatch(
      key.webhookUrl,
      'key.expiring_soon',
      {
        keyId: key.id,
        keyName: key.name,
        prefix: key.prefix,
        expiresAt: key.expiresAt,
        daysRemaining: Math.max(1, Math.ceil(timeUntilExpiry / (24 * 60 * 60 * 1000))),
      },
      key.webhookSecret || ''
    ).catch(() => {});
  }
}

function checkScopeAccess(key: ApiKey, requiredScope?: ApiKeyScope): string | null {
  if (!requiredScope || !key.scopes || key.scopes.length === 0) {
    return null;
  }
  const hasScope = key.scopes.includes('*') || key.scopes.includes(requiredScope);
  if (!hasScope) {
    return `Forbidden: API key lacks required scope '${requiredScope}'.`;
  }
  return null;
}

async function checkDistributedQuota(userId: string, tier: string, requiredUnits: number): Promise<string | null> {
  if (requiredUnits > 0) {
    const quotaCheck = await redisKeyStore.recordUsage(userId, requiredUnits);
    if (!quotaCheck.allowed) {
      return `Daily conversion quota exceeded for tier '${tier}'. Please upgrade or wait for the midnight UTC reset.`;
    }
  }
  return null;
}

async function verifyKeyAccess(
  apiKeySecret: string,
  requiredUnits: number,
  clientIp?: string,
  requiredScope?: ApiKeyScope
): Promise<ApiAuthResult> {
  const verification = await redisKeyStore.verifyApiKey(apiKeySecret, clientIp);
  if (!verification.valid || !verification.user || !verification.key) {
    const isIpDenied = verification.error?.includes('IP');
    return {
      authorized: false,
      error: verification.error || 'Invalid, revoked, or non-existent API key provided',
      status: isIpDenied ? 403 : 401,
    };
  }

  // Enforce Key Expiration
  if (verification.key.expiresAt && Date.now() > verification.key.expiresAt) {
    return {
      authorized: false,
      error: 'API key has expired.',
      status: 401,
    };
  }

  // Pre-expiry notification check (within 7 days of expiration)
  checkPreExpiryNotification(verification.key);

  // Enforce Granular Scopes (RBAC)
  const scopeError = checkScopeAccess(verification.key, requiredScope);
  if (scopeError) {
    return {
      authorized: false,
      user: verification.user,
      apiKey: verification.key,
      error: scopeError,
      status: 403,
    };
  }

  // Enforce Distributed Quotas via atomic Redis Lua transactions
  const quotaError = await checkDistributedQuota(verification.user.id, verification.user.tier, requiredUnits);
  if (quotaError) {
    return {
      authorized: false,
      user: verification.user,
      apiKey: verification.key,
      error: quotaError,
      status: 429,
    };
  }

  return {
    authorized: true,
    user: verification.user,
    apiKey: verification.key,
    authMethod: 'api_key',
  };
}

async function verifySessionAccess(request: Request, requiredUnits: number): Promise<ApiAuthResult> {
  const sessionUser = await getSessionFromRequest(request);
  if (!sessionUser) {
    return {
      authorized: false,
      error: 'Authentication required. Please provide a valid Bearer API key or sign in.',
      status: 401,
    };
  }

  if (requiredUnits > 0) {
    const quotaCheck = await redisKeyStore.recordUsage(sessionUser.id, requiredUnits);
    if (!quotaCheck.allowed) {
      return {
        authorized: false,
        user: sessionUser,
        error: `Daily conversion quota exceeded for tier '${sessionUser.tier}'.`,
        status: 429,
      };
    }
  }

  return {
    authorized: true,
    user: sessionUser,
    authMethod: 'session',
  };
}

/**
 * Validates programmatic REST API requests using either API Key header or User session.
 * Exclusively uses redisKeyStore for distributed atomic quota transactions.
 */
export async function validateApiAccess(
  request: Request,
  requiredUnits: number = 1,
  requiredScope?: ApiKeyScope
): Promise<ApiAuthResult> {
  const clientIp = extractClientIp(request);
  const apiKeySecret = extractApiKeySecret(request);
  if (apiKeySecret) {
    return verifyKeyAccess(apiKeySecret, requiredUnits, clientIp, requiredScope);
  }
  return verifySessionAccess(request, requiredUnits);
}

/**
 * Retrieves distributed quota usage for a user via redisKeyStore.
 */
export async function getQuotaUsage(userId: string): Promise<QuotaUsage> {
  return redisKeyStore.getQuotaUsage(userId);
}
