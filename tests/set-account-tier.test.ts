import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { SETTABLE_TIERS, applyTierChange, planTierChange } from '../scripts/set-account-tier';
import { quotaAllowanceOf } from '../src/lib/api-keys/quota-window';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
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
