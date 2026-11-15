import crypto from 'node:crypto';
import type { NextResponse } from 'next/server';
import type Redis from 'ioredis';
import type { UserTier } from '../auth/types';
import { createProblemDetailsResponse } from '../api/problem-details';
import { DEFAULT_FREE_CONCURRENCY, PLAN_CONCURRENCY, isUserTier } from '../plan-limits';
import { conversionQueue } from './conversion-queue';
import { readIntegerSetting } from './job-deadline';
import { redisKeyStore } from '../api-keys/redis-key-store';

/**
 * How many conversions a caller may have in flight (queued plus running): five for an anonymous or free caller
 * (`CONVERSION_CONCURRENCY_FREE`) and 25 for an account with package credits or a subscription (`CONVERSION_CONCURRENCY_PAID`;
 * entries 280 and 285). The count is made on the server: queued and running jobs
 * come from the job queue (its index of jobs by user, shared by every web process), synchronous conversions from the
 * slots held by the requests of this process (or Redis ZSET lease across distributed instances). A request over the limit is answered 429 and takes no quota.
 */

/** The variable that sets the limit of each tier. */
export const CONCURRENCY_LIMIT_ENV = {
  free: 'CONVERSION_CONCURRENCY_FREE',
  paid: 'CONVERSION_CONCURRENCY_PAID',
} as const satisfies Record<UserTier, string>;
export { DEFAULT_FREE_CONCURRENCY };
export const CONCURRENCY_LIMIT_PROBLEM_TYPE = 'https://api.easyconvert.io/problems/concurrency-limit';
/** Seconds a refused caller is told to wait before trying again. */
export const CONCURRENCY_RETRY_AFTER_SECONDS = 5;

const FREE_TIER = 'free';
const IN_FLIGHT_STATES = ['waiting', 'active', 'delayed'] as const;
const HTTP_TOO_MANY_REQUESTS = 429;
export const SYNC_SLOT_LEASE_MS = 120_000;

export const ACQUIRE_SYNC_SLOT_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local expiresAt = tonumber(ARGV[2])
local slotId = ARGV[3]
local limit = tonumber(ARGV[4])
local queued = tonumber(ARGV[5]) or 0

redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
local current = redis.call('ZCARD', key)
if (current + queued) >= limit then
  return 0
end
redis.call('ZADD', key, expiresAt, slotId)
redis.call('PEXPIRE', key, 3600000)
return 1
`;

export function syncSlotKey(userId: string): string {
  return `sync_slots:{${userId}}`;
}

let customRedisClient: Redis | null = null;

export function setSyncSlotRedisClient(client: Redis | null): void {
  customRedisClient = client;
}

function resolveRedisClient(): Redis | null {
  return customRedisClient ?? redisKeyStore.getRedisClient();
}

/** The limit for a caller of `tier`: a missing or unknown tier is an anonymous or free caller's. */
export function concurrencyLimitFor(tier: string | undefined, env: Record<string, string | undefined> = process.env): number {
  const normalized = (tier ?? FREE_TIER).toLowerCase();
  const known: UserTier = isUserTier(normalized) ? normalized : FREE_TIER;
  return readIntegerSetting(env, CONCURRENCY_LIMIT_ENV[known], PLAN_CONCURRENCY[known]);
}

const syncInFlight = new Map<string, number>();

/** Synchronous conversions in flight in this process (all callers); for tests and diagnostics. */
export function syncSlotsInUse(): number {
  let total = 0;
  for (const count of syncInFlight.values()) total += count;
  return total;
}

async function queuedJobs(userId: string, limit: number): Promise<number> {
  if (typeof conversionQueue.countJobsByUser === 'function') {
    return conversionQueue.countJobsByUser(userId, [...IN_FLIGHT_STATES], limit);
  }
  const jobs = await conversionQueue.getJobsByUser(userId, [...IN_FLIGHT_STATES], limit, 0);
  return jobs.length;
}

function takeSyncSlot(userId: string): () => void {
  syncInFlight.set(userId, (syncInFlight.get(userId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (syncInFlight.get(userId) ?? 1) - 1;
    if (left > 0) syncInFlight.set(userId, left);
    else syncInFlight.delete(userId);
  };
}

export type ConversionSlot = { granted: true; release: () => void } | { granted: false; limit: number };

/** Takes a slot for a synchronous conversion of `userId`, held until `release` is called. Not granted when the caller already has `limit` conversions in flight. */
export async function acquireSyncSlot(userId: string, tier: string | undefined): Promise<ConversionSlot> {
  const limit = concurrencyLimitFor(tier);
  const redis = resolveRedisClient();

  if (redis) {
    const queued = await queuedJobs(userId, limit);
    const now = Date.now();
    const expiresAt = now + SYNC_SLOT_LEASE_MS;
    const slotId = `${now}_${crypto.randomUUID()}`;
    const key = syncSlotKey(userId);

    try {
      const res = (await redis.eval(
        ACQUIRE_SYNC_SLOT_LUA,
        1,
        key,
        String(now),
        String(expiresAt),
        slotId,
        String(limit),
        String(queued)
      )) as number;

      if (res === 0) {
        return { granted: false, limit };
      }

      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        redis.zrem(key, slotId).catch(() => {});
      };
      return { granted: true, release };
    } catch {
      // If Redis eval fails, fall back to in-memory slot
    }
  }

  // In-memory fallback
  const release = takeSyncSlot(userId);
  try {
    const mine = syncInFlight.get(userId) ?? 1;
    if (mine > limit || mine + (await queuedJobs(userId, limit)) > limit) {
      release();
      return { granted: false, limit };
    }
  } catch (error) {
    release();
    throw error;
  }
  return { granted: true, release };
}

/** Whether `userId` may put one more job on the queue; false when it already has `limit` conversions in flight. */
export async function mayEnqueue(userId: string, tier: string | undefined): Promise<{ allowed: true } | { allowed: false; limit: number }> {
  const limit = concurrencyLimitFor(tier);
  const redis = resolveRedisClient();
  let syncCount = syncInFlight.get(userId) ?? 0;

  if (redis) {
    try {
      const now = Date.now();
      const key = syncSlotKey(userId);
      await redis.zremrangebyscore(key, '-inf', now);
      syncCount = await redis.zcard(key);
    } catch {
      // fallback to memory
    }
  }

  const inFlight = syncCount + (await queuedJobs(userId, limit));
  return inFlight >= limit ? { allowed: false, limit } : { allowed: true };
}

/** The 429 problem response of a caller over its limit. */
export function concurrencyLimitResponse(limit: number, instance: string, extraHeaders: Record<string, string> = {}): NextResponse {
  return createProblemDetailsResponse(
    HTTP_TOO_MANY_REQUESTS,
    `This account already has ${limit} conversions in progress. Wait for one to finish, then try again.`,
    instance,
    'Too Many Requests',
    CONCURRENCY_LIMIT_PROBLEM_TYPE,
    { ...extraHeaders, 'Retry-After': String(CONCURRENCY_RETRY_AFTER_SECONDS) },
    undefined,
    { limit }
  );
}
