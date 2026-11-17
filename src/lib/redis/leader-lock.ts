import crypto from 'node:crypto';
import { redisKeyStore } from '../api-keys/redis-key-store';

/**
 * Lightweight Redis leader lock for periodic background sweeps (retention, ended-job cleanup) across
 * multi-replica Web and Worker clusters.
 *
 * Uses the same atomic token-checked release / post-completion hold pattern as `SubscriptionStore.releaseLock`
 * (`src/lib/billing/subscription-store.ts:55-59`): a sweep that completes keeps the lock closed for
 * `holdAfterSuccessMs` so peer replicas whose timers fire moments later skip duplicate Redis ZSET scans,
 * while a failed sweep releases the lock immediately (`0`) so another replica can retry.
 */

const RELEASE_OR_HOLD_LOCK_LUA = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if tonumber(ARGV[2]) > 0 then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return redis.call('DEL', KEYS[1])
`;

const localSweepLocks = new Map<string, { token: string; until: number }>();

export async function withRedisLeaderLock(
  lockName: string,
  leaseTtlMs: number,
  holdAfterSuccessMs: number,
  task: () => Promise<unknown>
): Promise<boolean> {
  const token = crypto.randomUUID();
  const now = Date.now();
  const redis = redisKeyStore.getRedisClient();

  if (
    !redis ||
    typeof (redis as { set?: unknown }).set !== 'function' ||
    typeof (redis as { eval?: unknown }).eval !== 'function'
  ) {
    const existing = localSweepLocks.get(lockName);
    if (existing && existing.until > now) return false;
    localSweepLocks.set(lockName, { token, until: now + leaseTtlMs });
    let succeeded = false;
    try {
      await task();
      succeeded = true;
      return true;
    } finally {
      const current = localSweepLocks.get(lockName);
      if (current?.token === token) {
        if (succeeded && holdAfterSuccessMs > 0) {
          current.until = Date.now() + holdAfterSuccessMs;
        } else {
          localSweepLocks.delete(lockName);
        }
      }
    }
  }

  const key = `${redisKeyStore.getPrefix()}sweep_lock:${lockName}`;
  const acquired = await redis.set(key, token, 'PX', Math.max(1000, Math.floor(leaseTtlMs)), 'NX');
  if (acquired !== 'OK') {
    return false;
  }

  let succeeded = false;
  try {
    await task();
    succeeded = true;
    return true;
  } finally {
    const holdMs = succeeded ? Math.max(0, Math.floor(holdAfterSuccessMs)) : 0;
    await redis.eval(RELEASE_OR_HOLD_LOCK_LUA, 1, key, token, String(holdMs)).catch(() => undefined);
  }
}

export function resetLocalSweepLocksForTests(): void {
  localSweepLocks.clear();
}
