import crypto from 'node:crypto';
import Redis from 'ioredis';
import { afterEach, beforeEach, describe, vi } from 'vitest';
import { RedisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { itKeepsCredits } from './helpers/credit-ledger-cases';

/**
 * The credit ledger is Lua scripts over real keys (src/lib/api-keys/quota-lua-scripts.ts), so the same cases as
 * tests/credit-ledger.test.ts run on a real Redis server. Like the other Redis suites it runs when REDIS_URL is set
 * (for example `REDIS_URL=redis://127.0.0.1:6379`).
 */
const REDIS_URL = process.env.REDIS_URL;

describe.skipIf(!REDIS_URL)('the credit ledger on a real Redis server', () => {
  let admin: Redis;
  let keyPrefix = '';
  let store: RedisKeyStore;

  /**
   * The keys of the suite as Redis sees them `ms` later: each lease ends `ms` sooner, each key's time to live shrinks by `ms`, and a key
   * whose time runs out is gone. The scripts read the time of the Redis server, which no test can move, so this stands in for waiting.
   */
  async function advanceKeyClock(ms: number) {
    for (const key of await admin.keys(`${keyPrefix}*`)) {
      if ((await admin.type(key)) === 'zset') {
        const leases = await admin.zrange(key, '0', '-1', 'WITHSCORES');
        for (let i = 0; i < leases.length; i += 2) await admin.zadd(key, Number(leases[i + 1]) - ms, leases[i]);
      }
      const left = await admin.pttl(key);
      if (left < 0) continue;
      if (left <= ms) await admin.del(key);
      else await admin.pexpire(key, left - ms);
    }
  }

  beforeEach(() => {
    keyPrefix = `credit-ledger-${crypto.randomBytes(6).toString('hex')}:`;
    admin = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
    store = new RedisKeyStore({ keyPrefix, isolated: true, redisClient: new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 }) });
  });

  afterEach(async () => {
    const keys = await admin.keys(`${keyPrefix}*`);
    if (keys.length > 0) await admin.del(...keys);
    await store.close();
    await admin.quit();
  });

  itKeepsCredits({
    store: () => store,
    advance: async (ms) => {
      vi.setSystemTime(Date.now() + ms);
      await advanceKeyClock(ms);
    },
  });
});
