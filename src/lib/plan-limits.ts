import type { UserTier } from './auth/types';
import { formatBytes } from './format-bytes';
import { isAnonymousUserId } from './auth/anonymous-identity';

/**
 * The largest file one conversion may take, by plan. Every server entry point that accepts file bytes and every
 * client check reads this table, so the number shown to a visitor is the number the server enforces.
 *
 * Anonymous callers and the free plan share the limit of entry 16 of docs/policy-decisions.md (1 GiB). The paid plans
 * are Basic (2 GiB), Pro (5 GiB) and Enterprise (10 GiB), the figures QA set on 2026-11-13 (entry 280).
 */
export type Plan = 'anonymous' | UserTier;

/** Who a limit is for: an id (anonymous ids get the anonymous plan) and the tier of an account. */
export interface PlanCaller {
  id?: string;
  tier?: string;
}

/**
 * Conversions a free account may run on the server each UTC day (`TIER_LIMITS.free`): the 10 of the free plan of the
 * converter the product is measured against (QA decision of 2026-11-03, entry 15 of docs/policy-decisions.md).
 */
export const FREE_DAILY_CONVERSIONS = 10;

export const DEFAULT_FREE_CONCURRENCY = 5;

/** Conversions an account may have in flight at once (queued and running), by plan: the defaults of `CONVERSION_CONCURRENCY_<TIER>`. */
export const PLAN_CONCURRENCY: Readonly<Record<UserTier, number>> = {
  free: DEFAULT_FREE_CONCURRENCY,
  basic: 10,
  pro: 25,
  enterprise: 50,
};

/** Minutes of wall-clock time one conversion of the free plan may run: the default of `JOB_DEADLINE_MAX_MS_FREE`. */
export const FREE_PROCESSING_MINUTES = 5;

/** Minutes of wall-clock time one conversion may run, by plan: the defaults of `JOB_DEADLINE_MAX_MS_<TIER>`. */
export const PLAN_PROCESSING_MINUTES: Readonly<Record<UserTier, number>> = {
  free: FREE_PROCESSING_MINUTES,
  basic: 15,
  pro: 30,
  enterprise: 60,
};

/** Minutes a converted file stays downloadable after its first complete download: the default of `RESULT_DELIVERED_GRACE_SECONDS`. */
export const DELIVERED_FILE_RETENTION_MINUTES = 10;

export const API_KEY_BURST_LIMITS: Readonly<Record<UserTier, { capacity: number; refillRate: number }>> = {
  free: { capacity: 20, refillRate: 2 },
  basic: { capacity: 50, refillRate: 8 },
  pro: { capacity: 100, refillRate: 20 },
  enterprise: { capacity: 500, refillRate: 100 },
};

/**
 * The conversions each account plan may run on the server in one quota period, which `QUOTA_PERIOD` names: a UTC day for the free
 * plan, a month for the paid plans (entry 280). A caller without an account has `getAnonymousDailyLimit`.
 */
export const TIER_LIMITS: Readonly<Record<UserTier, number>> = {
  free: FREE_DAILY_CONVERSIONS,
  basic: 1000,
  pro: 3000,
  enterprise: 10000,
};

/** Whether `value` names an account tier. */
export function isUserTier(value: string): value is UserTier {
  return Object.hasOwn(TIER_LIMITS, value);
}

/** How long the conversions of a plan are counted before the count starts again. */
export type QuotaPeriod = 'day' | 'month';

/** The period of each plan's allowance: anonymous and free callers by the UTC day, paid plans by the month of the subscription. */
export const QUOTA_PERIOD: Readonly<Record<Plan, QuotaPeriod>> = {
  anonymous: 'day',
  free: 'day',
  basic: 'month',
  pro: 'month',
  enterprise: 'month',
};

/**
 * Conversions a caller without an account may run on the server each UTC day, the default of `ANONYMOUS_DAILY_LIMIT`
 * (docs/policy-decisions.md, entries 15 and 16). QA set it equal to the free account's on 2026-11-03; it is its own
 * literal so that either can change alone. Browser-side conversions use no server and are not counted.
 */
export const ANONYMOUS_DAILY_CONVERSIONS = 10;

/** The anonymous allowance the server enforces: `ANONYMOUS_DAILY_LIMIT` when the operator sets a positive integer. */
export function getAnonymousDailyLimit(): number {
  const parsed = parseInt(process.env.ANONYMOUS_DAILY_LIMIT ?? '', 10);
  return parsed > 0 ? parsed : ANONYMOUS_DAILY_CONVERSIONS;
}

/** Conversions `plan` may run on the server in one period of `QUOTA_PERIOD`: the anonymous allowance the server reads, or the account plan's. */
export function periodConversions(plan: Plan): number {
  return plan === 'anonymous' ? getAnonymousDailyLimit() : TIER_LIMITS[plan];
}

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

const PLAN_ORDER: readonly Plan[] = ['anonymous', 'free', 'basic', 'pro', 'enterprise'];

export const PLAN_MAX_FILE_BYTES: Readonly<Record<Plan, number>> = Object.freeze({
  anonymous: GIB,
  free: GIB,
  basic: 2 * GIB,
  pro: 5 * GIB,
  enterprise: 10 * GIB,
});

/** The ceiling of the table: what a transport (resumable upload, multipart session) must be able to carry. */
export const LARGEST_PLAN_FILE_BYTES = PLAN_MAX_FILE_BYTES.enterprise;

