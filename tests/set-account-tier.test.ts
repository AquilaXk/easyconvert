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
    const byEmail = await planTierChange(user.email, 'enterprise');
    expect(byEmail).toEqual({ userId: user.id, email: user.email, from: 'free', to: 'enterprise' });
    expect(await planTierChange(user.id, 'enterprise')).toEqual(byEmail);
    expect((await redisUserStore.findById(user.id))?.tier).toBe('free');
  });

  it('offers the Basic plan with the others, and counts a plan set by hand by the calendar month', async () => {
    expect(SETTABLE_TIERS).toEqual(['free', 'basic', 'pro', 'enterprise']);
    const user = await account();
    const change = await planTierChange(user.id, 'basic');
    if ('refusal' in change) throw new Error(change.refusal);
    await applyTierChange(change);
    expect((await redisUserStore.findById(user.id))?.tier).toBe('basic');
    const allowance = await quotaAllowanceOf(user.id);
    expect(allowance.limit).toBe(1000);
    expect(allowance.window.key).toMatch(/^m\d{4}-\d{2}$/);
  });

  it('writes the plan with no end date, so it does not lapse back to free', async () => {
    const user = await account();
    await redisUserStore.updateUser(user.id, { tier: 'pro', tierUntil: Date.now() + 60_000 });
    const change = await planTierChange(user.id, 'enterprise');
    if ('refusal' in change) throw new Error(change.refusal);
    await applyTierChange(change);
    const stored = await redisUserStore.findById(user.id);
    expect(stored?.tier).toBe('enterprise');
    expect(stored?.tierUntil).toBeUndefined();
  });

  it('refuses an unknown account and an account whose plan comes from a live subscription', async () => {
    expect(await planTierChange(`nobody_${crypto.randomUUID()}@tier.test`, 'enterprise')).toEqual({ refusal: expect.stringContaining('No account') });
    const user = await account();
    await subscriptionStore.apply({
      eventId: `evt_${crypto.randomUUID()}`,
      eventAt: Date.now(),
      userId: user.id,
      subscription: { provider: 'paddle', providerSubscriptionId: `sub_${user.id}`, providerCustomerId: `ctm_${user.id}`, status: 'active', plan: 'pro' },
    });
    expect(await planTierChange(user.id, 'enterprise')).toEqual({ refusal: expect.stringContaining('live subscription') });
  });
});
