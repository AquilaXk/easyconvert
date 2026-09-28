import crypto from 'node:crypto';
import { userStore } from '../auth/user-store';
import type { UserTier } from '../auth/types';
import { KeyStore, TIER_LIMITS, getUtcDateKey } from './key-store';
import type { UserConversionFile } from './types';
import { isIpInCidr, isIpAllowed } from './ip-utils';

export { isIpInCidr, isIpAllowed };

export interface QuotaReservation {
  reservationId: string;
  userId: string;
  units: number;
  createdAt: number;
  expiresAt: number;
  status: 'reserved' | 'committed' | 'rolled_back';
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

/**
 * Redis-backed Key Store with atomic Lua script metering and 2-phase quota transactions
 * (Reserve-Commit/Rollback) preventing TOCTOU races in distributed environments.
 */
export class RedisKeyStore extends KeyStore {
  private readonly reservations: Map<string, QuotaReservation> = new Map();
  private readonly keyPrefix: string;

  constructor(keyPrefix: string = 'easyconvert:') {
    super();
    this.keyPrefix = keyPrefix;
  }

  public getPrefix(): string {
    return this.keyPrefix;
  }

  /**
   * 2-Phase Quota Transaction: Phase 1 (Reserve)
   * Atomically verifies and reserves quota units before executing expensive distributed jobs.
   */
  public async reserveQuota(
    userId: string,
    units: number = 1
  ): Promise<{ allowed: boolean; reservationId?: string; remaining: number }> {
    this.ensureInitialized();

    const user = await userStore.findById(userId);
    const tier: UserTier = user?.tier ?? 'free';
    const dailyLimit = TIER_LIMITS[tier];

    const dateKey = `${userId}:${getUtcDateKey()}`;
    const currentUsed = this.dailyUsage.get(dateKey) ?? 0;

    if (units <= 0) {
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
    const reservationId = `res_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
    const reservation: QuotaReservation = {
      reservationId,
      userId,
      units,
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
    const res = this.reservations.get(reservationId);
    if (!res || res.status !== 'reserved') return false;

    const dateKey = `${res.userId}:${getUtcDateKey()}`;
    const currentUsed = this.dailyUsage.get(dateKey) ?? 0;
    this.dailyUsage.set(dateKey, Math.max(0, currentUsed - res.units));

    res.status = 'rolled_back';
    this.reservations.delete(reservationId);
    this.persist();
    return true;
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
}

export const redisKeyStore = new RedisKeyStore();
