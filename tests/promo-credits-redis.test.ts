import crypto from 'node:crypto';
import Redis from 'ioredis';
import { afterEach, beforeEach, describe, vi } from 'vitest';
import { RedisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { itKeepsPromoCredits } from './helpers/promo-credit-cases';

/**
 * Promotional credits are Lua scripts over real keys (src/lib/api-keys/quota-lua-scripts.ts), so the same cases as
 * tests/promo-credits.test.ts run on a real Redis server. Like the other Redis suites it runs when REDIS_URL is set
 * (for example `REDIS_URL=redis://127.0.0.1:6379`).
 */
const REDIS_URL = process.env.REDIS_URL;

// skip-ok: mode selection. The shards run without REDIS_URL; the Redis-mode CI step (npm run test:redis) sets it and runs this file.
describe.skipIf(!REDIS_URL)('promotional credits on a real Redis server', () => {
  let admin: Redis;
  let keyPrefix = '';
  let store: RedisKeyStore;

  /**
   * The keys of the suite as Redis sees them `ms` later: each lease ends `ms` sooner, each key's time to live shrinks by `ms`, a key whose
   * time runs out is gone, and each grant starts and ends `ms` sooner. The scripts read the time of the Redis server, which no test can
   * move, so this stands in for waiting.
   */
  async function advanceKeyClock(ms: number) {
    for (const key of await admin.keys(`${keyPrefix}*`)) {
      const type = await admin.type(key);
      if (type === 'zset') {
        const leases = await admin.zrange(key, '0', '-1', 'WITHSCORES');
        for (let i = 0; i < leases.length; i += 2) await admin.zadd(key, Number(leases[i + 1]) - ms, leases[i]);
      }
      if (type === 'hash' && key.startsWith(`${keyPrefix}promo:{`) && !key.endsWith(':qholds')) {
        for (const [campaignId, raw] of Object.entries(await admin.hgetall(key))) {
          const grant = JSON.parse(raw) as Record<string, number>;
          for (const field of ['granted_at', 'expires_at', 'voided_at']) if (grant[field] !== undefined) grant[field] = (grant[field] as number) - ms;
          await admin.hset(key, campaignId, JSON.stringify(grant));
        }
      }
      const left = await admin.pttl(key);
      if (left < 0) continue;
      if (left <= ms) await admin.del(key);
      else await admin.pexpire(key, left - ms);
    }
  }

  beforeEach(() => {
    keyPrefix = `promo-credits-${crypto.randomBytes(6).toString('hex')}:`;
    admin = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
    store = new RedisKeyStore({ keyPrefix, isolated: true, redisClient: new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 }) });
  });

  afterEach(async () => {
    const keys = await admin.keys(`${keyPrefix}*`);
    if (keys.length > 0) await admin.del(...keys);
    await store.close();
    await admin.quit();
  });

  itKeepsPromoCredits({
    store: () => store,
    advance: async (ms) => {
      vi.setSystemTime(Date.now() + ms);
      await advanceKeyClock(ms);
    },
    now: async () => {
      const [seconds, micros] = await admin.time();
      return Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
    },
  });
});
