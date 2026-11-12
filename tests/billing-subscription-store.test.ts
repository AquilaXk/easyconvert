import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { AuthStoreUnavailableError } from '../src/lib/auth/store-unavailable';
import { subscriptionStore } from '../src/lib/billing/subscription-store';
import type { SubscriptionChange } from '../src/lib/billing/types';
import { TERMS_VERSION } from '../src/lib/legal/documents';

/**
 * The subscription records and the tier they give, in memory and (`npm run test:redis`, REDIS_URL set) against a real Redis:
 * the atomic apply, the replay and ordering rules, and the expiry of a tier that has an end.
 */

const NOW = Date.UTC(2026, 10, 12, 12);
const DAY = 86_400_000;
const created: string[] = [];

async function account() {
  const record = await redisUserStore.createUser({ email: `billing_${crypto.randomUUID()}@billing.test`, name: 'Billing', acceptedTermsVersion: TERMS_VERSION });
  created.push(record.id);
  return record.id;
}

function change(userId: string, overrides: { eventId?: string; eventAt?: number; subscription?: Partial<SubscriptionChange['subscription']> } = {}): SubscriptionChange {
  return {
    eventId: overrides.eventId ?? `evt_${crypto.randomUUID()}`,
    eventAt: overrides.eventAt ?? NOW,
    userId,
    subscription: {
      provider: 'paddle',
      providerSubscriptionId: 'sub_A',
      providerCustomerId: 'ctm_A',
      status: 'active',
      plan: 'pro',
      currentPeriodEnd: NOW + 20 * DAY,
      ...overrides.subscription,
    },
  };
}

const tierOf = async (userId: string) => (await redisUserStore.findById(userId))?.tier;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(async () => {
  vi.useRealTimers();
  for (const userId of created.splice(0)) {
    await subscriptionStore.forgetUser(userId);
    await redisUserStore.deleteUser(userId);
  }
});

describe('the subscription store', () => {
  it('stores the subscription, gives the account its plan and finds the account by subscription', async () => {
    const userId = await account();
    expect(await subscriptionStore.apply(change(userId))).toBe('applied');
    expect(await tierOf(userId)).toBe('pro');
    expect(await subscriptionStore.findByUser(userId)).toMatchObject({ userId, status: 'active', plan: 'pro', providerSubscriptionId: 'sub_A', providerCustomerId: 'ctm_A' });
    expect(await subscriptionStore.userOfSubscription('sub_A')).toBe(userId);
  });

  it('applies an event id once: a replay changes nothing, whatever it carries', async () => {
    const userId = await account();
    const first = change(userId);
    expect(await subscriptionStore.apply(first)).toBe('applied');
    expect(await subscriptionStore.apply({ ...first, eventAt: NOW + 1000, subscription: { ...first.subscription, status: 'canceled' } })).toBe('duplicate');
    expect(await tierOf(userId)).toBe('pro');
    expect((await subscriptionStore.findByUser(userId))?.status).toBe('active');
  });

  it('does not let an older event undo a newer one', async () => {
    const userId = await account();
    await subscriptionStore.apply(change(userId, { eventAt: NOW + 5000, subscription: { status: 'canceled' } }));
    expect(await subscriptionStore.apply(change(userId, { eventAt: NOW }))).toBe('stale');
    expect(await tierOf(userId)).toBe('free');
    expect((await subscriptionStore.findByUser(userId))?.status).toBe('canceled');
  });

  it('returns the account to free when the subscription is canceled', async () => {
    const userId = await account();
    await subscriptionStore.apply(change(userId));
    await subscriptionStore.apply(change(userId, { eventAt: NOW + 1000, subscription: { status: 'canceled', currentPeriodEnd: undefined } }));
    expect(await tierOf(userId)).toBe('free');
  });

  it('keeps the plan to the end of a scheduled cancellation and no longer', async () => {
    const userId = await account();
    const cancelAt = NOW + 3 * DAY;
    await subscriptionStore.apply(change(userId, { subscription: { cancelAt } }));
    expect(await tierOf(userId)).toBe('pro');
    vi.setSystemTime(cancelAt - 1);
    expect(await tierOf(userId)).toBe('pro');
    vi.setSystemTime(cancelAt);
    expect(await tierOf(userId)).toBe('free');
  });

  it('keeps a past-due plan to the end of the paid period', async () => {
    const userId = await account();
    const currentPeriodEnd = NOW + DAY;
    await subscriptionStore.apply(change(userId, { subscription: { status: 'past_due', currentPeriodEnd } }));
    expect(await tierOf(userId)).toBe('pro');
    vi.setSystemTime(currentPeriodEnd + 1);
    expect(await tierOf(userId)).toBe('free');
  });

  it('answers unknown_user and keeps nothing for an account that is gone, without using up the event id', async () => {
    const userId = await account();
    const event = change(userId);
    await redisUserStore.deleteUser(userId);
    expect(await subscriptionStore.apply(event)).toBe('unknown_user');
    expect(await subscriptionStore.findByUser(userId)).toBeNull();
    expect(await subscriptionStore.userOfSubscription('sub_A')).toBeNull();
  });

  it('ignores a canceled subscription that is not the account\'s current one, and takes a new active one', async () => {
    const userId = await account();
    await subscriptionStore.apply(change(userId, { subscription: { providerSubscriptionId: 'sub_B' } }));
    expect(await subscriptionStore.apply(change(userId, { eventAt: NOW + 1000, subscription: { providerSubscriptionId: 'sub_A', status: 'canceled' } }))).toBe('other_subscription');
    expect(await tierOf(userId)).toBe('pro');
    expect((await subscriptionStore.findByUser(userId))?.providerSubscriptionId).toBe('sub_B');
    expect(await subscriptionStore.apply(change(userId, { eventAt: NOW + 2000, subscription: { providerSubscriptionId: 'sub_C', plan: 'enterprise' } }))).toBe('applied');
    expect(await tierOf(userId)).toBe('enterprise');
    expect((await subscriptionStore.findByUser(userId))?.providerSubscriptionId).toBe('sub_C');
  });

  it('forgets the record and the index of an account, and nothing else', async () => {
    const userId = await account();
    const otherId = await account();
    await subscriptionStore.apply(change(userId));
    await subscriptionStore.apply(change(otherId, { subscription: { providerSubscriptionId: 'sub_other' } }));
    await subscriptionStore.forgetUser(userId);
    expect(await subscriptionStore.findByUser(userId)).toBeNull();
    expect(await subscriptionStore.userOfSubscription('sub_A')).toBeNull();
    expect(await subscriptionStore.userOfSubscription('sub_other')).toBe(otherId);
  });
});

describe('a store that cannot answer', () => {
  it('refuses instead of answering from this process', async () => {
    const client = redisUserStore.getRedisClient();
    const broken = { eval: vi.fn().mockRejectedValue(new Error('down')), get: vi.fn().mockRejectedValue(new Error('down')), del: vi.fn().mockRejectedValue(new Error('down')) };
    const userId = await account();
    redisUserStore.setRedisClient(broken as never);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(subscriptionStore.apply(change(userId))).rejects.toBeInstanceOf(AuthStoreUnavailableError);
      await expect(subscriptionStore.findByUser(userId)).rejects.toBeInstanceOf(AuthStoreUnavailableError);
      expect(broken.eval).toHaveBeenCalledTimes(1);
    } finally {
      redisUserStore.setRedisClient(client);
      vi.restoreAllMocks();
    }
  });
});
