import crypto from 'node:crypto';
import Redis from 'ioredis';
import { redisUserStore } from '../auth/redis-user-store';
import type { UserTier } from '../auth/types';
import { KeyStore, TIER_LIMITS, getUtcDateKey } from './key-store';
import type { UserConversionFile } from './types';
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
-- ARGV[1]: current timestamp in milliseconds
-- ARGV[2]: bucket capacity (max burst tokens)
-- ARGV[3]: refill rate (tokens added per second)
-- ARGV[4]: cost (tokens required for this request)
-- ARGV[5]: key TTL in seconds
local now = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local refillRate = tonumber(ARGV[3])
local cost = tonumber(ARGV[4] or '1')
local ttl = tonumber(ARGV[5] or '3600')

local data = redis.call('HMGET', KEYS[1], 'tokens', 'lastRefill')
local currentTokens = tonumber(data[1])
local lastRefill = tonumber(data[2])

if not currentTokens or not lastRefill then
  currentTokens = capacity
  lastRefill = now
else
  local elapsed = math.max(0, now - lastRefill)
  local replenished = (elapsed / 1000.0) * refillRate
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
  local retryAfterMs = math.ceil((needed / refillRate) * 1000.0)
  redis.call('HMSET', KEYS[1], 'tokens', tostring(currentTokens), 'lastRefill', tostring(lastRefill))
  redis.call('EXPIRE', KEYS[1], ttl)
  return {0, math.floor(currentTokens), retryAfterMs}
end
`;

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
    return super.getQuotaUsage(userId);
  }

  /**
   * Directly deduces quota atomically without 2-phase reservations.
   */
  public async deductQuota(
    userId: string,
    units: number = 1
  ): Promise<{ allowed: boolean; remaining: number }> {
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
    const user = await redisUserStore.findById(userId);
    const tier: UserTier = user?.tier ?? 'free';
    const dailyLimit = TIER_LIMITS[tier];

    if (this.redisClient) {
      try {
        const usageKey = `${this.keyPrefix}usage:${userId}:${getUtcDateKey()}`;
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
      } catch {
        // Fallback to in-memory on redis connection failure
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
  ): Promise<{ allowed: boolean; reservationId?: string; remaining: number }> {
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

    const user = await redisUserStore.findById(userId);
    const tier: UserTier = user?.tier ?? 'free';
    const dailyLimit = TIER_LIMITS[tier];

    if (this.redisClient) {
      try {
        const usageKey = `${this.keyPrefix}usage:${userId}:${getUtcDateKey()}`;
        const reservationId = `res_${encodeURIComponent(userId)}_${getUtcDateKey()}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
        const resKey = `${this.keyPrefix}res:${reservationId}`;
        const ttlSec = 300;
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
      } catch {
        // Fallback to in-memory on redis connection failure
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
      expiresAt: Date.now() + 5 * 60 * 1000, // 5-minute reservation timeout
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
   * 2-Phase Quota Transaction: Phase 2a (Commit)
   * Confirms successful task completion and finalizes the reservation.
   */
  public async commitQuota(reservationId: string): Promise<boolean> {
    if (!reservationId || typeof reservationId !== 'string') return false;

    if (this.redisClient) {
      try {
        const resKey = `${this.keyPrefix}res:${reservationId}`;
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
        const usageKey = `${this.keyPrefix}usage:${finalUserId}:${finalDateKey}`;
        const resKey = `${this.keyPrefix}res:${reservationId}`;
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
          now.toString(),
          capacity.toString(),
          refillRate.toString(),
          cost.toString(),
          ttl.toString()
        )) as [number, number, number];

        return {
          allowed: res[0] === 1,
          remainingTokens: Number(res[1]),
          retryAfterMs: Number(res[2]),
        };
      } catch (err) {
        console.warn('Redis rate limit Lua failed, falling back to local memory:', err);
      }
    }

    // In-memory token bucket
    let state = this.tokenBuckets.get(identifier);
    if (!state) {
      state = { tokens: capacity, lastRefill: now };
    } else {
      const elapsed = Math.max(0, now - state.lastRefill);
      const replenished = (elapsed / 1000) * refillRate;
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
      const retryAfterMs = Math.ceil((needed / refillRate) * 1000);
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
