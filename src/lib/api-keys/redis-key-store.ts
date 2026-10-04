import crypto from 'node:crypto';
import Redis from 'ioredis';
import { redisUserStore } from '../auth/redis-user-store';
import type { UserTier } from '../auth/types';
import { KeyStore, TIER_LIMITS, ANONYMOUS_DAILY_LIMIT, getAnonymousDailyLimit, getUtcDateKey, getNextMidnightUtc, apiKeyHashCandidates } from './key-store';
import type {
  ApiKey,
  ApiKeyCreateOptions,
  ApiKeyCreateResult,
  ApiKeyRotateOptions,
  ApiKeyRotateResult,
  ApiKeyUpdateOptions,
  UserConversionFile,
} from './types';
import type { User } from '../auth/types';
import { decryptSecret } from './secret-encryption';
import { isIpInCidr, isIpAllowed } from './ip-utils';

export { isIpInCidr, isIpAllowed };

export interface QuotaReservation {
  reservationId: string;
  userId: string;
  units: number;
  dateKey: string;
  createdAt: number;
  expiresAt: number;
  status: 'reserved' | 'committed' | 'rolled_back';
}

export interface RedisKeyStoreOptions {
  keyPrefix?: string;
  isolated?: boolean;
  redisHost?: string;
  redisPort?: number;
  redisUrl?: string;
  redisClient?: Redis;
}

/**
 * Enterprise Distributed Atomic Lua Scripts for Quota Transactions.
 * Used when connecting to Redis clusters to avoid TOCTOU concurrency race conditions.
 */
export const RESERVE_QUOTA_LUA_SCRIPT = `
-- KEYS[1]: usage key (e.g. easyconvert:usage:userId:YYYY-MM-DD)
-- KEYS[2]: reservation key (e.g. easyconvert:res:reservationId)
-- ARGV[1]: units requested
-- ARGV[2]: max daily limit
-- ARGV[3]: reservation TTL in seconds
-- ARGV[4]: usage key TTL in seconds (until midnight UTC)
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local units = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])

if current + units <= limit then
  redis.call('INCRBY', KEYS[1], units)
  if current == 0 then
    redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
  end
  redis.call('SETEX', KEYS[2], tonumber(ARGV[3]), units)
  return {1, limit - (current + units)}
else
  return {0, limit - current}
end
`;

export const ROLLBACK_QUOTA_LUA_SCRIPT = `
-- KEYS[1]: usage key
-- KEYS[2]: reservation key
local units = tonumber(redis.call('GET', KEYS[2]) or '0')
if units > 0 then
  redis.call('DECRBY', KEYS[1], units)
  redis.call('DEL', KEYS[2])
  return 1
end
return 0
`;

export const COMMIT_QUOTA_LUA_SCRIPT = `
-- KEYS[1]: reservation key
return redis.call('DEL', KEYS[1])
`;

export const SETTLE_QUOTA_LUA_SCRIPT = `
-- KEYS[1]: usage key (e.g. easyconvert:usage:{userId}:YYYY-MM-DD)
-- KEYS[2]: reservation key (e.g. easyconvert:res:{userId}:reservationId)
-- ARGV[1]: actual units consumed
local reservedUnits = tonumber(redis.call('GET', KEYS[2]) or '0')
local actualUnits = tonumber(ARGV[1] or '0')
local diff = actualUnits - reservedUnits

if diff < 0 then
  redis.call('DECRBY', KEYS[1], math.abs(diff))
elseif diff > 0 then
  redis.call('INCRBY', KEYS[1], diff)
end

redis.call('DEL', KEYS[2])
return {1, diff}
`;

export const RENEW_RESERVATION_LUA_SCRIPT = `
-- KEYS[1]: reservation key (e.g. easyconvert:res:{userId}:reservationId)
-- ARGV[1]: new TTL in seconds
if redis.call('EXISTS', KEYS[1]) == 1 then
  return redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
end
return 0
`;

export const DEDUCT_QUOTA_LUA_SCRIPT = `
-- KEYS[1]: usage key (e.g. easyconvert:usage:userId:YYYY-MM-DD)
-- ARGV[1]: units requested
-- ARGV[2]: max daily limit
-- ARGV[3]: usage key TTL in seconds (until midnight UTC)
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local units = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])

if current + units <= limit then
  redis.call('INCRBY', KEYS[1], units)
  if current == 0 then
    redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
  end
  return {1, limit - (current + units)}
else
  return {0, limit - current}
end
`;

