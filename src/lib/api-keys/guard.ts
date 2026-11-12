import { redisKeyStore } from './redis-key-store';
import { RESERVATION_LEASE } from './reservation-ledger';
import { leaseToHandedOffWork, RECOVERY_UNKNOWN, renewLease, RESERVATION_ENGINE, type Recovery, type ReservedUnit } from './hand-off';
import { QueueUnavailableError } from '../types';
import type { TokenBucketOptions } from './redis-key-store';
import { API_KEY_BURST_LIMITS, dailyConversions, planOfCaller, type PlanCaller } from '../plan-limits';
import { getSessionFromRequest } from '../auth/session';
import { AuthStoreUnavailableError } from '../auth/store-unavailable';
import { anonymousUserId, isAnonymousUserId, isUnattributedAnonymous } from '../auth/anonymous-identity';
import type { User } from '../auth/types';
import type { ApiKey, ApiKeyScope, QuotaUsage } from './types';
import { webhookDispatcher } from './webhook-dispatcher';
import { extractClientIp } from './ip-utils';
import { CLIENT_IP_CONFIG_RETRY_AFTER_SECONDS, ClientIpConfigError, ClientIpError, rateLimitKey } from '@/lib/security/client-ip';
import { RATE_LIMITED_PROBLEM_TYPE } from '../api/problem-details';
import { HTTP_SERVICE_UNAVAILABLE, HTTP_TOO_MANY_REQUESTS, QUOTA_EXCEEDED_PROBLEM_TYPE, SERVICE_UNAVAILABLE_PROBLEM_TYPE } from '../refusal-codes';

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

interface AccessScopeOptions {
  requiredScope?: string;
  scope?: string;
  allowAnonymous?: boolean;
}

export type ValidateApiAccessOptions = AccessScopeOptions & {
  /** Conversions to reserve (1 when absent; 0 for a request that costs none, such as a link import, which a used-up day does not refuse). */
  requiredUnits?: number;
};

const WILDCARD_SCOPE = '*';
const HTTP_BAD_REQUEST = 400;
const QUOTA_ENGINE_OFFLINE = 'Service Unavailable: distributed quota engine is temporarily offline';

/**
 * The refusal text of a caller whose conversions of the day are used up: the allowance the key store enforces for its plan
 * (`ANONYMOUS_DAILY_LIMIT` without an account) and when it resets.
 */
function quotaExceeded(caller: PlanCaller): string {
  return `Daily conversion quota exceeded (${dailyConversions(planOfCaller(caller))} conversions per day). It resets at midnight UTC.`;
}

type BurstLimit = Required<Pick<TokenBucketOptions, 'capacity' | 'refillRate'>>;

export { API_KEY_BURST_LIMITS };

export function getAnonymousBurstLimit(): BurstLimit {
  return {
    capacity: process.env.ANONYMOUS_BURST_CAPACITY ? parseInt(process.env.ANONYMOUS_BURST_CAPACITY, 10) : 10,
    refillRate: process.env.ANONYMOUS_BURST_REFILL_RATE ? parseInt(process.env.ANONYMOUS_BURST_REFILL_RATE, 10) : 1, // 1 token per second in production
  };
}

// The unattributed identity is every anonymous caller whose address cannot be trusted, so its bucket is sized
// for site-wide traffic like the edge middleware's shared bucket (600 burst, 100/s), not for one client.
const UNATTRIBUTED_BURST_CAPACITY_DEFAULT = 600;
const UNATTRIBUTED_BURST_REFILL_RATE_DEFAULT = 100;

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ClientIpConfigError(`${name} must be a positive integer, got "${raw}".`);
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

