import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eraseAccount, planAccountErasure } from '../scripts/erase-account';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { subscriptionStore } from '../src/lib/billing/subscription-store';
import { TERMS_VERSION } from '../src/lib/legal/documents';

/** Erasing an account (entry 242) removes its subscription records; the customer stays with the payment provider. */

const created: string[] = [];
const NOW = Date.now();

async function subscriber(subscriptionId: string) {
  const user = await redisUserStore.createUser({ email: `erase_${crypto.randomUUID()}@billing.test`, name: 'Erase', acceptedTermsVersion: TERMS_VERSION });
  created.push(user.id);
  await subscriptionStore.apply({
    eventId: `evt_${crypto.randomUUID()}`,
    eventAt: NOW,
    userId: user.id,
    subscription: { provider: 'paddle', providerSubscriptionId: subscriptionId, providerCustomerId: `ctm_${subscriptionId}`, status: 'active', plan: 'pro' },
  });
  return user;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const userId of created.splice(0)) {
    const plan = await planAccountErasure(userId);
    if (plan) await eraseAccount(plan, { drainMs: 0 });
    await subscriptionStore.forgetUser(userId);
  }
});

describe('erasing an account that has a subscription', () => {
  it('lists the subscription in the plan and changes nothing', async () => {
    const user = await subscriber('sub_planned');
    const plan = await planAccountErasure(user.id);
    expect(plan).toMatchObject({ userId: user.id, subscription: { providerSubscriptionId: 'sub_planned', status: 'active' } });
    expect(await subscriptionStore.findByUser(user.id)).not.toBeNull();
  });

  it('plans no subscription for an account without one', async () => {
    const user = await redisUserStore.createUser({ email: `erase_${crypto.randomUUID()}@billing.test`, name: 'None', acceptedTermsVersion: TERMS_VERSION });
    created.push(user.id);
    expect((await planAccountErasure(user.id))?.subscription).toBeNull();
  });

  it('deletes the record, its index and the account, and keeps the subscription of another account', async () => {
    const erased = await subscriber('sub_erased');
    const kept = await subscriber('sub_kept');
    expect(await eraseAccount((await planAccountErasure(erased.id))!, { drainMs: 0 })).toEqual({ runningJobIds: [] });

    expect(await redisUserStore.findById(erased.id)).toBeNull();
    expect(await subscriptionStore.findByUser(erased.id)).toBeNull();
    expect(await subscriptionStore.userOfSubscription('sub_erased')).toBeNull();
    expect(await subscriptionStore.findByUser(kept.id)).toMatchObject({ providerSubscriptionId: 'sub_kept' });
    expect(await subscriptionStore.userOfSubscription('sub_kept')).toBe(kept.id);
  });

  it('deletes the record again when an event lands after the first deletion and before the account goes', async () => {
    const user = await subscriber('sub_late');
    const plan = (await planAccountErasure(user.id))!;
    const deleteUser = redisUserStore.deleteUser.bind(redisUserStore);
    vi.spyOn(redisUserStore, 'deleteUser').mockImplementation(async (id) => {
      const late = await subscriptionStore.apply({
        eventId: `evt_${crypto.randomUUID()}`,
        eventAt: NOW + 1000,
        userId: id,
        subscription: { provider: 'paddle', providerSubscriptionId: 'sub_late', providerCustomerId: 'ctm_sub_late', status: 'active', plan: 'pro' },
      });
      expect(late).toBe('applied');
      return deleteUser(id);
    });
    expect(await eraseAccount(plan, { drainMs: 0 })).toEqual({ runningJobIds: [] });
    expect(await redisUserStore.findById(user.id)).toBeNull();
    expect(await subscriptionStore.findByUser(user.id)).toBeNull();
    expect(await subscriptionStore.userOfSubscription('sub_late')).toBeNull();
  });
});