export const TOKEN_BUCKET_RATE_LIMIT_LUA_SCRIPT = `
-- KEYS[1]: rate limit key (e.g. easyconvert:rate:keyId)
-- ARGV[1]: bucket capacity (max burst tokens)
-- ARGV[2]: refill rate (tokens added per second)
-- ARGV[3]: cost (tokens required for this request)
-- ARGV[4]: key TTL in seconds
-- ARGV[5]: fallback timestamp in milliseconds (if TIME fails in mock environments)
local now = nil
local ok, rtime = pcall(redis.call, 'TIME')
if ok and rtime and type(rtime) == 'table' then
  now = (tonumber(rtime[1]) * 1000) + math.floor(tonumber(rtime[2]) / 1000)
else
  now = tonumber(ARGV[5] or '0')
end

local capacity = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])
local cost = tonumber(ARGV[3] or '1')
local ttl = tonumber(ARGV[4] or '3600')

local data = redis.call('HMGET', KEYS[1], 'tokens', 'lastRefill')
local currentTokens = tonumber(data[1])
local lastRefill = tonumber(data[2])

if not currentTokens or not lastRefill then
  currentTokens = capacity
  lastRefill = now
else
  local elapsed = math.max(0, now - lastRefill)
  local replenished = 0
  if refillRate > 0 then
    replenished = (elapsed / 1000.0) * refillRate
  end
  currentTokens = math.min(capacity, currentTokens + replenished)
  lastRefill = now
end

if currentTokens >= cost then
  currentTokens = currentTokens - cost
  redis.call('HMSET', KEYS[1], 'tokens', tostring(currentTokens), 'lastRefill', tostring(lastRefill))
  redis.call('EXPIRE', KEYS[1], ttl)
  return {1, math.floor(currentTokens), 0}
else
  local needed = cost - currentTokens
  local retryAfterMs = 0
  if refillRate > 0 then
    retryAfterMs = math.ceil((needed / refillRate) * 1000.0)
  else
    retryAfterMs = ttl * 1000
  end
  redis.call('HMSET', KEYS[1], 'tokens', tostring(currentTokens), 'lastRefill', tostring(lastRefill))
  redis.call('EXPIRE', KEYS[1], ttl)
  return {0, math.floor(currentTokens), retryAfterMs}
end
`;

export const DEFAULT_RESERVATION_TTL_SECONDS = 900; // 15 minutes default for long-running conversions

export interface TokenBucketOptions {
  capacity?: number;
  refillRate?: number;
  cost?: number;
  ttlSeconds?: number;
}

export interface TokenBucketResult {
  allowed: boolean;
  remainingTokens: number;
  retryAfterMs: number;
  serviceUnavailable?: boolean;
  error?: string;
}

/**
 * Redis-backed Key Store with atomic Lua script metering and 2-phase quota transactions
 * (Reserve-Commit/Rollback) preventing TOCTOU races in distributed environments.
 */
export class RedisKeyStore extends KeyStore {
  protected static sharedReservations = new Map<string, QuotaReservation>();
  protected static sharedTokenBuckets = new Map<string, { tokens: number; lastRefill: number }>();
  private readonly reservations: Map<string, QuotaReservation>;
  private readonly tokenBuckets: Map<string, { tokens: number; lastRefill: number }>;
  private readonly keyPrefix: string;
  private redisClient: Redis | null = null;

  constructor(
    keyPrefixOrOptions: string | RedisKeyStoreOptions = 'easyconvert:',
    isolated = false
  ) {
    let prefix = 'easyconvert:';
    let isIsolated = isolated;
    let client: Redis | undefined = undefined;

    if (typeof keyPrefixOrOptions === 'object') {
      prefix = keyPrefixOrOptions.keyPrefix || 'easyconvert:';
      isIsolated = keyPrefixOrOptions.isolated ?? isolated;
      client = keyPrefixOrOptions.redisClient;
      if (!client) {
        const host = keyPrefixOrOptions.redisHost || process.env.REDIS_HOST;
        const url = keyPrefixOrOptions.redisUrl || process.env.REDIS_URL;
        const port =
          keyPrefixOrOptions.redisPort ||
          (process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : 6379);
        if (url) {
          try {
            client = new Redis(url, {
              lazyConnect: true,
              enableOfflineQueue: false,
              maxRetriesPerRequest: 1,
            });
          } catch {}
        } else if (host) {
          try {
            client = new Redis({
              host,
              port,
              lazyConnect: true,
              enableOfflineQueue: false,
              maxRetriesPerRequest: 1,
            });
          } catch {}
        }
      }
    } else {
      prefix = keyPrefixOrOptions;
      const host = process.env.REDIS_HOST;
      const url = process.env.REDIS_URL;
      const port = process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : 6379;
      if (url) {
        try {
          client = new Redis(url, {
            lazyConnect: true,
            enableOfflineQueue: false,
            maxRetriesPerRequest: 1,
          });
        } catch {}
      } else if (host) {
        try {
          client = new Redis({
            host,
            port,
            lazyConnect: true,
            enableOfflineQueue: false,
            maxRetriesPerRequest: 1,
          });
        } catch {}
      }
    }

    super(isIsolated);
    this.keyPrefix = prefix;
    this.reservations = isIsolated ? new Map() : RedisKeyStore.sharedReservations;
    this.tokenBuckets = isIsolated ? new Map() : RedisKeyStore.sharedTokenBuckets;
    this.redisClient = client ?? null;
  }

