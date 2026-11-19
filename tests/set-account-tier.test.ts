import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { SETTABLE_TIERS, applyTierChange, planTierChange } from '../scripts/set-account-tier';
import { quotaAllowanceOf } from '../src/lib/api-keys/quota-window';
import { RedisUserStore, UPDATE_USER_LUA_SCRIPT, redisUserStore } from '../src/lib/auth/redis-user-store';
import { subscriptionStore } from '../src/lib/billing/subscription-store';
import { TERMS_VERSION } from '../src/lib/legal/documents';

const created: string[] = [];

async function account() {
  const user = await redisUserStore.createUser({ email: `tier_${crypto.randomUUID()}@tier.test`, name: 'Tier', acceptedTermsVersion: TERMS_VERSION });
  created.push(user.id);
  return user;
}

afterEach(async () => {
  for (const userId of created.splice(0)) {
    await subscriptionStore.forgetUser(userId);
    await redisUserStore.deleteUser(userId);
  }
});

describe('set-account-tier, the operator tool that sets the plan of an account by hand', () => {
  it('plans the change by email or id and writes nothing until it is applied', async () => {
    const user = await account();
    const byEmail = await planTierChange(user.email, 'paid');
    expect(byEmail).toEqual({ userId: user.id, email: user.email, from: 'free', to: 'paid' });
    expect(await planTierChange(user.id, 'paid')).toEqual(byEmail);
    expect((await redisUserStore.findById(user.id))?.tier).toBe('free');
  });

  it('offers the free and the paid tier, and a tier set by hand gives the paid limits but no credits: the day of the free plan counts', async () => {
    expect(SETTABLE_TIERS).toEqual(['free', 'paid']);
    const user = await account();
    const change = await planTierChange(user.id, 'paid');
    if ('refusal' in change) throw new Error(change.refusal);
    await applyTierChange(change);
    expect((await redisUserStore.findById(user.id))?.tier).toBe('paid');
    const allowance = await quotaAllowanceOf(user.id);
    expect(allowance.limit).toBe(10);
    expect(allowance.subscribed).toBe(false);
    expect(allowance.window.key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('writes the plan with no end date, so it does not lapse back to free', async () => {
    const user = await account();
    await redisUserStore.updateUser(user.id, { tier: 'paid', tierUntil: Date.now() + 60_000 });
    const change = await planTierChange(user.id, 'paid');
    if ('refusal' in change) throw new Error(change.refusal);
    await applyTierChange(change);
    const stored = await redisUserStore.findById(user.id);
    expect(stored?.tier).toBe('paid');
    expect(stored?.tierUntil).toBeUndefined();
    expect(Object.hasOwn(stored ?? {}, 'tierUntil')).toBe(false);
  });

  it('deletes expired tierUntil on Redis and in-memory stores when promoting back to paid', async () => {
    const expiredAt = Date.now() - 60_000;
    const rawUsers = new Map<string, string>();
    const fakeRedis = {
      get: async (key: string) => rawUsers.get(key) ?? null,
      eval: async (script: string, numKeys: number, ...args: string[]) => {
        if (script !== UPDATE_USER_LUA_SCRIPT) return null;
        expect(numKeys).toBe(2);
        const [uKey, vKey] = args;
        const raw = rawUsers.get(uKey);
        if (!raw) return null;
        const user = JSON.parse(raw) as Record<string, unknown>;
        const updates = JSON.parse(args[2]) as Record<string, unknown>;
        for (const [k, v] of Object.entries(updates)) {
          if (v === null) {
            delete user[k];
          } else {
            user[k] = v;
          }
        }
        const liveVer = rawUsers.get(vKey);
        if (liveVer && Number(user.sessionVersion ?? 1) < Number(liveVer)) {
          user.sessionVersion = Number(liveVer);
        }
        user.updatedAt = Number(args[3]);
        const encoded = JSON.stringify(user);
        rawUsers.set(uKey, encoded);
        return encoded;
      },
    };
    const store = new RedisUserStore({ redisClient: fakeRedis as never, keyPrefix: 'test:{user}:' });
    const seed = {
      id: 'usr_expired_tier',
      email: 'expired@tier.test',
      name: 'Expired',
      tier: 'paid',
      tierUntil: expiredAt,
      provider: 'email',
      createdAt: 1000,
      updatedAt: 1000,
    };
    rawUsers.set(`test:{user}:${seed.id}`, JSON.stringify(seed));
    rawUsers.set(`test:{user}:emailIndex:${seed.email}`, seed.id);

    // Lua script itself must clear null keys so Redis does not persist cjson.null.
    expect(UPDATE_USER_LUA_SCRIPT).toContain('cjson.null');

    const before = await store.findById(seed.id);
    expect(before?.tier).toBe('free');

    await store.updateUser(seed.id, { tier: 'paid', tierUntil: null });
    const afterUpdate = await store.findById(seed.id);
    expect(afterUpdate?.tier).toBe('paid');
    expect(afterUpdate?.tierUntil).toBeUndefined();
    expect(JSON.parse(rawUsers.get(`test:{user}:${seed.id}`)!).tierUntil).toBeUndefined();

    // Also verify set-account-tier sends tierUntil: null through redisUserStore when promoting a user with expired tierUntil
    const origGet = redisUserStore.getRedisClient();
    redisUserStore.setRedisClient(fakeRedis as never);
    try {
      rawUsers.set(`easyconvert:{user}:${seed.id}`, JSON.stringify(seed));
      rawUsers.set(`easyconvert:{user}:emailIndex:${seed.email}`, seed.id);
      const change = await planTierChange(seed.id, 'paid');
      if ('refusal' in change) throw new Error(change.refusal);
      await applyTierChange(change);
      const saved = await redisUserStore.findById(seed.id);
      expect(saved?.tier).toBe('paid');
      expect(saved?.tierUntil).toBeUndefined();
      expect(Object.hasOwn(saved ?? {}, 'tierUntil')).toBe(false);
    } finally {
      redisUserStore.setRedisClient(origGet);
    }
  });

  it('refuses an unknown account and an account whose plan comes from a live subscription', async () => {
    expect(await planTierChange(`nobody_${crypto.randomUUID()}@tier.test`, 'paid')).toEqual({ refusal: expect.stringContaining('No account') });
    const user = await account();
    await subscriptionStore.apply({
      eventId: `evt_${crypto.randomUUID()}`,
      eventAt: Date.now(),
      userId: user.id,
      subscription: { provider: 'paddle', providerSubscriptionId: `sub_${user.id}`, providerCustomerId: `ctm_${user.id}`, status: 'active', credits: 1000 },
    });
    expect(await planTierChange(user.id, 'paid')).toEqual({ refusal: expect.stringContaining('live subscription') });
  });
});
