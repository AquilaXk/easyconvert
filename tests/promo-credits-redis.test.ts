import crypto from 'node:crypto';
import Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GRANT_PROMO_LUA_SCRIPT, RESERVE_PROMO_BUDGET_LUA_SCRIPT } from '../src/lib/api-keys/quota-lua-scripts';
import { RedisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { RedisReservationLedger, type PromoGrantRequest } from '../src/lib/api-keys/reservation-ledger';
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

  /** A client on its own connection whose write of the account's grant waits until `release` is called; `reached` resolves when it got there. */
  function clientHoldingGrantWrite() {
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const arrived = new Promise<void>((resolve) => (reached = resolve));
    const client = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
    const held = new Proxy(client, {
      get(target, property) {
        if (property === 'eval') {
          return async (script: string, ...rest: unknown[]) => {
            if (script === GRANT_PROMO_LUA_SCRIPT) {
              reached();
              await gate;
            }
            return (target.eval as (...args: unknown[]) => Promise<unknown>).call(target, script, ...rest);
          };
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    return { client, ledger: new RedisReservationLedger(held, keyPrefix), release, arrived };
  }

  it('keeps the count of a campaign as it is when two connections grant the same account at the same moment, the second step of the first coming last', async () => {
    const owner = `race_${crypto.randomBytes(6).toString('hex')}`;
    const request: PromoGrantRequest = { campaignId: 'two-conns', amount: 10, priority: 0, reason: 'test', actor: 'test', at: Date.now() };
    const slow = clientHoldingGrantWrite();
    const fast = new RedisReservationLedger(admin, keyPrefix);
    try {
      // A counts the account and stops before it writes the grant; B finds the account counted, writes the grant and answers; then A writes and finds it there.
      const first = slow.ledger.grantPromo(owner, request, 100);
      await slow.arrived;
      expect(await fast.grantPromo(owner, request, 100)).toBe('granted');
      slow.release();
      expect(await first).toBe('duplicate');

      expect(await fast.promoCampaign('two-conns')).toMatchObject({ budget: 100, granted: 10, count: 1 });
      expect((await fast.promoCampaignOwners('two-conns', '0')).owners).toEqual([owner]);
      expect(await fast.promoGrants(owner)).toEqual([expect.objectContaining({ campaignId: 'two-conns', amount: 10, remaining: 10 })]);
      // The campaign still holds the account for the full void and the report, and the budget is not given back: another 9 accounts fit and the 10th does not.
      const others = Array.from({ length: 10 }, (_, index) => `${owner}_${index}`);
      const outcomes: string[] = [];
      for (const other of others) outcomes.push(await fast.grantPromo(other, request, 100));
      expect(outcomes.filter((outcome) => outcome === 'granted')).toHaveLength(9);
      expect(outcomes.filter((outcome) => outcome === 'budget-exhausted')).toHaveLength(1);
      expect(await fast.promoCampaign('two-conns')).toMatchObject({ granted: 100, count: 10 });
    } finally {
      slow.release();
      await slow.client.quit();
    }
  });

  it('writes the grant of an account the campaign counts without one, as a rerun after a crash between the two steps does', async () => {
    const owner = `crash_${crypto.randomBytes(6).toString('hex')}`;
    const request: PromoGrantRequest = { campaignId: 'crashed', amount: 10, priority: 0, reason: 'test', actor: 'test', at: Date.now() };
    const ledger = new RedisReservationLedger(admin, keyPrefix);
    // The first step alone, as a run that died after it leaves things.
    await admin.eval(RESERVE_PROMO_BUDGET_LUA_SCRIPT, 2, `${keyPrefix}promo:campaign:{crashed}`, `${keyPrefix}promo:campaign:{crashed}:owners`, owner, 10, 100, request.at);
    expect(await ledger.promoGrants(owner)).toEqual([]);
    expect(await ledger.grantPromo(owner, request, 100)).toBe('granted');
    expect(await ledger.promoCampaign('crashed')).toMatchObject({ granted: 10, count: 1 });
    expect(await ledger.promoGrants(owner)).toHaveLength(1);
  });

  it('refuses a voided campaign before it looks at the account, also an account it counts', async () => {
    const owner = `void_${crypto.randomBytes(6).toString('hex')}`;
    const request: PromoGrantRequest = { campaignId: 'closed', amount: 10, priority: 0, reason: 'test', actor: 'test', at: Date.now() };
    const ledger = new RedisReservationLedger(admin, keyPrefix);
    expect(await ledger.grantPromo(owner, request)).toBe('granted');
    await ledger.voidPromoCampaign('closed', Date.now());
    expect(await ledger.grantPromo(owner, request)).toBe('campaign-voided');
    expect(await ledger.promoCampaign('closed')).toMatchObject({ granted: 10, count: 1 });
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
