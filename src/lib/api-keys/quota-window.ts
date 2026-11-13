import { isAnonymousUserId } from '../auth/anonymous-identity';
import { entitlementOf } from '../billing/entitlement';
import { subscriptionStore } from '../billing/subscription-store';
import { FREE_DAILY_CREDITS, getAnonymousDailyLimit, type QuotaPeriod } from '../plan-limits';

/**
 * The span of time whose credits are counted together (docs/policy-decisions.md, entries 280 and 285). The free plan and the callers
 * without an account are counted by the UTC day. A subscription is counted by its billing period: the span between two renewals,
 * which is what a customer sees on the invoice, and its credits do not roll over. A subscription whose renewal date is unknown is
 * counted by the UTC calendar month. Package credits have no window: the ledger holds them beside the window (`reservation-ledger.ts`).
 *
 * `key` names the span inside the ledger's keys and in a reservation's id: the date `YYYY-MM-DD` of a day, so the day keys are those
 * that existed before paid quotas, and for a subscription `m<YYYY-MM>` (calendar month) or `b<ms>` (the span that ends at the
 * renewal `<ms>`). The key does not name the size: a switch to another size is billed in full (`full_immediately`, entry 285). When the
 * provider moves the period, the new one has a key and a count of its own and the credits left in the old one expire; when it does not,
 * the count stays under the new limit, so a switch never hands out credits that were not paid for at either price.
 * A key never holds an underscore, which a reservation id reads its parts by.
 */
export interface QuotaWindow {
  period: QuotaPeriod;
  key: string;
  /** When the count starts again, in milliseconds since the epoch. */
  endsAt: number;
}

/** What an account may spend from its window: the window, the credits it holds, and whether a subscription gives it. */
export interface QuotaAllowance {
  window: QuotaWindow;
  limit: number;
  subscribed: boolean;
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

/** The window of the live subscription of `userId`, with the credits it holds; undefined when the account has none. */
async function subscriptionAllowance(userId: string, now: number): Promise<QuotaAllowance | undefined> {
  const subscription = await subscriptionStore.findByUser(userId);
  if (!subscription || entitlementOf(subscription, now).tier !== 'paid') return undefined;
  const periodEnd = subscription.currentPeriodEnd;
  const window = (periodEnd === undefined ? undefined : billingMonthWindow(periodEnd, now)) ?? calendarMonthWindow(now);
  return { window, limit: subscription.credits, subscribed: true };
}

/** What `userId` may spend, and since when it has been counted: the subscription's period when it has one, else the UTC day. One read of the subscription for an account. */
export async function quotaAllowanceOf(userId: string, now: number = Date.now()): Promise<QuotaAllowance> {
  if (isAnonymousUserId(userId)) return { window: dayWindow(now), limit: getAnonymousDailyLimit(), subscribed: false };
  return (await subscriptionAllowance(userId, now)) ?? { window: dayWindow(now), limit: FREE_DAILY_CREDITS, subscribed: false };
}
