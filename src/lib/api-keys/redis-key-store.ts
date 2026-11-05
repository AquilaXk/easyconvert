import crypto from 'node:crypto';
import Redis from 'ioredis';
import { redisUserStore } from '../auth/redis-user-store';
import { isAnonymousUserId } from '../auth/anonymous-identity';
import type { UserTier } from '../auth/types';
import { KeyStore, TIER_LIMITS, getAnonymousDailyLimit, getUtcDateKey, getNextMidnightUtc, apiKeyHashCandidates } from './key-store';
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
import { resolveRetentionPolicy } from '../storage/result-retention';
import { readyGatedRedis } from '../redis/when-ready';
import { DEDUCT_QUOTA_LUA_SCRIPT, TOKEN_BUCKET_RATE_LIMIT_LUA_SCRIPT } from './quota-lua-scripts';
import {
  MemoryReservationLedger,
  RESERVATION_LEASE,
  RedisReservationLedger,
  reservationIdOf,
  parseReservationId,
  type QuotaExtension,
  type ReservationLedger,
} from './reservation-ledger';

export { isIpInCidr, isIpAllowed };
export type { QuotaExtension };

export interface RedisKeyStoreOptions {
  keyPrefix?: string;
  isolated?: boolean;
  redisHost?: string;
  redisPort?: number;
  redisUrl?: string;
  redisClient?: Redis;
}

/** How long a request burst counter lives after the last request it counted, unless the caller sets `ttlSeconds`. */
export const TOKEN_BUCKET_TTL_SECONDS = 3600;

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

interface RedisEndpoint {
  url?: string;
  host?: string;
  port?: number;
}

/** The fail-fast client for the configured Redis, connecting now and waiting for the connection before each command. */
function connectFromEnvironment(endpoint: RedisEndpoint): Redis | undefined {
  const url = endpoint.url || process.env.REDIS_URL;
  const host = endpoint.host || process.env.REDIS_HOST;
  const port = endpoint.port || (process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : 6379);
  const failFast = { enableOfflineQueue: false, maxRetriesPerRequest: 1 };
  try {
    if (url) return readyGatedRedis(new Redis(url, failFast));
    if (host) return readyGatedRedis(new Redis({ host, port, ...failFast }));
  } catch {}
  return undefined;
}

/** Seconds from now until the UTC day ends, at least a minute: the lifetime of the day's count and of its reservations. */
function secondsUntilUtcMidnight(): number {
  const midnight = new Date();
  midnight.setUTCHours(24, 0, 0, 0);
  return Math.max(60, Math.floor((midnight.getTime() - Date.now()) / 1000));
}

export const RECORD_VERIFIED_KEY_LUA_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
if ARGV[3] ~= '' then
  local hashField = (ARGV[6] ~= nil and ARGV[6] ~= '') and ARGV[6] or 'keyHash'
  redis.call('HSET', KEYS[1], hashField, ARGV[3], 'data', ARGV[2], 'lastUsedAt', ARGV[1])
  redis.call('HSET', KEYS[2], ARGV[3], ARGV[5])
  if ARGV[4] ~= '' and ARGV[4] ~= ARGV[3] then
    redis.call('HDEL', KEYS[2], ARGV[4])
  end
elseif ARGV[2] ~= '' then
  redis.call('HSET', KEYS[1], 'data', ARGV[2], 'lastUsedAt', ARGV[1])
else
  redis.call('HSET', KEYS[1], 'lastUsedAt', ARGV[1])