  public getRedisClient(): Redis | null {
    return this.redisClient;
  }

  public setRedisClient(client: Redis | null): void {
    this.redisClient = client;
  }

  public getPrefix(): string {
    return this.keyPrefix;
  }

  public getReservation(reservationId: string): QuotaReservation | undefined {
    return this.reservations.get(reservationId);
  }

  public getActiveReservationsCount(): number {
    this.cleanExpiredReservations();
    return this.reservations.size;
  }

  public cleanExpiredReservations(): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, res] of this.reservations.entries()) {
      if (res.expiresAt <= now && res.status === 'reserved') {
        const dateKey = res.dateKey || `${res.userId}:${getUtcDateKey()}`;
        const currentUsed = this.dailyUsage.get(dateKey) ?? 0;
        this.dailyUsage.set(dateKey, Math.max(0, currentUsed - res.units));
        this.reservations.delete(id);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.persist();
    }
    return cleaned;
  }

  public override async getQuotaUsage(userId: string) {
    this.cleanExpiredReservations();

    if (this.redisClient) {
      try {
        const isAnonymous = userId.startsWith('anon:');
        const user = isAnonymous ? null : await redisUserStore.findById(userId);
        const tier: UserTier = user?.tier || 'free';
        const dailyLimit = isAnonymous ? getAnonymousDailyLimit() : TIER_LIMITS[tier];
        const usageKey = `${this.keyPrefix}usage:{${userId}}:${getUtcDateKey()}`;
        const val = await this.redisClient.get(usageKey);
        const usedToday = val ? parseInt(val, 10) || 0 : 0;
        const remaining = Math.max(0, dailyLimit - usedToday);
        const resetAt = getNextMidnightUtc();

        return {
          tier,
          dailyLimit,
          usedToday,
          remaining,
          resetAt,
        };
      } catch (err) {
        console.error('[RedisKeyStore] Redis getQuotaUsage failed:', err);
        throw new Error('Distributed quota service is temporarily unavailable');
      }
    }

    return super.getQuotaUsage(userId);
  }

  /**
   * Directly deduces quota atomically without 2-phase reservations.
   */
  public async deductQuota(
    userId: string,
    units: number = 1
  ): Promise<{ allowed: boolean; remaining: number; error?: string; serviceUnavailable?: boolean }> {
    if (
      !userId ||
      typeof userId !== 'string' ||
      userId.trim().length === 0 ||
      !Number.isFinite(units) ||
      units < 0
    ) {
      return { allowed: false, remaining: 0 };
    }
    this.cleanExpiredReservations();
    this.ensureInitialized();
    const isAnonymous = userId.startsWith('anon:');
    const user = isAnonymous ? null : await redisUserStore.findById(userId);
    const tier: UserTier = user?.tier ?? 'free';
    const dailyLimit = isAnonymous ? getAnonymousDailyLimit() : TIER_LIMITS[tier];

    if (this.redisClient) {
      try {
        const usageKey = `${this.keyPrefix}usage:{${userId}}:${getUtcDateKey()}`;
        const midnight = new Date();
        midnight.setUTCHours(24, 0, 0, 0);
        const expireAtMidnightSec = Math.max(60, Math.floor((midnight.getTime() - Date.now()) / 1000));

        const result = (await this.redisClient.eval(
          DEDUCT_QUOTA_LUA_SCRIPT,
          1,
          usageKey,
          units,
          dailyLimit,
          expireAtMidnightSec
        )) as [number, number];

        return {
          allowed: Number(result[0]) === 1,
          remaining: Number(result[1]),
        };
      } catch (err) {
        console.error('[RedisKeyStore] Redis deductQuota failed:', err);
        return {
          allowed: false,
          remaining: 0,
          error: 'Distributed quota service is temporarily unavailable',
          serviceUnavailable: true,
        };
      }
    }

    const dateKey = `${userId}:${getUtcDateKey()}`;
    const currentUsed = this.dailyUsage.get(dateKey) ?? 0;

    if (units === 0) {
      return {
        allowed: dailyLimit - currentUsed > 0,
        remaining: Math.max(0, dailyLimit - currentUsed),
      };
    }

    if (currentUsed + units <= dailyLimit) {
      this.dailyUsage.set(dateKey, currentUsed + units);
      this.persist();
      return { allowed: true, remaining: dailyLimit - (currentUsed + units) };
    }
    return { allowed: false, remaining: Math.max(0, dailyLimit - currentUsed) };
  }

  /**
   * 2-Phase Quota Transaction: Phase 1 (Reserve)
   * Atomically verifies and reserves quota units before executing expensive distributed jobs.
   */
  public async reserveQuota(
    userId: string,
    units: number = 1
  ): Promise<{ allowed: boolean; reservationId?: string; remaining: number; error?: string; serviceUnavailable?: boolean }> {
    if (
      !userId ||
      typeof userId !== 'string' ||
      userId.trim().length === 0 ||
      !Number.isFinite(units) ||
      units < 0
    ) {
      return { allowed: false, remaining: 0 };
    }
    this.cleanExpiredReservations();
    this.ensureInitialized();

    const isAnonymous = userId.startsWith('anon:');
    const user = isAnonymous ? null : await redisUserStore.findById(userId);
    const tier: UserTier = user?.tier ?? 'free';
    const dailyLimit = isAnonymous ? getAnonymousDailyLimit() : TIER_LIMITS[tier];

    if (this.redisClient) {
      try {
        const usageKey = `${this.keyPrefix}usage:{${userId}}:${getUtcDateKey()}`;
        const reservationId = `res_${encodeURIComponent(userId)}_${getUtcDateKey()}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
        const resKey = `${this.keyPrefix}res:{${userId}}:${reservationId}`;
        const ttlSec = DEFAULT_RESERVATION_TTL_SECONDS;
        const midnight = new Date();
        midnight.setUTCHours(24, 0, 0, 0);
        const expireAtMidnightSec = Math.max(60, Math.floor((midnight.getTime() - Date.now()) / 1000));

        const result = (await this.redisClient.eval(
          RESERVE_QUOTA_LUA_SCRIPT,
          2,
          usageKey,
          resKey,
          units,
          dailyLimit,
          ttlSec,
          expireAtMidnightSec
        )) as [number, number];

        const allowed = Number(result[0]) === 1;
        const remaining = Number(result[1]);

        if (allowed) {
          const reservation: QuotaReservation = {
            reservationId,
            userId,
            units,
            dateKey: `${userId}:${getUtcDateKey()}`,
            createdAt: Date.now(),
            expiresAt: Date.now() + ttlSec * 1000,
            status: 'reserved',
          };
          this.reservations.set(reservationId, reservation);
          return { allowed: true, reservationId, remaining };
        }
        return { allowed: false, remaining };
      } catch (err) {
        console.error('[RedisKeyStore] Redis reserveQuota failed:', err);
        return {
          allowed: false,
          remaining: 0,
          error: 'Distributed quota service is temporarily unavailable',
          serviceUnavailable: true,
        };
      }
    }

    const dateKey = `${userId}:${getUtcDateKey()}`;
    const currentUsed = this.dailyUsage.get(dateKey) ?? 0;

    if (units === 0) {
      return {
        allowed: dailyLimit - currentUsed > 0,
        remaining: Math.max(0, dailyLimit - currentUsed),
      };
    }

    if (currentUsed + units > dailyLimit) {
      return {
        allowed: false,
        remaining: Math.max(0, dailyLimit - currentUsed),
      };
    }

    // Atomic increment in reservation phase
    this.dailyUsage.set(dateKey, currentUsed + units);
    const reservationId = `res_${encodeURIComponent(userId)}_${getUtcDateKey()}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
    const reservation: QuotaReservation = {
      reservationId,
      userId,
      units,
      dateKey,
      createdAt: Date.now(),
      expiresAt: Date.now() + DEFAULT_RESERVATION_TTL_SECONDS * 1000, // 15-minute reservation timeout
      status: 'reserved',
    };
    this.reservations.set(reservationId, reservation);
    this.persist();

    return {
      allowed: true,
      reservationId,
      remaining: Math.max(0, dailyLimit - (currentUsed + units)),
    };
  }

  /**
   * Extends the TTL of an active reservation (heartbeat renewal for long-running async jobs).
   */
  public async renewReservation(
    reservationId: string,
    ttlSeconds: number = DEFAULT_RESERVATION_TTL_SECONDS
  ): Promise<boolean> {
    if (!reservationId || typeof reservationId !== 'string') return false;

    if (this.redisClient) {
      try {
        const res = this.reservations.get(reservationId);
        let userId = res?.userId;
        if (!userId) {
          const parts = reservationId.split('_');
          if (parts.length >= 5 && parts[0] === 'res') {
            userId = decodeURIComponent(parts[1]);
          }
        }
        const finalUserId = userId || 'unknown';
        const resKey = `${this.keyPrefix}res:{${finalUserId}}:${reservationId}`;
        const renewed = await this.redisClient.eval(RENEW_RESERVATION_LUA_SCRIPT, 1, resKey, ttlSeconds);
        const isSuccess = Number(renewed) > 0;
        if (isSuccess && res) {
          res.expiresAt = Date.now() + ttlSeconds * 1000;
        }
        return isSuccess;
      } catch (err) {
        console.error('[RedisKeyStore] Redis renewReservation failed:', err);
        return false;
      }
    }

    const res = this.reservations.get(reservationId);
    if (!res || res.status !== 'reserved') return false;
    res.expiresAt = Date.now() + ttlSeconds * 1000;
    return true;
  }

  /**
   * 2-Phase Quota Transaction: Phase 2a (Commit)
   * Confirms successful task completion and finalizes the reservation.
   */
  public async commitQuota(reservationId: string): Promise<boolean> {
    if (!reservationId || typeof reservationId !== 'string') return false;

    if (this.redisClient) {
      try {
        const res = this.reservations.get(reservationId);
        let userId = res?.userId;
        if (!userId) {
          const parts = reservationId.split('_');
          if (parts.length >= 5 && parts[0] === 'res') {
            userId = decodeURIComponent(parts[1]);
          }
        }
        const finalUserId = userId || 'unknown';
        const resKey = `${this.keyPrefix}res:{${finalUserId}}:${reservationId}`;
        const deleted = await this.redisClient.eval(COMMIT_QUOTA_LUA_SCRIPT, 1, resKey);
        this.reservations.delete(reservationId);
        return Number(deleted) > 0;
      } catch {
        // Fallback
      }
    }

    const res = this.reservations.get(reservationId);
    if (!res || res.status !== 'reserved') return false;

    res.status = 'committed';
    this.reservations.delete(reservationId);
    return true;
  }

  /**
   * 2-Phase Quota Transaction: Phase 2c (Settle with actual units)
   * Adjusts the reserved quota to the actual consumed units (refunding surplus or charging deficit)
   * and finalizes the reservation.
   */
  public async settleQuota(
    reservationId: string,
    actualUnits: number
  ): Promise<{ success: boolean; difference: number }> {
    if (!reservationId || typeof reservationId !== 'string') {
      return { success: false, difference: 0 };
    }
    const safeUnits = Math.max(0, Number.isFinite(actualUnits) ? Math.floor(actualUnits) : 0);

    if (this.redisClient) {
      try {
        const res = this.reservations.get(reservationId);
        let userId = res?.userId;
        let dateKey = res?.dateKey ? res.dateKey.split(':')[1] : undefined;
        if (!userId || !dateKey) {
          const parts = reservationId.split('_');
          if (parts.length >= 5 && parts[0] === 'res') {
            userId = decodeURIComponent(parts[1]);
            dateKey = parts[2];
          }
        }
        const finalUserId = userId || 'unknown';
        const finalDateKey = dateKey || getUtcDateKey();
        const usageKey = `${this.keyPrefix}usage:{${finalUserId}}:${finalDateKey}`;
        const resKey = `${this.keyPrefix}res:{${finalUserId}}:${reservationId}`;

        const result = (await this.redisClient.eval(
          SETTLE_QUOTA_LUA_SCRIPT,
          2,
          usageKey,
          resKey,
          safeUnits
        )) as [number, number];

        this.reservations.delete(reservationId);
        return {
          success: Number(result[0]) === 1,
          difference: Number(result[1]),
        };
      } catch {
        // Fallback
      }
    }

    const res = this.reservations.get(reservationId);
    if (!res || res.status !== 'reserved') {
      return { success: false, difference: 0 };
    }

    const diff = safeUnits - res.units;
    const dateKey = res.dateKey || `${res.userId}:${getUtcDateKey()}`;
    const currentUsed = this.dailyUsage.get(dateKey) ?? 0;
    this.dailyUsage.set(dateKey, Math.max(0, currentUsed + diff));

    res.status = 'committed';
    this.reservations.delete(reservationId);
    this.persist();

    return { success: true, difference: diff };
  }

  /**
   * 2-Phase Quota Transaction: Phase 2b (Rollback / Refund)
   * Rolls back reserved quota units when a conversion fails or times out.
   */
  public async rollbackQuota(reservationId: string): Promise<boolean> {
    if (!reservationId || typeof reservationId !== 'string') return false;

    if (this.redisClient) {
      try {
        const res = this.reservations.get(reservationId);
        let userId = res?.userId;
        let dateKey = res?.dateKey ? res.dateKey.split(':')[1] : undefined;
        if (!userId || !dateKey) {
          const parts = reservationId.split('_');
          if (parts.length >= 5 && parts[0] === 'res') {
            userId = decodeURIComponent(parts[1]);
            dateKey = parts[2];
          }
        }
        const finalUserId = userId || 'unknown';
        const finalDateKey = dateKey || getUtcDateKey();
        const usageKey = `${this.keyPrefix}usage:{${finalUserId}}:${finalDateKey}`;
        const resKey = `${this.keyPrefix}res:{${finalUserId}}:${reservationId}`;
        const rolled = await this.redisClient.eval(ROLLBACK_QUOTA_LUA_SCRIPT, 2, usageKey, resKey);
        this.reservations.delete(reservationId);
        return Number(rolled) > 0;
      } catch {
        // Fallback
      }
    }

    const res = this.reservations.get(reservationId);
    if (!res || res.status !== 'reserved') return false;

    const dateKey = res.dateKey || `${res.userId}:${getUtcDateKey()}`;
    const currentUsed = this.dailyUsage.get(dateKey) ?? 0;
    this.dailyUsage.set(dateKey, Math.max(0, currentUsed - res.units));

    res.status = 'rolled_back';
    this.reservations.delete(reservationId);
    this.persist();
    return true;
  }

  public override async generateApiKey(
    userId: string,
    name: string,
    options: ApiKeyCreateOptions = {}
  ): Promise<ApiKeyCreateResult> {
    const result = await super.generateApiKey(userId, name, options);
    if (this.redisClient) {
      try {
        const key = result.key;
        const keyPrefix = this.keyPrefix;
        const hashPayload = {
          id: key.id,
          userId: key.userId,
          status: key.status,
          keyHash: key.keyHash,
          previousKeyHash: key.previousKeyHash || '',
          data: JSON.stringify(key),
        };
        await this.redisClient.hset(`${keyPrefix}apikeys:${key.id}`, hashPayload);
        await this.redisClient.hset(`${keyPrefix}apikey_hashes`, key.keyHash, key.id);
        await this.redisClient.sadd(`${keyPrefix}user_keys:${userId}`, key.id);
      } catch (err) {
        console.warn('[RedisKeyStore] Failed to write key to Redis:', err);
      }
    }
    return result;
  }

  public override async verifyApiKey(
    secretKey: string,
    clientIp?: string
  ): Promise<{ valid: boolean; key?: ApiKey; user?: User; error?: string }> {
    if (this.redisClient) {
      try {
        if (!secretKey || typeof secretKey !== 'string') {
          return { valid: false, error: 'Missing or invalid API key' };
        }
        const candidates = apiKeyHashCandidates(secretKey.trim());
        const keyIds = await this.redisClient.hmget(`${this.keyPrefix}apikey_hashes`, ...candidates.hashes);
        const keyId = keyIds.find((id): id is string => typeof id === 'string' && id.length > 0);

        if (keyId) {
          const hashData = await this.redisClient.hgetall(`${this.keyPrefix}apikeys:${keyId}`);
          if (hashData && hashData.data) {
            const key = JSON.parse(hashData.data) as ApiKey;
            key.status = (hashData.status as 'active' | 'revoked') || key.status;

            // Enforce multi-instance instant revocation
            if (key.status !== 'active') {
              const local = this.keys.get(keyId);
              if (local) local.status = 'revoked';
              return { valid: false, error: 'API key has been revoked' };
            }

            if (key.expiresAt && Date.now() > key.expiresAt) {
              return { valid: false, error: 'API key has expired' };
            }

            if (key.previousKeyHash && candidates.hashes.includes(key.previousKeyHash)) {
              if (key.graceExpiresAt && Date.now() > key.graceExpiresAt) {
                return { valid: false, error: 'Previous API key has expired following key rotation' };
              }
            }

            if (key.allowedIps && key.allowedIps.length > 0 && clientIp && !isIpAllowed(clientIp, key.allowedIps)) {
              return { valid: false, error: 'Client IP address is not permitted by API key IP whitelist' };
            }

            const userRecord = await redisUserStore.findById(key.userId);
            if (!userRecord) {
              return { valid: false, error: 'User associated with API key not found' };
            }

            if (hashData.lastExpiryNotifiedAt) {
              key.lastExpiryNotifiedAt = Number(hashData.lastExpiryNotifiedAt);
            }

            // Asynchronously record lastUsedAt
            key.lastUsedAt = Date.now();
            this.redisClient
              .hset(`${this.keyPrefix}apikeys:${keyId}`, 'lastUsedAt', String(key.lastUsedAt))
              .catch(() => {});

            // Update local memory cache
            this.keys.set(key.id, key);

            return {
              valid: true,
              key: {
                ...key,
                webhookSecret: decryptSecret(key.webhookSecret),
              },
              user: redisUserStore.sanitizeUser(userRecord),
            };
          }
        }
      } catch (err) {
        console.warn('[RedisKeyStore] Redis verifyApiKey failed, falling back to local memory:', err);
      }
    }

    const localResult = await super.verifyApiKey(secretKey, clientIp);
    if (localResult.valid && localResult.key && this.redisClient) {
      try {
        const remoteStatus = await this.redisClient.hget(`${this.keyPrefix}apikeys:${localResult.key.id}`, 'status');
        if (remoteStatus === 'revoked') {
          localResult.key.status = 'revoked';
          const cached = this.keys.get(localResult.key.id);
          if (cached) cached.status = 'revoked';
          return { valid: false, error: 'API key has been revoked' };
        }
      } catch {}
    }
    return localResult;
  }

  public override async revokeApiKey(userId: string, keyId: string): Promise<boolean> {
    if (this.redisClient) {
      try {
        const exists = await this.redisClient.hexists(`${this.keyPrefix}apikeys:${keyId}`, 'userId');
        if (exists) {
          const ownerId = await this.redisClient.hget(`${this.keyPrefix}apikeys:${keyId}`, 'userId');
          if (ownerId && ownerId !== userId) {
            return false;
          }
          await this.redisClient.hset(`${this.keyPrefix}apikeys:${keyId}`, 'status', 'revoked');
        }
      } catch (err) {
        console.warn('[RedisKeyStore] Redis revokeApiKey failed:', err);
      }
    }
    return super.revokeApiKey(userId, keyId);
  }

  public override async rotateApiKey(
    userId: string,
    keyId: string,
    options: ApiKeyRotateOptions = {}
  ): Promise<ApiKeyRotateResult | null> {
    const result = await super.rotateApiKey(userId, keyId, options);
    if (result && this.redisClient) {
      try {
        await this.redisClient.hset(`${this.keyPrefix}apikeys:${keyId}`, {
          data: JSON.stringify(result.key),
          keyHash: result.key.keyHash,
          previousKeyHash: result.key.previousKeyHash || '',
          graceExpiresAt: String(result.graceExpiresAt),
        });
        await this.redisClient.hset(`${this.keyPrefix}apikey_hashes`, result.key.keyHash, keyId);
        if (result.key.previousKeyHash) {
          await this.redisClient.hset(`${this.keyPrefix}apikey_hashes`, result.key.previousKeyHash, keyId);
        }
      } catch (err) {
        console.warn('[RedisKeyStore] Redis rotateApiKey sync failed:', err);
      }
    }
    return result;
  }

  public override async updateApiKey(
    userId: string,
    keyId: string,
    updates: ApiKeyUpdateOptions
  ): Promise<ApiKey | null> {
    const updated = await super.updateApiKey(userId, keyId, updates);
    if (updated && this.redisClient) {
      try {
        await this.redisClient.hset(`${this.keyPrefix}apikeys:${keyId}`, 'data', JSON.stringify(updated));
      } catch (err) {
        console.warn('[RedisKeyStore] Redis updateApiKey sync failed:', err);
      }
    }
    return updated;
  }

  public override async deleteApiKey(userId: string, keyId: string): Promise<boolean> {
    if (this.redisClient) {
      try {
        const keyData = await this.redisClient.hgetall(`${this.keyPrefix}apikeys:${keyId}`);
        if (keyData.keyHash) {
          await this.redisClient.hdel(`${this.keyPrefix}apikey_hashes`, keyData.keyHash);
        }
        if (keyData.previousKeyHash) {
          await this.redisClient.hdel(`${this.keyPrefix}apikey_hashes`, keyData.previousKeyHash);
        }
        await this.redisClient.srem(`${this.keyPrefix}user_keys:${userId}`, keyId);
        await this.redisClient.del(`${this.keyPrefix}apikeys:${keyId}`);
      } catch (err) {
        console.warn('[RedisKeyStore] Redis deleteApiKey failed:', err);
      }
    }
    return super.deleteApiKey(userId, keyId);
  }

  public override async listApiKeys(userId: string): Promise<ApiKey[]> {
    if (this.redisClient) {
      try {
        const keyIds = await this.redisClient.smembers(`${this.keyPrefix}user_keys:${userId}`);
        if (keyIds.length > 0) {
          const pipeline = this.redisClient.pipeline();
          for (const id of keyIds) {
            pipeline.hgetall(`${this.keyPrefix}apikeys:${id}`);
          }
          const results = await pipeline.exec();
          if (results) {
            const keys: ApiKey[] = [];
            for (const [err, data] of results) {
              if (!err && data && typeof data === 'object' && 'data' in data) {
                const parsed = JSON.parse((data as Record<string, string>).data) as ApiKey;
                parsed.status = ((data as Record<string, string>).status as 'active' | 'revoked') || parsed.status;
                keys.push({
                  ...parsed,
                  webhookSecret: decryptSecret(parsed.webhookSecret),
                });
              }
            }
            if (keys.length > 0) {
              return keys.sort((a, b) => b.createdAt - a.createdAt);
            }
          }
        }
      } catch (err) {
        console.warn('[RedisKeyStore] Redis listApiKeys failed, falling back to local memory:', err);
      }
    }
    return super.listApiKeys(userId);
  }

  public override markKeyExpiryNotified(keyId: string, timestamp: number): void {
    super.markKeyExpiryNotified(keyId, timestamp);
    if (this.redisClient) {
      this.redisClient.hset(`${this.keyPrefix}apikeys:${keyId}`, 'lastExpiryNotifiedAt', String(timestamp)).catch(() => {});
    }
  }

  public async close(): Promise<void> {
    if (this.redisClient) {
      try {
        await this.redisClient.quit();
      } catch {
        this.redisClient.disconnect();
      }
      this.redisClient = null;
    }
  }


  public override async recordUsage(
    userId: string,
    units: number = 1
  ): Promise<{ allowed: boolean; remaining: number }> {
    const res = await this.reserveQuota(userId, units);
    if (!res.allowed) {
      return { allowed: false, remaining: res.remaining };
    }
    if (res.reservationId) {
      await this.commitQuota(res.reservationId);
    }
    return { allowed: true, remaining: res.remaining };
  }

  public override resetStore() {
    this.reservations.clear();
    super.resetStore();
  }

  public override async recordUserFile(data: {
    userId: string;
    fileName: string;
    fromFormat: string;
    toFormat: string;
    size: number;
    downloadUrl: string;
    ttlMs?: number;
  }): Promise<UserConversionFile> {
    this.ensureInitialized();
    const now = Date.now();
    const ttl = data.ttlMs ?? 3600 * 1000;
    const file: UserConversionFile = {
      id: crypto.randomUUID(),
      userId: data.userId,
      fileName: data.fileName,
      fromFormat: data.fromFormat,
      toFormat: data.toFormat,
      size: data.size,
      downloadUrl: data.downloadUrl,
      createdAt: now,
      expiresAt: now + ttl,
    };

    this.userFiles.set(file.id, file);
    this.persist();
    return file;
  }

  /**
   * Evaluates burst rate limit using an atomic Token Bucket algorithm.
   * If Redis is connected, executes TOKEN_BUCKET_RATE_LIMIT_LUA_SCRIPT.
   * In local/fallback mode, performs atomic in-memory token bucket calculations.
   */
  public async checkTokenBucketRateLimit(
    identifier: string,
    options: TokenBucketOptions = {}
  ): Promise<TokenBucketResult> {
    const capacity = options.capacity ?? 50;
    const refillRate = options.refillRate ?? 10;
    const cost = options.cost ?? 1;
    const ttl = options.ttlSeconds ?? 3600;
    const now = Date.now();

    if (this.redisClient) {
      try {
        const key = `${this.keyPrefix}rate:${identifier}`;
        const res = (await this.redisClient.eval(
          TOKEN_BUCKET_RATE_LIMIT_LUA_SCRIPT,
          1,
          key,
          capacity.toString(),
          refillRate.toString(),
          cost.toString(),
          ttl.toString(),
          now.toString()
        )) as [number, number, number];

        return {
          allowed: res[0] === 1,
          remainingTokens: Number(res[1]),
          retryAfterMs: Number(res[2]),
        };
      } catch (err) {
        console.error('[RedisKeyStore] Redis rate limit Lua failed:', err);
        return {
          allowed: false,
          remainingTokens: 0,
          retryAfterMs: 5000,
          serviceUnavailable: true,
          error: 'Distributed rate limit service is temporarily unavailable',
        };
      }
    }

    // In-memory token bucket
    let state = this.tokenBuckets.get(identifier);
    if (!state) {
      state = { tokens: capacity, lastRefill: now };
    } else {
      const elapsed = Math.max(0, now - state.lastRefill);
      const replenished = refillRate > 0 ? (elapsed / 1000) * refillRate : 0;
      state.tokens = Math.min(capacity, state.tokens + replenished);
      state.lastRefill = now;
    }

    if (state.tokens >= cost) {
      state.tokens -= cost;
      this.tokenBuckets.set(identifier, state);
      return {
        allowed: true,
        remainingTokens: Math.floor(state.tokens),
        retryAfterMs: 0,
      };
    } else {
      const needed = cost - state.tokens;
      const retryAfterMs = refillRate > 0 ? Math.ceil((needed / refillRate) * 1000) : ttl * 1000;
      this.tokenBuckets.set(identifier, state);
      return {
        allowed: false,
        remainingTokens: Math.floor(state.tokens),
        retryAfterMs,
      };
    }
  }
}

export const redisKeyStore = new RedisKeyStore();

export async function renewReservation(
  reservationId: string,
  ttlSeconds?: number
): Promise<boolean> {
  return redisKeyStore.renewReservation(reservationId, ttlSeconds);
}

export async function checkTokenBucketRateLimit(
  identifier: string,
  options?: TokenBucketOptions
): Promise<TokenBucketResult & { tokensRemaining: number; resetMs: number }> {
  const result = await redisKeyStore.checkTokenBucketRateLimit(identifier, options);
  return {
    ...result,
    tokensRemaining: result.remainingTokens,
    resetMs: result.retryAfterMs,
  };
}
