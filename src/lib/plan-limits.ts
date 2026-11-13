import type { UserTier } from './auth/types';
import { formatBytes } from './format-bytes';
import { isAnonymousUserId } from './auth/anonymous-identity';

/**
 * The limits of each plan. Every server entry point that accepts file bytes and every client check reads this table, so the
 * number shown to a visitor is the number the server enforces.
 *
 * Anonymous callers and the free plan share the limits of entry 16 of docs/policy-decisions.md (1 GiB, 5 conversions at once,
 * 5 minutes). One paid plan follows the credit model of entry 285: an account with package credits or a subscription has 10 GiB,
 * 25 conversions at once, 60 minutes and the high queue priority, whatever it bought.
 */
export type Plan = 'anonymous' | UserTier;

/** Who a limit is for: an id (anonymous ids get the anonymous plan) and the tier of an account. */
export interface PlanCaller {
  id?: string;
  tier?: string;
}

/**
 * Credits a free account may spend on the server each UTC day (`FREE_DAILY_CREDITS`): the 10 of the free plan of the
 * converter the product is measured against (QA decisions of 2026-11-03 and 2026-11-13, entries 15 and 285).
 */
export const FREE_DAILY_CREDITS = 10;

export const DEFAULT_FREE_CONCURRENCY = 5;

/** Conversions an account may have in flight at once (queued and running), by plan: the defaults of `CONVERSION_CONCURRENCY_<TIER>`. */
export const PLAN_CONCURRENCY: Readonly<Record<UserTier, number>> = {
  free: DEFAULT_FREE_CONCURRENCY,
  paid: 25,
};

/** Minutes of wall-clock time one conversion of the free plan may run: the default of `JOB_DEADLINE_MAX_MS_FREE`. */
export const FREE_PROCESSING_MINUTES = 5;

/** Minutes of wall-clock time one conversion may run, by plan: the defaults of `JOB_DEADLINE_MAX_MS_<TIER>`. */
export const PLAN_PROCESSING_MINUTES: Readonly<Record<UserTier, number>> = {
  free: FREE_PROCESSING_MINUTES,
  paid: 60,
};

/** Minutes a converted file stays downloadable after its first complete download: the default of `RESULT_DELIVERED_GRACE_SECONDS`. */
export const DELIVERED_FILE_RETENTION_MINUTES = 10;

export const API_KEY_BURST_LIMITS: Readonly<Record<UserTier, { capacity: number; refillRate: number }>> = {
  free: { capacity: 20, refillRate: 2 },
  paid: { capacity: 100, refillRate: 20 },
};

/** Whether `value` names an account tier. */
export function isUserTier(value: string): value is UserTier {
  return Object.hasOwn(API_KEY_BURST_LIMITS, value);
}

/** How long the credits of an allowance last before the count starts again: a UTC day for the free plan, a billing period for a subscription. */
export type QuotaPeriod = 'day' | 'month';

/**
 * Credits a caller without an account may spend on the server each UTC day, the default of `ANONYMOUS_DAILY_LIMIT`
 * (docs/policy-decisions.md, entries 15, 16 and 285). QA set it equal to the free account's on 2026-11-03; it is its own
 * literal so that either can change alone. Browser-side conversions use no server and are not counted.
 */
export const ANONYMOUS_DAILY_CREDITS = 10;

/** The anonymous allowance the server enforces: `ANONYMOUS_DAILY_LIMIT` when the operator sets a positive integer. */
export function getAnonymousDailyLimit(): number {
  const parsed = parseInt(process.env.ANONYMOUS_DAILY_LIMIT ?? '', 10);
  return parsed > 0 ? parsed : ANONYMOUS_DAILY_CREDITS;
}

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

export const PLAN_MAX_FILE_BYTES: Readonly<Record<Plan, number>> = Object.freeze({
  anonymous: GIB,
  free: GIB,
  paid: 10 * GIB,
});

/** The ceiling of the table: what a transport (resumable upload, multipart session) must be able to carry. */
export const LARGEST_PLAN_FILE_BYTES = PLAN_MAX_FILE_BYTES.paid;

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

/** How an English sentence names a plan: after "for" or "On". */
export const PLAN_PHRASE: Readonly<Record<Plan, string>> = {
  anonymous: 'anonymous use',
  free: 'the free plan',
  paid: 'a paid plan',
};

/** The plan of a caller. An anonymous identity, a missing tier and a tier this table does not know get the smallest limit. */
export function planOfCaller(caller: PlanCaller | null | undefined): Plan {
  if (!caller || isAnonymousUserId(caller.id)) return 'anonymous';
  return caller.tier === 'paid' ? 'paid' : 'free';
}

export function maxFileBytes(plan: Plan): number {
  return PLAN_MAX_FILE_BYTES[plan];
}

/**
 * The paid plan, when it can be bought and its file limit is larger than `plan`'s; undefined otherwise, so a file over the paid limit is
 * offered no plan, since none takes more. Whether the paid plan can be bought is `isBillingConfigured()` on the server
 * (`src/lib/billing/config.ts`) and what `/api/billing/status` says in the browser; this module is bundled into the browser too and
 * reads no environment, so each caller says.
 */
function nextLargerPlan(plan: Plan, paidPlansOnSale: boolean): Plan | undefined {
  if (!paidPlansOnSale || PLAN_MAX_FILE_BYTES.paid <= PLAN_MAX_FILE_BYTES[plan]) return undefined;
  return 'paid';
}

/** The facts a message about a file over its plan's limit names, for the copy of any language to word. */
export interface FileTooLargeFacts {
  plan: Plan;
  sizeBytes: number;
  /** The size reads in exact bytes, because rounded it would read the same as the limit it is over. */
  sizeInExactBytes: boolean;
  limitBytes: number;
  /** The plan that allows a larger file and can be bought, with its limit. */
  next?: { plan: Plan; limitBytes: number };
}

export function fileTooLargeFacts(plan: Plan, sizeBytes: number, paidPlansOnSale: boolean): FileTooLargeFacts {
  const limitBytes = PLAN_MAX_FILE_BYTES[plan];
  const next = nextLargerPlan(plan, paidPlansOnSale);
  return {
    plan,
    sizeBytes,
    sizeInExactBytes: formatBytes(sizeBytes) === formatBytes(limitBytes),
    limitBytes,
    ...(next ? { next: { plan: next, limitBytes: PLAN_MAX_FILE_BYTES[next] } } : {}),
  };
}

/** What to tell the caller of a file over their limit: the size, the limit, and the paid plan's limit when it is on sale. */
export function fileTooLargeMessage(plan: Plan, sizeBytes: number, paidPlansOnSale: boolean): string {
  const facts = fileTooLargeFacts(plan, sizeBytes, paidPlansOnSale);
  const size = facts.sizeInExactBytes ? `${sizeBytes.toLocaleString('en-US')} bytes` : formatBytes(sizeBytes);
  const limit = `File size ${size} exceeds the ${formatBytes(facts.limitBytes)} limit for ${PLAN_PHRASE[plan]}.`;
  if (!facts.next) return limit;
  return `${limit} A paid plan allows files up to ${formatBytes(facts.next.limitBytes)}.`;
}