end
return 1
`;

/**
 * Redis-backed Key Store with atomic Lua script metering and 2-phase quota transactions
 * (Reserve-Commit/Rollback) preventing TOCTOU races in distributed environments.
 */
export class RedisKeyStore extends KeyStore {
  private static sharedLedger: MemoryReservationLedger | undefined;
  private readonly memoryLedger: MemoryReservationLedger;
  /** The ledger in Redis, made once for the client it was made with. */
  private redisLedger: { client: Redis; ledger: RedisReservationLedger } | undefined;
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
        client = connectFromEnvironment({
          url: keyPrefixOrOptions.redisUrl,
          host: keyPrefixOrOptions.redisHost,
          port: keyPrefixOrOptions.redisPort,
        });
      }
    } else {
      prefix = keyPrefixOrOptions;
      client = connectFromEnvironment({});
    }

    super(isIsolated);
    this.keyPrefix = prefix;
    const persist = () => this.persist();
    this.memoryLedger = isIsolated
      ? new MemoryReservationLedger(this.dailyUsage, persist)
      : (RedisKeyStore.sharedLedger ??= new MemoryReservationLedger(this.dailyUsage, persist));
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

  /** The ledger of the reservations: in Redis when the store has it, else in this process. */
  private ledger(): ReservationLedger {
    const client = this.redisClient;
    if (!client) return this.memoryLedger;
    if (this.redisLedger?.client !== client) this.redisLedger = { client, ledger: new RedisReservationLedger(client, this.keyPrefix) };
    return this.redisLedger.ledger;
  }

  /** Gives back the in-memory reservations whose lease ended; Redis gives back its own in every step. */
  public cleanExpiredReservations(): number {
    return this.redisClient ? 0 : this.memoryLedger.reclaim();
  }

  public override async getQuotaUsage(userId: string) {
    this.cleanExpiredReservations();

    if (this.redisClient) {
      try {
        const isAnonymous = isAnonymousUserId(userId);
        const user = isAnonymous ? null : await redisUserStore.findById(userId);
        const tier: UserTier = user?.tier || 'free';
        const dailyLimit = isAnonymous ? getAnonymousDailyLimit() : TIER_LIMITS[tier];
        const usedToday = await this.ledger().used(userId, getUtcDateKey());
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
    const isAnonymous = isAnonymousUserId(userId);
    const user = isAnonymous ? null : await redisUserStore.findById(userId);
    const tier: UserTier = user?.tier ?? 'free';
    const dailyLimit = isAnonymous ? getAnonymousDailyLimit() : TIER_LIMITS[tier];

    if (this.redisClient) {
      try {
        const usageKey = `${this.keyPrefix}usage:{${userId}}:${getUtcDateKey()}`;
        const result = (await this.redisClient.eval(
          DEDUCT_QUOTA_LUA_SCRIPT,
          1,
          usageKey,
          units,
          dailyLimit,
          secondsUntilUtcMidnight()
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
   * Atomically verifies and reserves quota units before executing expensive distributed jobs. The reservation is a
   * provisional lease (`RESERVATION_LEASE`): its holder renews it while it runs, or hands it to queued work, else its units
   * come back once the lease ends. Whatever ends it later acts on the UTC day it was made on.
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
    this.ensureInitialized();

    const dailyLimit = await this.dailyLimitOf(userId);
    // One day for the whole reservation: its count, its id and its record never straddle midnight.
    const day = getUtcDateKey();
    try {
      if (units === 0) {
        const remaining = Math.max(0, dailyLimit - (await this.ledger().used(userId, day)));
        return { allowed: remaining > 0, remaining };
      }
      const reservationId = reservationIdOf(userId, day);
      const request = { owner: userId, day, dayLeftMs: getNextMidnightUtc() - Date.now(), reservationId, units, limit: dailyLimit, leaseMs: RESERVATION_LEASE.provisionalMs };
      const reserved = await this.ledger().reserve(request);
      return reserved.allowed ? { allowed: true, reservationId, remaining: reserved.remaining } : { allowed: false, remaining: Math.max(0, reserved.remaining) };
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

  /** The conversions `userId` may have each day: the anonymous allowance, or the limit of the account's tier. */
  private async dailyLimitOf(userId: string): Promise<number> {
    if (isAnonymousUserId(userId)) return getAnonymousDailyLimit();
    const tier: UserTier = (await redisUserStore.findById(userId))?.tier ?? 'free';
    return TIER_LIMITS[tier];
  }

  /**
   * Holds `units` more in the live reservation `reservationId` for the extension `extensionId`, when they fit under the
   * owner's daily limit: what the extension holds in all, so a repeated call adds only the difference. A reservation that
   * ended, or whose day's count is gone, is not extended and no count is written for it.
   */
  public async extendQuota(reservationId: string, extensionId: string, units: number): Promise<QuotaExtension> {
    const named = parseReservationId(reservationId);
    const extension: QuotaExtension = named
      ? await this.ledger().extend(reservationId, extensionId, units, await this.dailyLimitOf(named.userId))
      : { status: 'no-reservation' };
    if (extension.status === 'no-reservation') console.warn(`[RedisKeyStore] Extension ${extensionId} found no live reservation ${reservationId}`);
    return extension;
  }

  /**
   * Moves the end of the lease of the live reservation `reservationId` to `leaseMs` from now, when that is later than it
   * is: a request renews its provisional lease while it runs, and hands the long one to the queued work that ends it.
   * Answers false when the reservation is gone. A failure in Redis throws.
   */
  public async renewReservation(reservationId: string, leaseMs: number): Promise<boolean> {
    return this.ledger().renew(reservationId, leaseMs);
  }

  /**
   * Runs one step that ends a reservation. A failed step is logged and reported as undefined: the count in Redis is unknown,
   * and nothing here tries it again.
   */
  private async endReservation<T>(action: string, reservationId: string, step: (ledger: ReservationLedger) => Promise<T>): Promise<T | undefined> {
    if (!reservationId || typeof reservationId !== 'string') return undefined;
    try {
      return await step(this.ledger());
    } catch (err) {
      console.error(`[RedisKeyStore] Redis ${action} of reservation ${reservationId} failed:`, err);
      return undefined;
    }
  }

  /**
   * 2-Phase Quota Transaction: Phase 2a (Commit)
   * Confirms successful task completion and finalizes the reservation.
   */
  public async commitQuota(reservationId: string): Promise<boolean> {
    const committed = await this.endReservation('commit', reservationId, (ledger) => ledger.commit(reservationId));
    if (committed === false) console.warn(`[RedisKeyStore] Commit found no live reservation ${reservationId}`);
    return committed === true;
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
    const safeUnits = Math.max(0, Number.isFinite(actualUnits) ? Math.floor(actualUnits) : 0);
    const settled = await this.endReservation('settle', reservationId, (ledger) => ledger.settle(reservationId, safeUnits));
    if (settled?.success === false) console.warn(`[RedisKeyStore] Settle found no live reservation ${reservationId}`);
    return settled ?? { success: false, difference: 0 };
  }

  /**
   * 2-Phase Quota Transaction: Phase 2b (Rollback / Refund)
   * Rolls back reserved quota units when a conversion fails or times out.
   */
  public async rollbackQuota(reservationId: string): Promise<boolean> {
    return (await this.endReservation('rollback', reservationId, (ledger) => ledger.rollback(reservationId))) === true;
  }

  public override async generateApiKey(
    userId: string,
    name: string,
    options: ApiKeyCreateOptions = {}
  ): Promise<ApiKeyCreateResult> {
    const result = await super.generateApiKey(userId, name, options);
    if (this.redisClient) {
      try {
        const key = this.keys.get(result.key.id) ?? result.key;
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

  private async recordVerifiedKeyInRedis(
    keyId: string,
    key: ApiKey,
    candidates: { hashes: string[]; currentHash: string },
    matchedPreviousKey: boolean
  ): Promise<void> {
    this.ensureInitialized();
    const oldKeyHash = key.keyHash;
    const oldPreviousKeyHash = key.previousKeyHash;
    const migrated = matchedPreviousKey
      ? this.migratePreviousKeyHash(key, candidates.currentHash)
      : this.migrateKeyHash(key, candidates.currentHash);
    const keyHashChanged = !matchedPreviousKey && key.keyHash !== oldKeyHash;
    const prevHashChanged =
      matchedPreviousKey && Boolean(key.previousKeyHash) && key.previousKeyHash !== oldPreviousKeyHash;

    key.lastUsedAt = Date.now();
    const existing = this.keys.get(key.id);
    const localDiffers =
      !existing ||
      existing.keyHash !== key.keyHash ||
      existing.previousKeyHash !== key.previousKeyHash ||
      existing.status !== key.status ||
      existing.webhookSecret !== key.webhookSecret ||
      existing.graceExpiresAt !== key.graceExpiresAt;
    this.upsertKeyInMemory(key);
    if (migrated || localDiffers) {
      this.persist();
    }

    if (!this.redisClient) return;
    if (migrated) {
      const hashFieldArg = prevHashChanged ? 'previousKeyHash' : 'keyHash';
      const newHashArg = keyHashChanged
        ? key.keyHash
        : prevHashChanged && key.previousKeyHash
          ? key.previousKeyHash
          : '';
      const oldHashArg = keyHashChanged
        ? oldKeyHash !== key.previousKeyHash
          ? oldKeyHash
          : ''
        : prevHashChanged && oldPreviousKeyHash && oldPreviousKeyHash !== key.keyHash
          ? oldPreviousKeyHash
          : '';
      if (typeof (this.redisClient as { eval?: unknown }).eval === 'function') {
        await this.redisClient.eval(
          RECORD_VERIFIED_KEY_LUA_SCRIPT,
          2,
          `${this.keyPrefix}apikeys:${keyId}`,
          `${this.keyPrefix}apikey_hashes`,
          String(key.lastUsedAt),
          JSON.stringify(key),
          newHashArg,
          oldHashArg,
          key.id,
          hashFieldArg
        );
      } else {
        if (newHashArg) {
          await this.redisClient.hset(`${this.keyPrefix}apikey_hashes`, newHashArg, key.id);
          if (oldHashArg && oldHashArg !== newHashArg) {
            await this.redisClient.hdel(`${this.keyPrefix}apikey_hashes`, oldHashArg);
          }
        }
        await this.redisClient.hset(`${this.keyPrefix}apikeys:${keyId}`, {
          keyHash: key.keyHash,
          previousKeyHash: key.previousKeyHash || '',
          data: JSON.stringify(key),
          lastUsedAt: String(key.lastUsedAt),
        });
      }
      return;
    }
    this.redisClient
      .hset(`${this.keyPrefix}apikeys:${keyId}`, 'lastUsedAt', String(key.lastUsedAt))
      .catch(() => {});
  }

  public override async verifyApiKey(
    secretKey: string,
    clientIp?: string
  ): Promise<{ valid: boolean; key?: ApiKey; user?: User; error?: string }> {
    this.ensureInitialized();
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

            if (key.status !== 'active') {
              const local = this.keys.get(keyId);
              if (local && local.status !== 'revoked') {
                local.status = 'revoked';
                this.persist();
              }
              return { valid: false, error: 'API key has been revoked' };
            }

            if (key.expiresAt && Date.now() > key.expiresAt) {
              return { valid: false, error: 'API key has expired' };
            }

            const matchedCurrentKey = candidates.hashes.includes(key.keyHash);
            const matchedPreviousKey =
              !matchedCurrentKey && Boolean(key.previousKeyHash && candidates.hashes.includes(key.previousKeyHash));
            if (matchedCurrentKey || matchedPreviousKey) {
              if (matchedPreviousKey) {
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

              await this.recordVerifiedKeyInRedis(keyId, key, candidates, matchedPreviousKey);

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
        }
        const staleIds = new Set<string>();
        if (keyId) {
          staleIds.add(keyId);
        }
        for (const h of candidates.hashes) {
          const mappedId = this.keyHashIndex.get(h);
          if (mappedId) {
            staleIds.add(mappedId);
          }
          this.keyHashIndex.delete(h);
        }
        for (const [id, localKey] of this.keys.entries()) {
          if (
            candidates.hashes.includes(localKey.keyHash) ||
            (localKey.previousKeyHash && candidates.hashes.includes(localKey.previousKeyHash))
          ) {
            staleIds.add(id);
          }
        }
        for (const staleId of staleIds) {
          await this.syncKeyFromRedis(staleId);
        }
        return { valid: false, error: 'Invalid or non-existent API key' };
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
          if (cached && cached.status !== 'revoked') {
            cached.status = 'revoked';
            this.persist();
          }
          return { valid: false, error: 'API key has been revoked' };
        }
      } catch {}
    }
    return localResult;
  }

  public override async revokeApiKey(userId: string, keyId: string): Promise<boolean> {
    await this.syncKeyFromRedis(keyId);
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

  private async syncKeyFromRedis(keyId: string): Promise<void> {
    this.ensureInitialized();
    if (!this.redisClient) return;
    try {
      const hashData = await this.redisClient.hgetall(`${this.keyPrefix}apikeys:${keyId}`);
      const existing = this.keys.get(keyId);
      if (hashData && hashData.data) {
        const parsed = JSON.parse(hashData.data) as ApiKey;
        parsed.status = (hashData.status as 'active' | 'revoked') || parsed.status;
        this.upsertKeyInMemory(parsed);
        this.persist();
      } else if (existing) {
        this.keyHashIndex.delete(existing.keyHash);
        if (existing.previousKeyHash) {
          this.keyHashIndex.delete(existing.previousKeyHash);
        }
        this.keys.delete(keyId);
        this.persist();
      }
    } catch {}
  }

  public override async rotateApiKey(
    userId: string,
    keyId: string,
    options: ApiKeyRotateOptions = {}
  ): Promise<ApiKeyRotateResult | null> {
    await this.syncKeyFromRedis(keyId);
    const outgoingPreviousHash = this.keys.get(keyId)?.previousKeyHash;
    const result = await super.rotateApiKey(userId, keyId, options);
    if (result && this.redisClient) {
      try {
        const storedKey = this.keys.get(keyId) ?? result.key;
        await this.redisClient.hset(`${this.keyPrefix}apikeys:${keyId}`, {
          data: JSON.stringify(storedKey),
          keyHash: storedKey.keyHash,
          previousKeyHash: storedKey.previousKeyHash || '',
          graceExpiresAt: String(result.graceExpiresAt),
        });
        await this.redisClient.hset(`${this.keyPrefix}apikey_hashes`, storedKey.keyHash, keyId);
        if (storedKey.previousKeyHash) {
          await this.redisClient.hset(`${this.keyPrefix}apikey_hashes`, storedKey.previousKeyHash, keyId);
        }
        if (
          outgoingPreviousHash &&
          outgoingPreviousHash !== storedKey.keyHash &&
          outgoingPreviousHash !== storedKey.previousKeyHash
        ) {
          await this.redisClient.hdel(`${this.keyPrefix}apikey_hashes`, outgoingPreviousHash);
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
    await this.syncKeyFromRedis(keyId);
    const updated = await super.updateApiKey(userId, keyId, updates);
    if (updated && this.redisClient) {
      try {
        const storedKey = this.keys.get(keyId) ?? updated;
        await this.redisClient.hset(`${this.keyPrefix}apikeys:${keyId}`, 'data', JSON.stringify(storedKey));
      } catch (err) {
        console.warn('[RedisKeyStore] Redis updateApiKey sync failed:', err);
      }
    }
    return updated;
  }

  public override async deleteApiKey(userId: string, keyId: string): Promise<boolean> {
    this.ensureInitialized();
    const localKey = this.keys.get(keyId);
    if (localKey && localKey.userId !== userId) {
      return false;
    }
    let deletedInRedis = false;
    if (this.redisClient) {
      try {
        const keyData = await this.redisClient.hgetall(`${this.keyPrefix}apikeys:${keyId}`);
        const ownerId = keyData.userId ?? localKey?.userId;
        if (ownerId !== userId) {
          return false;
        }
        if (keyData.keyHash) {
          await this.redisClient.hdel(`${this.keyPrefix}apikey_hashes`, keyData.keyHash);
        }
        if (keyData.previousKeyHash) {
          await this.redisClient.hdel(`${this.keyPrefix}apikey_hashes`, keyData.previousKeyHash);
        }
        await this.redisClient.srem(`${this.keyPrefix}user_keys:${userId}`, keyId);
        await this.redisClient.del(`${this.keyPrefix}apikeys:${keyId}`, `${this.keyPrefix}rate:apikey:${keyId}`);
        this.tokenBuckets.delete(`apikey:${keyId}`);
        deletedInRedis = Boolean(keyData.userId);
      } catch (err) {
        console.warn('[RedisKeyStore] Redis deleteApiKey failed:', err);
      }
    }
    const deletedLocal = await super.deleteApiKey(userId, keyId);
    return deletedInRedis || deletedLocal;
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

  public override forgetUsage(userId: string): number {
    this.memoryLedger.forgetOwner(userId);
    for (const key of this.tokenBuckets.keys()) {
      if (key === userId || key.startsWith(`${userId}:`) || key.endsWith(`:${userId}`)) {
        this.tokenBuckets.delete(key);
      }
    }
    return super.forgetUsage(userId);
  }

  public override resetStore() {
    this.memoryLedger.clear();
    this.tokenBuckets.clear();
    super.resetStore();
  }

  public override async recordUserFile(data: {
    userId: string;
    fileName: string;
    fromFormat: string;
    toFormat: string;
    size: number;
    downloadUrl: string;
    storageKey?: string;
    ttlMs?: number;
  }): Promise<UserConversionFile> {
    this.ensureInitialized();
    const now = Date.now();
    const ttl = data.ttlMs ?? resolveRetentionPolicy().undeliveredTtlMs;
    const file: UserConversionFile = {
      id: crypto.randomUUID(),
      userId: data.userId,
      fileName: data.fileName,
      fromFormat: data.fromFormat,
      toFormat: data.toFormat,
      size: data.size,
      downloadUrl: data.downloadUrl,
      storageKey: data.storageKey,
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
    const ttl = options.ttlSeconds ?? TOKEN_BUCKET_TTL_SECONDS;
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
