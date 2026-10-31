import type { UserTier } from './auth/types';
import { formatBytes } from './format-bytes';

/**
 * The largest file one conversion may take, by plan. Every server entry point that accepts file bytes and every
 * client check reads this table, so the number shown to a visitor is the number the server enforces.
 *
 * Anonymous callers and the free plan share the limit of entry 16 of docs/policy-decisions.md (1 GB). The paid
 * plans follow the values the upload and job routes already gave them (5 GiB and 10 GiB).
 */
export type Plan = 'anonymous' | UserTier;

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

const PLAN_ORDER: readonly Plan[] = ['anonymous', 'free', 'pro', 'enterprise'];

export const PLAN_MAX_FILE_BYTES: Readonly<Record<Plan, number>> = Object.freeze({
  anonymous: GIB,
  free: GIB,
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

const ANONYMOUS_USER_PREFIX = 'anon:';

/** Whether `userId` names an anonymous caller (a client address bucket), not a signed-in account. */
export function isAnonymousUserId(userId: string | undefined): boolean {
  return userId?.startsWith(ANONYMOUS_USER_PREFIX) ?? false;
}

/** Whether a file of `sizeBytes` is too large for one request and must go to the server in parts. */
export function needsUploadInParts(sizeBytes: number): boolean {
  return sizeBytes > SINGLE_REQUEST_FILE_MAX_BYTES;
}

const PLAN_PHRASE: Readonly<Record<Plan, string>> = {
  anonymous: 'anonymous use',
  free: 'the free plan',
  pro: 'the Pro plan',
  enterprise: 'the Enterprise plan',
};

const PLAN_NAME: Readonly<Record<Plan, string>> = {
  anonymous: 'Anonymous',
  free: 'Free',
  pro: 'Pro',
  enterprise: 'Enterprise',
};

/** The plan of a caller. An anonymous identity, a missing tier and a tier this table does not know get the smallest limit. */
export function planOfCaller(caller: { id?: string; tier?: string } | null | undefined): Plan {
  if (!caller || isAnonymousUserId(caller.id)) return 'anonymous';
  return caller.tier === 'pro' || caller.tier === 'enterprise' ? caller.tier : 'free';
}

export function maxFileBytes(plan: Plan): number {
  return PLAN_MAX_FILE_BYTES[plan];
}

/** The first plan after `plan` that allows a larger file, or undefined when `plan` has the largest limit. */
export function nextLargerPlan(plan: Plan): Plan | undefined {
  const limit = PLAN_MAX_FILE_BYTES[plan];
  return PLAN_ORDER.slice(PLAN_ORDER.indexOf(plan) + 1).find((candidate) => PLAN_MAX_FILE_BYTES[candidate] > limit);
}

export function planName(plan: Plan): string {
  return PLAN_NAME[plan];
}

/** The line a visitor sees under the drop zone, for example `Up to 1 GB per file`. */
export function fileLimitCopy(plan: Plan): string {
  return `Up to ${formatBytes(PLAN_MAX_FILE_BYTES[plan])} per file`;
}

/** The size of a file for a message, in exact bytes when its rounded size would read the same as the limit it is over. */
function sizeForMessage(sizeBytes: number, limitBytes: number): string {
  const rounded = formatBytes(sizeBytes);
  return rounded === formatBytes(limitBytes) ? `${sizeBytes.toLocaleString('en-US')} bytes` : rounded;
}

/** What to tell the caller of a file over their limit: the size, the limit, and the next plan's limit when there is one. */
export function fileTooLargeMessage(plan: Plan, sizeBytes: number): string {
  const limitBytes = PLAN_MAX_FILE_BYTES[plan];
  const limit = `File size ${sizeForMessage(sizeBytes, limitBytes)} exceeds the ${formatBytes(limitBytes)} limit for ${PLAN_PHRASE[plan]}.`;
  const next = nextLargerPlan(plan);
  if (!next) return limit;
  return `${limit} ${PLAN_NAME[next]} allows files up to ${formatBytes(PLAN_MAX_FILE_BYTES[next])}.`;
}