/**
 * The largest file one request may carry. A file over it goes to the server in parts of at most `UPLOAD_PART_MAX_BYTES`
 * and is converted by a job (docs/policy-decisions.md, entry 137). The edge in front of the web process takes a body of
 * 100 MB at most, and the framework holds a request body in memory up to `SINGLE_REQUEST_BODY_MAX_BYTES` before the
 * route reads it, so one number bounds both.
 */
export const SINGLE_REQUEST_FILE_MAX_BYTES = 64 * MIB;

/** The largest request body any route takes whole: a file of `SINGLE_REQUEST_FILE_MAX_BYTES` and 1 MiB of form fields. */
export const SINGLE_REQUEST_BODY_MAX_BYTES = SINGLE_REQUEST_FILE_MAX_BYTES + MIB;

/** The largest file the server takes from a link (`/api/fetch-url`), which it reads whole before the browser has it. */
export const URL_IMPORT_MAX_BYTES = 100 * MIB;

/** The largest part of an upload in parts, and the size the browser sends. */
export const UPLOAD_PART_MAX_BYTES = 64 * MIB;

/** The largest file a job takes in its own request (multipart form or base64): it is copied into the job record. */
export const INLINE_JOB_PAYLOAD_MAX_BYTES = 32 * MIB;

/** Whether a file of `sizeBytes` is too large for one request and must go to the server in parts. */
export function needsUploadInParts(sizeBytes: number): boolean {
  return sizeBytes > SINGLE_REQUEST_FILE_MAX_BYTES;
}

const PLAN_PHRASE: Readonly<Record<Plan, string>> = {
  anonymous: 'anonymous use',
  free: 'the free plan',
  basic: 'the Basic plan',
  pro: 'the Pro plan',
  enterprise: 'the Enterprise plan',
};

export const PLAN_NAME: Readonly<Record<Plan, string>> = {
  anonymous: 'Anonymous',
  free: 'Free',
  basic: 'Basic',
  pro: 'Pro',
  enterprise: 'Enterprise',
};

function isPaidTier(tier: string | undefined): tier is 'basic' | 'pro' | 'enterprise' {
  return tier === 'basic' || tier === 'pro' || tier === 'enterprise';
}

/** The plan of a caller. An anonymous identity, a missing tier and a tier this table does not know get the smallest limit. */
export function planOfCaller(caller: PlanCaller | null | undefined): Plan {
  if (!caller || isAnonymousUserId(caller.id)) return 'anonymous';
  return isPaidTier(caller.tier) ? caller.tier : 'free';
}

export function maxFileBytes(plan: Plan): number {
  return PLAN_MAX_FILE_BYTES[plan];
}

/**
 * The smallest plan after `plan` that can be bought and takes a file of `sizeBytes`, the largest one when none does, or undefined when no plan
 * after `plan` allows a larger file. Whether the paid plans can be
 * bought is `isBillingConfigured()` on the server (`src/lib/billing/config.ts`) and what `/api/billing/status` says in the browser; this
 * module is bundled into the browser too and reads no environment, so each caller says.
 */
function nextLargerPlan(plan: Plan, paidPlansOnSale: boolean, sizeBytes: number): Plan | undefined {
  if (!paidPlansOnSale) return undefined;
  const limit = PLAN_MAX_FILE_BYTES[plan];
  const larger = PLAN_ORDER.slice(PLAN_ORDER.indexOf(plan) + 1).filter((candidate) => PLAN_MAX_FILE_BYTES[candidate] > limit);
  return larger.find((candidate) => PLAN_MAX_FILE_BYTES[candidate] >= sizeBytes) ?? larger.at(-1);
}

/** The facts a message about a file over its plan's limit names, for the copy of any language to word. */
export interface FileTooLargeFacts {
  plan: Plan;
  sizeBytes: number;
  /** The size reads in exact bytes, because rounded it would read the same as the limit it is over. */
  sizeInExactBytes: boolean;
  limitBytes: number;
  /** The next plan that allows a larger file and can be bought, with its limit. */
  next?: { plan: Plan; limitBytes: number };
}

export function fileTooLargeFacts(plan: Plan, sizeBytes: number, paidPlansOnSale: boolean): FileTooLargeFacts {
  const limitBytes = PLAN_MAX_FILE_BYTES[plan];
  const next = nextLargerPlan(plan, paidPlansOnSale, sizeBytes);
  return {
    plan,
    sizeBytes,
    sizeInExactBytes: formatBytes(sizeBytes) === formatBytes(limitBytes),
    limitBytes,
    ...(next ? { next: { plan: next, limitBytes: PLAN_MAX_FILE_BYTES[next] } } : {}),
  };
}

/** What to tell the caller of a file over their limit: the size, the limit, and the next plan's limit when one is on sale. */
export function fileTooLargeMessage(plan: Plan, sizeBytes: number, paidPlansOnSale: boolean): string {
  const facts = fileTooLargeFacts(plan, sizeBytes, paidPlansOnSale);
  const size = facts.sizeInExactBytes ? `${sizeBytes.toLocaleString('en-US')} bytes` : formatBytes(sizeBytes);
  const limit = `File size ${size} exceeds the ${formatBytes(facts.limitBytes)} limit for ${PLAN_PHRASE[plan]}.`;
  if (!facts.next) return limit;
  return `${limit} ${PLAN_NAME[facts.next.plan]} allows files up to ${formatBytes(facts.next.limitBytes)}.`;
}
