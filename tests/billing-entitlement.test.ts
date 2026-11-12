import { describe, expect, it } from 'vitest';
import { entitlementOf, isEntitlingStatus } from '../src/lib/billing/entitlement';
import type { SubscriptionRecord } from '../src/lib/billing/types';

const NOW = Date.UTC(2026, 10, 12, 12);
const DAY = 86_400_000;

function record(overrides: Partial<SubscriptionRecord> = {}): SubscriptionRecord {
  return {
    userId: 'user-1',
    provider: 'paddle',
    providerSubscriptionId: 'sub_1',
    providerCustomerId: 'ctm_1',
    status: 'active',
    plan: 'pro',
    currentPeriodEnd: NOW + 20 * DAY,
    eventAt: NOW,
    ...overrides,
  };
}

describe('entitlementOf', () => {
  it('gives the plan of an active or trialing subscription with no end', () => {
    expect(entitlementOf(record(), NOW)).toEqual({ tier: 'pro' });
    expect(entitlementOf(record({ status: 'trialing', plan: 'enterprise' }), NOW)).toEqual({ tier: 'enterprise' });
  });

  it('keeps the plan until the end of a scheduled cancellation and then gives free', () => {
    const cancelAt = NOW + 3 * DAY;
    expect(entitlementOf(record({ cancelAt }), NOW)).toEqual({ tier: 'pro', until: cancelAt });
    expect(entitlementOf(record({ cancelAt }), cancelAt)).toEqual({ tier: 'free' });
  });

  it('keeps a past-due plan until the paid period ends, never past it', () => {
    const currentPeriodEnd = NOW + DAY;
    expect(entitlementOf(record({ status: 'past_due', currentPeriodEnd }), NOW)).toEqual({ tier: 'pro', until: currentPeriodEnd });
    expect(entitlementOf(record({ status: 'past_due', currentPeriodEnd: NOW - 1 }), NOW)).toEqual({ tier: 'free' });
    expect(entitlementOf(record({ status: 'past_due', currentPeriodEnd: undefined }), NOW)).toEqual({ tier: 'free' });
  });

  it('gives free to a canceled or paused subscription', () => {
    expect(entitlementOf(record({ status: 'canceled' }), NOW)).toEqual({ tier: 'free' });
    expect(entitlementOf(record({ status: 'paused' }), NOW)).toEqual({ tier: 'free' });
  });

  it('names the statuses that hold a plan', () => {
    expect(['active', 'trialing', 'past_due', 'paused', 'canceled'].filter((status) => isEntitlingStatus(status as SubscriptionRecord['status']))).toEqual(['active', 'trialing', 'past_due']);
  });
});
