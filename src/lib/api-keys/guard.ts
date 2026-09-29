import { redisKeyStore } from './redis-key-store';
import type { TokenBucketOptions } from './redis-key-store';
import { getSessionFromRequest } from '../auth/session';
import type { User, UserTier } from '../auth/types';
import type { ApiKey, ApiKeyScope, QuotaUsage } from './types';
import { webhookDispatcher } from './webhook-dispatcher';
import { extractClientIp } from './ip-utils';

export { extractClientIp };

export interface ApiAuthResult {
  authorized: boolean;
  user?: User;
  apiKey?: ApiKey;
  authMethod?: 'api_key' | 'session';
  error?: string;
  status?: number;
  reservationId?: string;
  remaining?: number;
  /** Seconds the caller should wait before retrying; set on burst rate limit (429) rejections. */
  retryAfterSeconds?: number;
}

export interface ValidateApiAccessOptions {
  requiredUnits?: number;
  requiredScope?: string;
  scope?: string;
}

const WILDCARD_SCOPE = '*';

type BurstLimit = Required<Pick<TokenBucketOptions, 'capacity' | 'refillRate'>>;

/**
 * Per-API-key token bucket sizes by account tier: `capacity` is the maximum burst,
 * `refillRate` the sustained requests per second.
 */
export const API_KEY_BURST_LIMITS: Readonly<Record<UserTier, BurstLimit>> = {
  free: { capacity: 20, refillRate: 2 },
  pro: { capacity: 100, refillRate: 20 },
  enterprise: { capacity: 500, refillRate: 100 },
};

const API_KEY_RATE_LIMIT_PREFIX = 'apikey:';
const MIN_RETRY_AFTER_SECONDS = 1;
const MS_PER_SECOND = 1000;

function toRetryAfterSeconds(retryAfterMs: number): number {
  return Math.max(MIN_RETRY_AFTER_SECONDS, Math.ceil(retryAfterMs / MS_PER_SECOND));
}

/**
 * Builds the extra response headers for a failed authorization result
 * (currently `Retry-After` when a burst rate limit rejected the request).
 */
export function authErrorHeaders(auth: Pick<ApiAuthResult, 'retryAfterSeconds'>): Record<string, string> {
  if (auth.retryAfterSeconds === undefined) {
    return {};
  }
  return { 'Retry-After': String(auth.retryAfterSeconds) };
}

/**
 * Validates whether an API key's granted scopes satisfy the required permission scope.
 * Only an exact match, the root wildcard ('*'), or a same-namespace wildcard
 * (e.g. 'convert:*' for 'convert:write') is accepted; there are no cross-namespace aliases.
 */
