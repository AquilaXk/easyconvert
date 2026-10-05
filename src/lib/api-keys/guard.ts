import { redisKeyStore } from './redis-key-store';
import type { TokenBucketOptions } from './redis-key-store';
import { getSessionFromRequest } from '../auth/session';
import type { User, UserTier } from '../auth/types';
import type { ApiKey, ApiKeyScope, QuotaUsage } from './types';
import { webhookDispatcher } from './webhook-dispatcher';
import { extractClientIp } from './ip-utils';
import {
  CLIENT_IP_CONFIG_RETRY_AFTER_SECONDS,
  ClientIpError,
  UNATTRIBUTED_CLIENT_KEY,
  rateLimitKey,
} from '@/lib/security/client-ip';
import { RATE_LIMITED_PROBLEM_TYPE } from '../api/problem-details';

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
  /** RFC 9457 problem type for the rejection when it differs from the status default (burst limit). */
  problemType?: string;
}

export interface ValidateApiAccessOptions {
  requiredUnits?: number;
  requiredScope?: string;
  scope?: string;
  allowAnonymous?: boolean;
}

const WILDCARD_SCOPE = '*';
const HTTP_BAD_REQUEST = 400;

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

export function getAnonymousBurstLimit(): BurstLimit {
  return {
    capacity: process.env.ANONYMOUS_BURST_CAPACITY ? parseInt(process.env.ANONYMOUS_BURST_CAPACITY, 10) : 10,
    refillRate: process.env.ANONYMOUS_BURST_REFILL_RATE ? parseInt(process.env.ANONYMOUS_BURST_REFILL_RATE, 10) : 1, // 1 token per second in production
  };
}

export const ANONYMOUS_BURST_LIMIT: BurstLimit = getAnonymousBurstLimit();

