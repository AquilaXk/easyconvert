import { isAnonymousUserId } from '../auth/anonymous-identity';
import { redisUserStore } from '../auth/redis-user-store';
import type { UserTier } from '../auth/types';
import { isEntitlingStatus } from '../billing/entitlement';
import { subscriptionStore } from '../billing/subscription-store';
import { QUOTA_PERIOD, TIER_LIMITS, getAnonymousDailyLimit, type QuotaPeriod } from '../plan-limits';

/**
 * The span of time whose conversions are counted together (docs/policy-decisions.md, entry 280). The free plan and the callers
 * without an account are counted by the UTC day. A paid plan is counted by the month of its subscription: the span between two
 * renewals, which is what a customer sees on the invoice. An account on a paid tier with no live subscription (a plan set by the
 * operator) or whose renewal date is unknown is counted by the UTC calendar month.
 *
 * `key` names the span inside the ledger's keys and in a reservation's id (`reservation-ledger.ts`): the date `YYYY-MM-DD` of a day, so
 * the day keys are those that existed before paid quotas, `m<YYYY-MM>` for a calendar month and `b<ms>` for the span that ends at the
 * renewal `<ms>`. A key never holds an underscore, which a reservation id reads its parts by.
 */
export interface QuotaWindow {
  period: QuotaPeriod;
  key: string;
  /** When the count starts again, in milliseconds since the epoch. */
  endsAt: number;
}

/** What an account may do in its current window: its tier (anonymous callers are `free`), the window, and the conversions it holds. */
export interface QuotaAllowance {
  tier: UserTier;
  window: QuotaWindow;
  limit: number;
}

/** A renewal date that the roll-forward could not place within this many months of now is not trusted. */
const MAX_RENEWAL_DRIFT_MONTHS = 36;

const pad2 = (value: number): string => String(value).padStart(2, '0');

export function dayWindow(now: number): QuotaWindow {
  const date = new Date(now);
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return { period: 'day', key: `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`, endsAt: day + 24 * 60 * 60 * 1000 };
}

export function calendarMonthWindow(now: number): QuotaWindow {
  const date = new Date(now);
  return { period: 'month', key: `m${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}`, endsAt: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) };
}

/** `anchor` moved by `months`, keeping its day of the month and time of day, and the last day of a month that is too short for it. */
function addMonths(anchor: number, months: number): number {
  const date = new Date(anchor);
  const monthIndex = date.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), monthIndex + 1, 0)).getUTCDate();
  return Date.UTC(
    date.getUTCFullYear(),
    monthIndex,
    Math.min(date.getUTCDate(), lastDay),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds()
  );
}

/**
 * The month of a subscription that holds `now`, when the end of one of its billing periods is `periodEnd`: the renewals fall on that
 * day of every month, so a period end that is already past (the renewal's event has not arrived yet) or that lies several months ahead
 * (a yearly price) places `now` in the same month the next event will. The key names the end of the month, so the event that brings
 * the new `currentPeriodEnd` leaves the count where it is. Undefined when `periodEnd` is not a date or is not within
 * `MAX_RENEWAL_DRIFT_MONTHS` months of `now`.
 */
export function billingMonthWindow(periodEnd: number, now: number): QuotaWindow | undefined {
  if (!Number.isFinite(new Date(periodEnd).getTime())) return undefined;
  const start = new Date(periodEnd);
  const end = new Date(now);
  let months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth();
  if (Math.abs(months) > MAX_RENEWAL_DRIFT_MONTHS) return undefined;
  while (addMonths(periodEnd, months) <= now) months += 1;
  while (addMonths(periodEnd, months - 1) > now) months -= 1;
  const endsAt = addMonths(periodEnd, months);
  return { period: 'month', key: `b${endsAt}`, endsAt };
}

/** The window of a paid account: the month of its live subscription of `tier`, else the calendar month. */
async function paidWindow(userId: string, tier: UserTier, now: number): Promise<QuotaWindow> {
  const subscription = await subscriptionStore.findByUser(userId);
  const periodEnd = subscription?.plan === tier && isEntitlingStatus(subscription.status) ? subscription.currentPeriodEnd : undefined;
  return (periodEnd === undefined ? undefined : billingMonthWindow(periodEnd, now)) ?? calendarMonthWindow(now);
}

/** What `userId` may convert, and since when it has been counted: one read of the account, and of its subscription when its plan is paid. */
export async function quotaAllowanceOf(userId: string, now: number = Date.now()): Promise<QuotaAllowance> {
  if (isAnonymousUserId(userId)) return { tier: 'free', window: dayWindow(now), limit: getAnonymousDailyLimit() };
  const tier: UserTier = (await redisUserStore.findById(userId))?.tier ?? 'free';
  const window = QUOTA_PERIOD[tier] === 'day' ? dayWindow(now) : await paidWindow(userId, tier, now);
  return { tier, window, limit: TIER_LIMITS[tier] };
}