export function isScopeAllowed(grantedScopes?: string[], requiredScope?: string): boolean {
  if (!requiredScope) return true;
  // Legacy keys created before scopes existed carry no scopes; they keep full access for backward compatibility.
  if (!grantedScopes || grantedScopes.length === 0) return true;
  if (grantedScopes.includes(WILDCARD_SCOPE)) return true;
  if (grantedScopes.includes(requiredScope)) return true;

  const colonIndex = requiredScope.indexOf(':');
  if (colonIndex > 0) {
    const namespaceWildcard = `${requiredScope.substring(0, colonIndex)}:${WILDCARD_SCOPE}`;
    return grantedScopes.includes(namespaceWildcard);
  }

  return false;
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

async function checkQuotaAndReserve(
  userId: string,
  tier: string,
  requiredUnits: number
): Promise<{ allowed: boolean; error?: string; reservationId?: string; remaining?: number }> {
  if (requiredUnits > 0) {
    const reservation = await redisKeyStore.reserveQuota(userId, requiredUnits);
    if (!reservation.allowed) {
      return {
        allowed: false,
        error: `Daily conversion quota exceeded for tier '${tier}'. Please upgrade or wait for the midnight UTC reset.`,
        remaining: reservation.remaining,
      };
    }
    return {
      allowed: true,
      reservationId: reservation.reservationId,
      remaining: reservation.remaining,
    };
  }

  // Zero-unit check (reads/downloads/status inspections) - non-consuming, must not lock out user
  const quota = await redisKeyStore.getQuotaUsage(userId);
  return {
    allowed: true,
    remaining: quota.remaining,
  };
}

async function verifyKeyAccess(
  apiKeySecret: string,
  requiredUnits: number,
  requiredScope?: string,
  clientIp?: string
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

  // Pre-expiry notification check (within 7 days of expiration, throttled to 24h)
  checkPreExpiryNotification(verification.key);

  // Scope enforcement
  if (requiredScope && !isScopeAllowed(verification.key.scopes, requiredScope)) {
    return {
      authorized: false,
      user: verification.user,
      apiKey: verification.key,
      error: `Forbidden: API key lacks required scope '${requiredScope}'`,
      status: 403,
    };
  }

  // Per-key burst rate limit (token bucket sized by account tier)
  const burst = await redisKeyStore.checkTokenBucketRateLimit(
    `${API_KEY_RATE_LIMIT_PREFIX}${verification.key.id}`,
    API_KEY_BURST_LIMITS[verification.user.tier]
  );
  if (!burst.allowed) {
    return {
      authorized: false,
      user: verification.user,
      apiKey: verification.key,
      error: 'Rate limit exceeded: too many requests for this API key. Retry after the delay in the Retry-After header.',
      status: 429,
      retryAfterSeconds: toRetryAfterSeconds(burst.retryAfterMs),
    };
  }

  const quota = await checkQuotaAndReserve(verification.user.id, verification.user.tier, requiredUnits);
  if (!quota.allowed) {
    return {
      authorized: false,
      user: verification.user,
      apiKey: verification.key,
      error: quota.error,
      status: 429,
      remaining: quota.remaining,
    };
  }

  return {
    authorized: true,
    user: verification.user,
    apiKey: verification.key,
    authMethod: 'api_key',
    reservationId: quota.reservationId,
    remaining: quota.remaining,
  };
}

async function verifySessionAccess(
  request: Request,
  requiredUnits: number
): Promise<ApiAuthResult> {
  const sessionUser = await getSessionFromRequest(request);
  if (!sessionUser) {
    return {
      authorized: false,
      error: 'Authentication required. Please provide a valid Bearer API key or sign in.',
      status: 401,
    };
  }

  const quota = await checkQuotaAndReserve(sessionUser.id, sessionUser.tier, requiredUnits);
  if (!quota.allowed) {
    return {
      authorized: false,
      user: sessionUser,
      error: quota.error,
      status: 429,
      remaining: quota.remaining,
    };
  }

  return {
    authorized: true,
    user: sessionUser,
    authMethod: 'session',
    reservationId: quota.reservationId,
    remaining: quota.remaining,
  };
}

/**
 * Validates programmatic REST API requests using either API Key header or User session.
 * Supports 2-phase quota transactions (reserve) and granular scope verification.
 */
export async function validateApiAccess(
  request: Request,
  optionsOrUnits: number | ValidateApiAccessOptions = 1,
  legacyScope?: string
): Promise<ApiAuthResult> {
  let requiredUnits = 1;
  let requiredScope: string | undefined = legacyScope;

  if (typeof optionsOrUnits === 'number') {
    requiredUnits = optionsOrUnits;
  } else if (typeof optionsOrUnits === 'object' && optionsOrUnits !== null) {
    requiredUnits = optionsOrUnits.requiredUnits ?? 1;
    requiredScope = optionsOrUnits.requiredScope || optionsOrUnits.scope || legacyScope;
  }

  const clientIp = extractClientIp(request);
  const apiKeySecret = extractApiKeySecret(request);
  if (apiKeySecret) {
    return verifyKeyAccess(apiKeySecret, requiredUnits, requiredScope, clientIp);
  }
  return verifySessionAccess(request, requiredUnits);
}

/**
 * Directly records quota usage against redisKeyStore.
 */
export async function recordUsage(userId: string, count: number = 1): Promise<{ allowed: boolean; remaining: number }> {
  return redisKeyStore.recordUsage(userId, count);
}

/**
 * Retrieves distributed quota usage for a user via redisKeyStore.
 */
export async function getQuotaUsage(userId: string): Promise<QuotaUsage> {
  return redisKeyStore.getQuotaUsage(userId);
}

/**
 * Commits a previously reserved quota transaction.
 */
export async function commitQuota(reservationId: string): Promise<boolean> {
  return redisKeyStore.commitQuota(reservationId);
}

/**
 * Rolls back / refunds a previously reserved quota transaction on failure.
 */
export async function rollbackQuota(reservationId: string): Promise<boolean> {
  return redisKeyStore.rollbackQuota(reservationId);
}