// The unattributed identity is every anonymous caller whose address cannot be trusted, so its bucket is sized
// for site-wide traffic like the edge middleware's shared bucket (600 burst, 100/s), not for one client.
const UNATTRIBUTED_BURST_CAPACITY_DEFAULT = 600;
const UNATTRIBUTED_BURST_REFILL_RATE_DEFAULT = 100;

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer, got "${raw}".`);
  }
  return value;
}

/** Shared anonymous burst limits for the `unattributed` identity (env: ANONYMOUS_UNATTRIBUTED_BURST_*). */
export function getUnattributedBurstLimit(): BurstLimit {
  return {
    capacity: readPositiveIntEnv('ANONYMOUS_UNATTRIBUTED_BURST_CAPACITY', UNATTRIBUTED_BURST_CAPACITY_DEFAULT),
    refillRate: readPositiveIntEnv('ANONYMOUS_UNATTRIBUTED_BURST_REFILL_RATE', UNATTRIBUTED_BURST_REFILL_RATE_DEFAULT),
  };
}

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
  // An explicit empty scope list grants NO access (least privilege).
  if (Array.isArray(grantedScopes) && grantedScopes.length === 0) return false;
  // Legacy keys created before scopes existed carry undefined scopes; they keep full access for backward compatibility.
  if (grantedScopes === undefined) return true;
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
  if (!request?.headers || typeof request.headers.get !== 'function') {
    return null;
  }
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
    redisKeyStore.markKeyExpiryNotified(key.id, key.lastExpiryNotifiedAt);
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
      key.webhookSecret || '',
      { ownerUserId: key.userId, ownerKeyId: key.id }
    ).catch(() => {});
  }
}

async function checkQuotaAndReserve(
  userId: string,
  tier: string,
  requiredUnits: number
): Promise<{ allowed: boolean; error?: string; reservationId?: string; remaining?: number; serviceUnavailable?: boolean }> {
  if (requiredUnits > 0) {
    const reservation = await redisKeyStore.reserveQuota(userId, requiredUnits);
    if (!reservation.allowed) {
      if (reservation.serviceUnavailable) {
        return {
          allowed: false,
          error: reservation.error || 'Service Unavailable: distributed quota engine is temporarily offline',
          remaining: 0,
          serviceUnavailable: true,
        };
      }
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
  try {
    const quota = await redisKeyStore.getQuotaUsage(userId);
    return {
      allowed: true,
      remaining: quota.remaining,
    };
  } catch (err: any) {
    return {
      allowed: false,
      error: 'Service Unavailable: distributed quota engine is temporarily offline',
      remaining: 0,
      serviceUnavailable: true,
    };
  }
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
    if (burst.serviceUnavailable) {
      return {
        authorized: false,
        user: verification.user,
        apiKey: verification.key,
        error: burst.error || 'Service Unavailable: distributed rate limit engine is temporarily offline',
        status: 503,
        retryAfterSeconds: 5,
        problemType: 'https://api.easyconvert.io/problems/service-unavailable',
      };
    }
    return {
      authorized: false,
      user: verification.user,
      apiKey: verification.key,
      error: 'Rate limit exceeded: too many requests for this API key. Retry after the delay in the Retry-After header.',
      status: 429,
      retryAfterSeconds: toRetryAfterSeconds(burst.retryAfterMs),
      problemType: RATE_LIMITED_PROBLEM_TYPE,
    };
  }

  const quota = await checkQuotaAndReserve(verification.user.id, verification.user.tier, requiredUnits);
  if (!quota.allowed) {
    if (quota.serviceUnavailable) {
      return {
        authorized: false,
        user: verification.user,
        apiKey: verification.key,
        error: quota.error || 'Service Unavailable',
        status: 503,
        remaining: 0,
        problemType: 'https://api.easyconvert.io/problems/service-unavailable',
      };
    }
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

const CLIENT_IP_CONFIG_ERROR_MESSAGE = 'Server misconfiguration: client IP trust settings are invalid.';
const CLIENT_IP_INVALID_ERROR_MESSAGE = 'Bad Request: malformed client address in forwarding headers.';

/**
 * Resolves the client identity through the shared trusted-proxy resolver. A malformed forwarding chain
 * becomes a 400 rejection and invalid trust configuration a 503 (with Retry-After), so no request is ever attributed by guess.
 */
function resolveClientIpForAuth(request: Request): { clientIp: string } | { rejection: ApiAuthResult } {
  try {
    return { clientIp: extractClientIp(request) };
  } catch (error) {
    if (!(error instanceof ClientIpError)) throw error;
    const malformed = error.status === HTTP_BAD_REQUEST;
    return {
      rejection: {
        authorized: false,
        error: malformed ? CLIENT_IP_INVALID_ERROR_MESSAGE : CLIENT_IP_CONFIG_ERROR_MESSAGE,
        status: error.status,
        ...(malformed ? {} : { retryAfterSeconds: CLIENT_IP_CONFIG_RETRY_AFTER_SECONDS }),
      },
    };
  }
}

function buildAnonymousUser(id: string): User {
  return {
    id,
    email: 'anonymous@easyconvert.local',
    name: 'Anonymous Client',
    tier: 'free',
    provider: 'email',
    createdAt: 0,
    updatedAt: 0,
  };
}

async function verifyAnonymousAccess(
  clientIp: string,
  requiredUnits: number
): Promise<ApiAuthResult> {
  // Anonymous burst and daily quota buckets: IPv6 clients share their /64.
  const anonBucket = rateLimitKey(clientIp);
  const anonIdentifier = `rate:anon:${anonBucket}`;
  const unattributed = clientIp === UNATTRIBUTED_CLIENT_KEY;

  // 1. Enforce IP burst rate limit (the shared unattributed identity gets site-wide sizing)
  const burst = await redisKeyStore.checkTokenBucketRateLimit(
    anonIdentifier,
    unattributed ? getUnattributedBurstLimit() : getAnonymousBurstLimit()
  );
  if (!burst.allowed) {
    if (burst.serviceUnavailable) {
      return {
        authorized: false,
        error: 'Service Unavailable: distributed rate limit engine is temporarily offline',
        status: 503,
        problemType: 'https://api.easyconvert.io/problems/service-unavailable',
      };
    }
    return {
      authorized: false,
      error: 'Rate limit exceeded: too many requests from this IP address. Retry after the delay in the Retry-After header.',
      status: 429,
      retryAfterSeconds: toRetryAfterSeconds(burst.retryAfterMs),
      problemType: RATE_LIMITED_PROBLEM_TYPE,
    };
  }

  // 2. Check anonymous daily quota
  const anonUserId = `anon:${anonBucket}`;
  if (clientIp === UNATTRIBUTED_CLIENT_KEY) {
    // No daily quota for the shared identity: it would let a single client exhaust it for every caller
    // (docs/client-ip-trust.md, item 5). Only the shared burst limiter above applies until TRUSTED_PROXIES is declared.
    return { authorized: true, user: buildAnonymousUser(anonUserId), authMethod: 'session' };
  }
  const quota = await checkQuotaAndReserve(anonUserId, 'anonymous', requiredUnits);
  if (!quota.allowed) {
    if (quota.serviceUnavailable) {
      return {
        authorized: false,
        error: 'Service Unavailable: distributed quota engine is temporarily offline',
        status: 503,
        remaining: 0,
        problemType: 'https://api.easyconvert.io/problems/service-unavailable',
      };
    }
    return {
      authorized: false,
      error: 'Daily conversion quota exceeded for anonymous usage (10 conversions per day). Please sign in or use an API key.',
      status: 429,
      remaining: quota.remaining,
      problemType: 'https://api.easyconvert.io/problems/quota-exceeded',
    };
  }

  return {
    authorized: true,
    user: buildAnonymousUser(anonUserId),
    authMethod: 'session',
    reservationId: quota.reservationId,
    remaining: quota.remaining,
  };
}

/**
 * Validates programmatic REST API requests using either API Key header or User session.
 * Supports 2-phase quota transactions (reserve), anonymous IP protection, and granular scope verification.
 */
export async function validateApiAccess(
  request: Request,
  optionsOrUnits: number | ValidateApiAccessOptions = 1,
  legacyScope?: string
): Promise<ApiAuthResult> {
  let requiredUnits = 1;
  let requiredScope: string | undefined = legacyScope;
  let allowAnonymous = false;

  if (typeof optionsOrUnits === 'number') {
    requiredUnits = optionsOrUnits;
  } else if (typeof optionsOrUnits === 'object' && optionsOrUnits !== null) {
    requiredUnits = optionsOrUnits.requiredUnits ?? 1;
    requiredScope = optionsOrUnits.requiredScope || optionsOrUnits.scope || legacyScope;
    allowAnonymous = Boolean(optionsOrUnits.allowAnonymous);
  }

  const apiKeySecret = extractApiKeySecret(request);
  if (apiKeySecret) {
    const resolved = resolveClientIpForAuth(request);
    if ('rejection' in resolved) return resolved.rejection;
    return verifyKeyAccess(apiKeySecret, requiredUnits, requiredScope, resolved.clientIp);
  }

  const sessionUser = await getSessionFromRequest(request);
  if (sessionUser) {
    const quota = await checkQuotaAndReserve(sessionUser.id, sessionUser.tier, requiredUnits);
    if (!quota.allowed) {
      if (quota.serviceUnavailable) {
        return {
          authorized: false,
          user: sessionUser,
          error: quota.error || 'Service Unavailable',
          status: 503,
          remaining: 0,
          problemType: 'https://api.easyconvert.io/problems/service-unavailable',
        };
      }
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

  if (allowAnonymous) {
    const resolved = resolveClientIpForAuth(request);
    if ('rejection' in resolved) return resolved.rejection;
    return verifyAnonymousAccess(resolved.clientIp, requiredUnits);
  }

  return {
    authorized: false,
    error: 'Authentication required. Please provide a valid Bearer API key or sign in.',
    status: 401,
  };
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

/**
 * Settles a previously reserved quota transaction against actual consumed units.
 */
export async function settleQuota(
  reservationId: string,
  actualUnits: number
): Promise<{ success: boolean; difference: number }> {
  return redisKeyStore.settleQuota(reservationId, actualUnits);
}
