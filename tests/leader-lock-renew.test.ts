import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { resetLocalSweepLocksForTests, withRedisLeaderLock } from '../src/lib/redis/leader-lock';

/**
 * A task that outlives the lease of its leader lock lets a second process start the same job, so a long task renews the lease as it
 * goes. The lease is at least 1 second on Redis; without REDIS_URL the lock is held in this process. The Redis-mode CI step
 * (npm run test:redis) runs the same cases against a real Redis.
 */

const LEASE_MS = 1000;
const LONGER_THAN_LEASE_MS = 1300;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let name: string;
beforeEach(() => {
  resetLocalSweepLocksForTests();
  name = `renew-test-${crypto.randomBytes(6).toString('hex')}`;
});
afterEach(async () => {
  await redisKeyStore.getRedisClient()?.del(`${redisKeyStore.getPrefix()}sweep_lock:${name}`);
});

describe('renewing the lease of a leader lock', () => {
  it('lets a second process in once the lease ran out, when the task did not renew it', async () => {
    let second = true;
    await withRedisLeaderLock(name, LEASE_MS, 0, async () => {
      await pause(LONGER_THAN_LEASE_MS);
      second = await withRedisLeaderLock(name, LEASE_MS, 0, async () => undefined);
    });
    expect(second).toBe(true);
  });

  it('keeps a second process out for as long as the task renews it', async () => {
    let second = true;
    let renewed: boolean[] = [];
    await withRedisLeaderLock(name, LEASE_MS, 0, async (renew) => {
      await pause(LONGER_THAN_LEASE_MS / 2);
      renewed.push(await renew());
      await pause(LONGER_THAN_LEASE_MS / 2);
      renewed.push(await renew());
      await pause(LONGER_THAN_LEASE_MS / 2);
      second = await withRedisLeaderLock(name, LEASE_MS, 0, async () => undefined);
    });
    expect(renewed).toEqual([true, true]);
    expect(second).toBe(false);
  });

  it('says false when the lock was lost, and does not take it back from its new holder', async () => {
    let lost = true;
    let holderRan = false;
    await withRedisLeaderLock(name, LEASE_MS, 0, async (renew) => {
      await pause(LONGER_THAN_LEASE_MS);
      holderRan = await withRedisLeaderLock(name, 60_000, 0, async (renewOther) => {
        lost = await renew();
        expect(await renewOther()).toBe(true);
      });
    });
    expect(holderRan).toBe(true);
    expect(lost).toBe(false);
  });
});