export function extractApiKeySecret(request: Request): string | null {
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

interface QuotaCheck {
  allowed: boolean;
  error?: string;
  reservationId?: string;
  remaining?: number;
  serviceUnavailable?: boolean;
}

/** Why the quota of a caller could not be reserved: the quota store is offline (503), or the conversions of the day are used up (429). */
type QuotaRefusal = Required<Pick<ApiAuthResult, 'error' | 'status' | 'problemType'>> & Pick<ApiAuthResult, 'remaining'>;

/** The refusal of `userId` for a quota check that did not allow it. */
function quotaRefusal(quota: QuotaCheck, userId: string): QuotaRefusal {
  const anonymous = isAnonymousUserId(userId);
  if (quota.serviceUnavailable) {
    return {
      error: anonymous ? QUOTA_ENGINE_OFFLINE : quota.error || 'Service Unavailable',
      status: HTTP_SERVICE_UNAVAILABLE,
      remaining: 0,
      problemType: SERVICE_UNAVAILABLE_PROBLEM_TYPE,
    };
  }
  return {
    error: quota.error ?? '',
    status: HTTP_TOO_MANY_REQUESTS,
    remaining: quota.remaining,
    problemType: QUOTA_EXCEEDED_PROBLEM_TYPE,
  };
}

async function checkQuotaAndReserve(userId: string, tier: string, need: number): Promise<QuotaCheck> {
  if (need > 0) {
    const reservation = await redisKeyStore.reserveQuota(userId, need);
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
        error: quotaExceeded({ id: userId, tier }),
        remaining: reservation.remaining,
      };
    }
    return {
      allowed: true,
      reservationId: reservation.reservationId,
      remaining: reservation.remaining,
    };
  }

  // Zero-unit check (reads/downloads/status inspections, link imports) - non-consuming, must not lock out user
  try {
    const quota = await redisKeyStore.getQuotaUsage(userId);
    return {
      allowed: true,
      remaining: quota.remaining,
    };
  } catch {
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
  need: number,
  requiredScope?: string,
  clientIp?: string
): Promise<ApiAuthResult> {
  const verification = await redisKeyStore.verifyApiKey(apiKeySecret, clientIp);
  if (verification.serviceUnavailable) return storeUnavailable(verification.error);
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
        problemType: SERVICE_UNAVAILABLE_PROBLEM_TYPE,
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

  const quota = await checkQuotaAndReserve(verification.user.id, verification.user.tier, need);
  if (!quota.allowed) {
    return { authorized: false, user: verification.user, apiKey: verification.key, ...quotaRefusal(quota, verification.user.id) };
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

const STORE_UNAVAILABLE_MESSAGE = 'Service Unavailable: the account store is temporarily unavailable';

/** The refusal of a request whose key or session the account store could not check: 503 with Retry-After, never an acceptance. */
function storeUnavailable(error = STORE_UNAVAILABLE_MESSAGE, retryAfterSeconds = 5): ApiAuthResult {
  return { authorized: false, error, status: HTTP_SERVICE_UNAVAILABLE, retryAfterSeconds, problemType: SERVICE_UNAVAILABLE_PROBLEM_TYPE };
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

async function verifyAnonymousAccess(clientIp: string, need: number): Promise<ApiAuthResult> {
  // Anonymous burst and daily quota buckets: IPv6 clients share their /64.
  const anonBucket = rateLimitKey(clientIp);
  const anonIdentifier = `rate:anon:${anonBucket}`;
  const anonUserId = anonymousUserId(anonBucket);
  const unattributed = isUnattributedAnonymous(anonUserId);

  // 1. Enforce IP burst rate limit (the shared unattributed identity gets site-wide sizing)
  let burstLimit: BurstLimit;
  try {
    burstLimit = unattributed ? getUnattributedBurstLimit() : getAnonymousBurstLimit();
  } catch (error) {
    if (!(error instanceof ClientIpConfigError)) throw error;
    // A malformed limit is a deployment fault: refuse like invalid trust configuration, without echoing the value.
    console.error(`[guard] ${error.message}`);
    return {
      authorized: false,
      error: CLIENT_IP_CONFIG_ERROR_MESSAGE,
      status: error.status,
      retryAfterSeconds: CLIENT_IP_CONFIG_RETRY_AFTER_SECONDS,
    };
  }
  const burst = await redisKeyStore.checkTokenBucketRateLimit(anonIdentifier, burstLimit);
  if (!burst.allowed) {
    if (burst.serviceUnavailable) {
      return {
        authorized: false,
        error: 'Service Unavailable: distributed rate limit engine is temporarily offline',
        status: 503,
        problemType: SERVICE_UNAVAILABLE_PROBLEM_TYPE,
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
  if (unattributed) {
    // No daily quota for the shared identity: it would let a single client exhaust it for every caller
    // (docs/client-ip-trust.md, item 5). Only the shared burst limiter above applies until TRUSTED_PROXIES is declared.
    return { authorized: true, user: buildAnonymousUser(anonUserId), authMethod: 'session' };
  }
  const quota = await checkQuotaAndReserve(anonUserId, 'anonymous', need);
  if (!quota.allowed) return { authorized: false, ...quotaRefusal(quota, anonUserId) };

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
  try {
    return await authenticateRequest(request, optionsOrUnits, legacyScope);
  } catch (error) {
    if (error instanceof AuthStoreUnavailableError) return storeUnavailable(undefined, error.retryAfterSeconds);
    throw error;
  }
}

async function authenticateRequest(
  request: Request,
  optionsOrUnits: number | ValidateApiAccessOptions,
  legacyScope?: string
): Promise<ApiAuthResult> {
  let need: number = 1;
  let requiredScope: string | undefined = legacyScope;
  let allowAnonymous = false;

  if (typeof optionsOrUnits === 'number') {
    need = optionsOrUnits;
  } else if (typeof optionsOrUnits === 'object' && optionsOrUnits !== null) {
    need = optionsOrUnits.requiredUnits ?? 1;
    requiredScope = optionsOrUnits.requiredScope || optionsOrUnits.scope || legacyScope;
    allowAnonymous = Boolean(optionsOrUnits.allowAnonymous);
  }

  const apiKeySecret = extractApiKeySecret(request);
  if (apiKeySecret) {
    const resolved = resolveClientIpForAuth(request);
    if ('rejection' in resolved) return resolved.rejection;
    return verifyKeyAccess(apiKeySecret, need, requiredScope, resolved.clientIp);
  }

  const sessionUser = await getSessionFromRequest(request);
  if (sessionUser) {
    const quota = await checkQuotaAndReserve(sessionUser.id, sessionUser.tier, need);
    if (!quota.allowed) return { authorized: false, user: sessionUser, ...quotaRefusal(quota, sessionUser.id) };
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
    return verifyAnonymousAccess(resolved.clientIp, need);
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
 * Why the conversions a request needs were refused, as data for the route layer to answer (`conversionRefusalResponse`):
 * the quota store is offline, or the day has fewer conversions left than the request needs. `usage` is the day's count
 * with `remaining` as the refusal found it.
 */
export type ConversionRefusal =
  | { reason: 'offline'; error: string }
  | { reason: 'used-up'; error: string; usage: QuotaUsage; requiredUnits: number };

/** Conversion units of a caller, reserved after the request was authenticated with none; or why they were refused. */
export type ConversionUnit = { reserved: true; reservationId?: string } | { reserved: false; refusal: ConversionRefusal };

function conversionsNeeded(units: number): string {
  return units === 1 ? '1 conversion' : `${units} conversions`;
}

/** The refusal of a request of `user` that needs `requiredUnits` conversions on a day with `usage.remaining` left. */
export function conversionsUsedUp(user: User, usage: QuotaUsage, requiredUnits: number): ConversionRefusal {
  const allowance = quotaExceeded(user);
  const left = Math.max(0, usage.remaining);
  const error = `${allowance} This request needs ${conversionsNeeded(requiredUnits)} and ${left} ${left === 1 ? 'is' : 'are'} left today.`;
  return { reason: 'used-up', error, usage: { ...usage, remaining: left }, requiredUnits };
}

/**
 * Reserves `units` conversion units for `user`, whose request was authenticated with none so that a repeat answered from
 * its idempotency key costs nothing, or a batch reserves only for the files it will convert. The shared identity of
 * requests no proxy attributes has no daily quota (docs/client-ip-trust.md, item 5), so it reserves nothing.
 */
export async function reserveConversionUnit(user: User, units: number = 1): Promise<ConversionUnit> {
  if (isUnattributedAnonymous(user.id)) return { reserved: true };
  const quota = await checkQuotaAndReserve(user.id, user.tier, units);
  if (quota.allowed) return { reserved: true, reservationId: quota.reservationId };
  const offline = (): ConversionUnit => ({ reserved: false, refusal: { reason: 'offline', error: quotaRefusal({ allowed: false, serviceUnavailable: true }, user.id).error } });
  if (quota.serviceUnavailable) return offline();
  // The store that just refused can fail before it says how many are left: the refusal is then the offline one.
  const usage = await redisKeyStore.getQuotaUsage(user.id).catch(() => undefined);
  if (!usage) return offline();
  return { reserved: false, refusal: conversionsUsedUp(user, { ...usage, remaining: quota.remaining ?? 0 }, units) };
}

const NO_RESERVATION: ReservedUnit = {
  commit: async () => undefined,
  handOff: (work) => work.start(undefined),
};

/** Renews the provisional lease of `reservationId` every heartbeat until stopped; a renewal that fails is logged by `renewLease`. */
function keepLeaseAlive(reservationId: string): () => void {
  const timer = setInterval(() => {
    renewLease(reservationId, RESERVATION_LEASE.provisionalMs).catch(() => undefined);
  }, RESERVATION_LEASE.heartbeatMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Runs `run` while `reservationId` is reserved, and gives the reservation back when `run` ends, by an answer or a throw,
 * unless `run` committed it or handed it off. Only a successful conversion is charged (docs/policy-decisions.md, entry 15),
 * so no early return of a route has to remember the reservation. While `run` holds the reservation its lease is renewed, so
 * the unit of a process that dies comes back when the lease ends. A hand-off starts nothing once the lease is lost: a renewal
 * just before the start is the proof that the reservation still counts, as a fencing token proves a lock. The reservation
 * keeps the provisional lease through the start, and takes the lease of handed-off work only once its work is known to be
 * stored, as a lease holder extends a lease after the work it covers is confirmed; a start whose outcome is unknown then
 * needs no further write to the store that failed.
 */
export async function withReservedUnit<T>(reservationId: string | undefined, run: (unit: ReservedUnit) => Promise<T>): Promise<T> {
  if (reservationId === undefined) return run(NO_RESERVATION);
  let held = true;
  const stopRenewing = keepLeaseAlive(reservationId);
  const release = (): boolean => {
    const wasHeld = held;
    held = false;
    stopRenewing();
    return wasHeld;
  };
  const unit: ReservedUnit = {
    commit: async () => {
      if (release()) await redisKeyStore.commitQuota(reservationId);
    },
    handOff: async (work) => {
      if (!held) return work.start(undefined);
      if (!(await renewLease(reservationId, RESERVATION_LEASE.provisionalMs))) {
        release();
        throw new QueueUnavailableError(RESERVATION_ENGINE, `the lease of reservation ${reservationId} ended before its work was queued`);
      }
      const started = await work.start(reservationId).catch(async (error: unknown) => {
        const recovery = await work.recover().catch((lookupErr: unknown): Recovery<never> => {
          console.error(`[Guard] Work that may hold reservation ${reservationId} could not be looked up:`, lookupErr);
          return RECOVERY_UNKNOWN;
        });
        if (recovery.status === 'not-started') throw error;
        release();
        if (recovery.status === 'unknown') throw error;
        return recovery.work;
      });
      release();
      await leaseToHandedOffWork(reservationId);
      return started;
    },
  };
  try {
    return await run(unit);
  } finally {
    if (release()) await redisKeyStore.rollbackQuota(reservationId);
  }
}
