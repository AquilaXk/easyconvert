import crypto from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { billingMonthWindow, calendarMonthWindow, dayWindow, quotaAllowanceOf } from '../src/lib/api-keys/quota-window';
import { reserveConversionUnit } from '../src/lib/api-keys/guard';
import { buildRateLimitHeaders } from '../src/lib/api/rate-limit';
import { userStore } from '../src/lib/auth/user-store';
import type { UserTier } from '../src/lib/auth/types';
import { subscriptionStore } from '../src/lib/billing/subscription-store';
import type { PaidPlan } from '../src/lib/billing/types';
import { QUOTA_PERIOD, TIER_LIMITS } from '../src/lib/plan-limits';

// The quota store picks Redis or this process when it is first imported; Redis is covered by tests/quota-accounting-redis.test.ts.
vi.hoisted(() => {
  vi.stubEnv('REDIS_URL', '');
  vi.stubEnv('REDIS_HOST', '');
});

afterAll(() => {
  vi.unstubAllEnvs();
});

/**
 * Paid plans count conversions by the month of the subscription, the free plan and callers without an account by the UTC day
 * (docs/policy-decisions.md, entry 280). A reservation, a commit and a rollback act on the window they were made in.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const at = (iso: string): number => Date.parse(iso);

describe('the windows', () => {
  it('counts a UTC day from midnight to midnight, under the key the day always had', () => {
    expect(dayWindow(at('2026-11-13T23:59:59.999Z'))).toEqual({ period: 'day', key: '2026-11-13', endsAt: at('2026-11-14T00:00:00.000Z') });
    expect(dayWindow(at('2026-12-31T12:00:00Z'))).toEqual({ period: 'day', key: '2026-12-31', endsAt: at('2027-01-01T00:00:00Z') });
  });

  it('counts a calendar month in UTC', () => {
    expect(calendarMonthWindow(at('2026-11-30T23:59:59Z'))).toEqual({ period: 'month', key: 'm2026-11', endsAt: at('2026-12-01T00:00:00Z') });
    expect(calendarMonthWindow(at('2026-12-15T00:00:00Z')).endsAt).toBe(at('2027-01-01T00:00:00Z'));
  });

  describe('the month of a subscription', () => {
    const end = at('2026-12-05T09:30:00Z');

    it('ends at the period end the subscription has, and is named by it', () => {
      expect(billingMonthWindow(end, at('2026-11-20T00:00:00Z'))).toEqual({ period: 'month', key: `b${end}`, endsAt: end });
    });

    it('stays in the same window up to the moment the period ends, and moves to the next month from it', () => {
      expect(billingMonthWindow(end, end - 1)?.endsAt).toBe(end);
      expect(billingMonthWindow(end, end)?.endsAt).toBe(at('2027-01-05T09:30:00Z'));
    });

    it('places a renewal whose event has not arrived yet in the window the event will name, so the count stays', () => {
      const late = billingMonthWindow(end, end + 3 * DAY_MS);
      expect(late).toEqual(billingMonthWindow(at('2027-01-05T09:30:00Z'), end + 3 * DAY_MS));
      expect(late?.key).toBe(`b${at('2027-01-05T09:30:00Z')}`);
    });

    it('keeps the day of the month where a month is shorter, and returns to it after', () => {
      const thirtyFirst = at('2026-12-31T00:00:00Z');
      expect(billingMonthWindow(thirtyFirst, at('2027-02-10T00:00:00Z'))?.endsAt).toBe(at('2027-02-28T00:00:00Z'));
      expect(billingMonthWindow(thirtyFirst, at('2027-03-01T00:00:00Z'))?.endsAt).toBe(at('2027-03-31T00:00:00Z'));
    });

    it('splits a period end a year ahead (a yearly price) into months as well', () => {
      const yearAhead = at('2027-11-13T00:00:00Z');
      expect(billingMonthWindow(yearAhead, at('2026-11-20T00:00:00Z'))?.endsAt).toBe(at('2026-12-13T00:00:00Z'));
    });

    it('is not trusted when it is not a date, or years away from now', () => {
      expect(billingMonthWindow(Number.NaN, at('2026-11-13T00:00:00Z'))).toBeUndefined();
      expect(billingMonthWindow(at('2020-01-01T00:00:00Z'), at('2026-11-13T00:00:00Z'))).toBeUndefined();
    });
  });
});

describe('the allowance of an account', () => {
  let counter = 0;

  async function account(tier: UserTier, subscription?: { plan: PaidPlan; status?: 'active' | 'past_due' | 'canceled'; currentPeriodEnd?: number }) {
    const user = await userStore.createUser({ email: `monthly_${tier}_${++counter}_${crypto.randomBytes(4).toString('hex')}@quota.test`, name: 'Monthly', tier });
    if (subscription) {
      const applied = await subscriptionStore.apply({
        eventId: `evt_${crypto.randomUUID()}`,
        eventAt: Date.now(),
        userId: user.id,
        subscription: {
          provider: 'paddle',
          providerSubscriptionId: `sub_${crypto.randomBytes(6).toString('hex')}`,
          providerCustomerId: 'ctm_fixture',
          status: subscription.status ?? 'active',
          plan: subscription.plan,
          currentPeriodEnd: subscription.currentPeriodEnd,
        },
      });
      expect(applied).toBe('applied');
    }
    return user.id;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: at('2026-11-13T10:00:00Z') });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts the free plan by the day and the three paid plans by the month, as QA decided', () => {
    expect(QUOTA_PERIOD).toEqual({ anonymous: 'day', free: 'day', basic: 'month', pro: 'month', enterprise: 'month' });
    expect(TIER_LIMITS).toEqual({ free: 10, basic: 1000, pro: 3000, enterprise: 10000 });
  });

  it('gives a free account its day, and a Basic subscriber the month of its subscription', async () => {
    const free = await quotaAllowanceOf(await account('free'));
    expect(free).toEqual({ tier: 'free', window: dayWindow(Date.now()), limit: 10 });

    const periodEnd = at('2026-12-02T08:00:00Z');
    const basic = await quotaAllowanceOf(await account('basic', { plan: 'basic', currentPeriodEnd: periodEnd }));
    expect(basic).toEqual({ tier: 'basic', window: { period: 'month', key: `b${periodEnd}`, endsAt: periodEnd }, limit: 1000 });
  });

  it('falls back to the calendar month for a paid tier with no subscription, and for a subscription without a period end', async () => {
    const operatorSet = await quotaAllowanceOf(await account('pro'));
    expect(operatorSet.window).toEqual(calendarMonthWindow(Date.now()));
    expect(operatorSet.limit).toBe(3000);

    const unknownEnd = await quotaAllowanceOf(await account('enterprise', { plan: 'enterprise' }));
    expect(unknownEnd.window).toEqual(calendarMonthWindow(Date.now()));
  });

  it('does not use a subscription of another plan or one that no longer gives its plan', async () => {
    const periodEnd = at('2026-12-02T08:00:00Z');
    const canceled = await quotaAllowanceOf(await account('basic', { plan: 'basic', status: 'canceled', currentPeriodEnd: periodEnd }));
    // A canceled subscription takes the plan away, so the account is on the free tier and counts by the day.
    expect(canceled.tier).toBe('free');
    expect(canceled.window.period).toBe('day');
  });

  describe('through a key store in this process', () => {
    let store = new RedisKeyStore({ isolated: true });
    beforeEach(() => {
      store = new RedisKeyStore({ isolated: true });
    });

    it('charges a Basic subscriber on the same count all month, and starts it again at the renewal', async () => {
      const periodEnd = at('2026-12-02T08:00:00Z');
      const owner = await account('basic', { plan: 'basic', currentPeriodEnd: periodEnd });

      const first = await store.reserveQuota(owner, 3);
      expect(first).toMatchObject({ allowed: true, remaining: 997 });
      expect(await store.commitQuota(first.reservationId as string)).toBe(true);

      vi.setSystemTime(at('2026-11-25T23:00:00Z'));
      const usage = await store.getQuotaUsage(owner);
      expect(usage).toEqual({ tier: 'basic', period: 'month', dailyLimit: 1000, usedToday: 3, remaining: 997, resetAt: periodEnd });

      vi.setSystemTime(periodEnd + 1000);
      // The renewal's event has not been applied yet: the roll-forward gives the new month a fresh count.
      expect((await store.getQuotaUsage(owner)).usedToday).toBe(0);
      expect((await store.getQuotaUsage(owner)).resetAt).toBe(at('2027-01-02T08:00:00Z'));
    });

    it('keeps the count across the event that renews the subscription, which names the end of the month the roll-forward named', async () => {
      const periodEnd = at('2026-12-02T08:00:00Z');
      const owner = await account('basic', { plan: 'basic', currentPeriodEnd: periodEnd });
      vi.setSystemTime(periodEnd + 5000);
      const used = await store.reserveQuota(owner, 4);
      expect(await store.commitQuota(used.reservationId as string)).toBe(true);

      const renewedEnd = at('2027-01-02T08:00:00Z');
      await subscriptionStore.apply({
        eventId: `evt_${crypto.randomUUID()}`,
        eventAt: Date.now() + 1000,
        userId: owner,
        subscription: { provider: 'paddle', providerSubscriptionId: 'sub_renewed', providerCustomerId: 'ctm_fixture', status: 'active', plan: 'basic', currentPeriodEnd: renewedEnd },
      });
      expect((await store.getQuotaUsage(owner)).usedToday).toBe(4);
    });

    it('refuses the 1,001st conversion of the month of a Basic subscriber, and the 3,001st of a Pro one, and gives a rollback back', async () => {
      const periodEnd = at('2026-12-02T08:00:00Z');
      for (const [plan, limit] of [['basic', 1000], ['pro', 3000]] as const) {
        const owner = await account(plan, { plan, currentPeriodEnd: periodEnd });
        const batch = await store.reserveQuota(owner, limit);
        expect(batch).toMatchObject({ allowed: true, remaining: 0 });
        expect(await store.commitQuota(batch.reservationId as string)).toBe(true);

        vi.setSystemTime(Date.now() + 10 * DAY_MS);
        expect(await store.reserveQuota(owner, 1)).toMatchObject({ allowed: false, remaining: 0 });
        vi.setSystemTime(at('2026-11-13T10:00:00Z'));
      }

      const owner = await account('basic', { plan: 'basic', currentPeriodEnd: periodEnd });
      const reservation = await store.reserveQuota(owner, 5);
      expect((await store.getQuotaUsage(owner)).usedToday).toBe(5);
      expect(await store.rollbackQuota(reservation.reservationId as string)).toBe(true);
      expect((await store.getQuotaUsage(owner)).usedToday).toBe(0);
    });

    it('does not carry the free day count into the paid month, nor the paid month into a downgraded day', async () => {
      const owner = await account('free');
      const day = await store.reserveQuota(owner, 4);
      expect(await store.commitQuota(day.reservationId as string)).toBe(true);
      expect((await store.getQuotaUsage(owner)).usedToday).toBe(4);

      await userStore.updateUser(owner, { tier: 'basic' });
      expect(await store.getQuotaUsage(owner)).toMatchObject({ period: 'month', usedToday: 0, dailyLimit: 1000 });
      const month = await store.reserveQuota(owner, 7);
      expect(await store.commitQuota(month.reservationId as string)).toBe(true);

      await userStore.updateUser(owner, { tier: 'free' });
      expect(await store.getQuotaUsage(owner)).toMatchObject({ period: 'day', usedToday: 4, dailyLimit: 10 });
    });

    it('settles a reservation on the window it was made in when it ends after the month changed', async () => {
      const owner = await account('pro');
      vi.setSystemTime(at('2026-11-30T23:59:00Z'));
      const unit = await store.reserveQuota(owner, 2);
      expect(unit.reservationId).toContain('_m2026-11_');

      vi.setSystemTime(at('2026-12-01T00:00:10Z'));
      expect((await store.getQuotaUsage(owner)).usedToday).toBe(0);
      expect(await store.commitQuota(unit.reservationId as string)).toBe(true);
      expect((await store.getQuotaUsage(owner)).usedToday).toBe(0);
      vi.setSystemTime(at('2026-11-30T23:59:50Z'));
      expect((await store.getQuotaUsage(owner)).usedToday).toBe(2);
    });
  });

  describe('through the guard', () => {
    it('words the refusal of a paid plan by the month, with the monthly limit and the period in the usage', async () => {
      const owner = await account('basic', { plan: 'basic', currentPeriodEnd: at('2026-12-02T08:00:00Z') });
      const user = (await userStore.findById(owner))!;
      const { redisKeyStore } = await import('../src/lib/api-keys/redis-key-store');
      const all = await redisKeyStore.reserveQuota(owner, 1000);
      expect(all.allowed).toBe(true);
      await redisKeyStore.commitQuota(all.reservationId as string);

      const unit = await reserveConversionUnit(user, 2);
      expect(unit.reserved).toBe(false);
      if (unit.reserved || unit.refusal.reason !== 'used-up') throw new Error('expected a used-up refusal');
      expect(unit.refusal.usage.period).toBe('month');
      expect(unit.refusal.error).toBe(
        'Monthly conversion quota exceeded (1000 conversions per month). It resets when the billing period renews. This request needs 2 conversions and 0 are left this month.'
      );
    });

    it('words the refusal of a free account by the day, as before', async () => {
      const owner = await account('free');
      const user = (await userStore.findById(owner))!;
      const { redisKeyStore } = await import('../src/lib/api-keys/redis-key-store');
      const all = await redisKeyStore.reserveQuota(owner, 10);
      await redisKeyStore.commitQuota(all.reservationId as string);

      const unit = await reserveConversionUnit(user, 1);
      if (unit.reserved || unit.refusal.reason !== 'used-up') throw new Error('expected a used-up refusal');
      expect(unit.refusal.error).toBe('Daily conversion quota exceeded (10 conversions per day). It resets at midnight UTC. This request needs 1 conversion and 0 are left today.');
    });
  });
});

describe('the rate limit headers of a month', () => {
  it('state the nominal month as the window and the exact time left as the reset', () => {
    const resetAt = Date.now() + 90 * 60 * 1000;
    const headers = buildRateLimitHeaders({ tier: 'pro', period: 'month', dailyLimit: 3000, usedToday: 100, remaining: 2900, resetAt });
    expect(headers['RateLimit-Policy']).toBe('3000;w=2592000;comment="pro monthly quota"');
    expect(headers['RateLimit-Reset']).toBe('5400');
    expect(buildRateLimitHeaders({ tier: 'free', period: 'day', dailyLimit: 10, usedToday: 1, remaining: 9, resetAt })['RateLimit-Policy']).toBe('10;w=86400;comment="free daily quota"');
  });
});
