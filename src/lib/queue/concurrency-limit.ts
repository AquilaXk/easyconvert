import type { NextResponse } from 'next/server';
import type { UserTier } from '../auth/types';
import { createProblemDetailsResponse } from '../api/problem-details';
import { DEFAULT_FREE_CONCURRENCY, PLAN_CONCURRENCY, isUserTier } from '../plan-limits';
import { conversionQueue } from './conversion-queue';
import { readIntegerSetting } from './job-deadline';

/**
 * How many conversions a caller may have in flight (queued plus running): five for an anonymous or free caller
 * (`CONVERSION_CONCURRENCY_FREE`), and 10, 25 and 50 for Basic, Pro and Enterprise (`CONVERSION_CONCURRENCY_BASIC`,
 * `_PRO`, `_ENTERPRISE`; entry 280). The count is made on the server: queued and running jobs
 * come from the job queue (its index of jobs by user, shared by every web process), synchronous conversions from the
 * slots held by the requests of this process. A request over the limit is answered 429 and takes no quota.
 *
 * The queue count and the check that follows it are not one atomic step, so simultaneous submissions of the same
 * caller can overshoot the limit by the number of requests that race; the synchronous slots are per web process.
 */

/** The variable that sets the limit of each tier. */
export const CONCURRENCY_LIMIT_ENV = {
  free: 'CONVERSION_CONCURRENCY_FREE',
  basic: 'CONVERSION_CONCURRENCY_BASIC',
  pro: 'CONVERSION_CONCURRENCY_PRO',
  enterprise: 'CONVERSION_CONCURRENCY_ENTERPRISE',
} as const satisfies Record<UserTier, string>;
export { DEFAULT_FREE_CONCURRENCY };
export const CONCURRENCY_LIMIT_PROBLEM_TYPE = 'https://api.easyconvert.io/problems/concurrency-limit';
/** Seconds a refused caller is told to wait before trying again. */
export const CONCURRENCY_RETRY_AFTER_SECONDS = 5;

const FREE_TIER = 'free';
const IN_FLIGHT_STATES = ['waiting', 'active', 'delayed'] as const;
const HTTP_TOO_MANY_REQUESTS = 429;

/** The limit for a caller of `tier`: a missing or unknown tier is an anonymous or free caller's. */
export function concurrencyLimitFor(tier: string | undefined, env: Record<string, string | undefined> = process.env): number {
  const normalized = (tier ?? FREE_TIER).toLowerCase();
  const known: UserTier = isUserTier(normalized) ? normalized : FREE_TIER;
  return readIntegerSetting(env, CONCURRENCY_LIMIT_ENV[known], PLAN_CONCURRENCY[known]);
}

const syncInFlight = new Map<string, number>();

/** Synchronous conversions in flight in this process (all callers); for tests and diagnostics. */
export function syncSlotsInUse(): number {
  let total = 0;
  for (const count of syncInFlight.values()) total += count;
  return total;
}

async function queuedJobs(userId: string, limit: number): Promise<number> {
  const jobs = await conversionQueue.getJobsByUser(userId, [...IN_FLIGHT_STATES], limit, 0);
  return jobs.length;
}

function takeSyncSlot(userId: string): () => void {
  syncInFlight.set(userId, (syncInFlight.get(userId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (syncInFlight.get(userId) ?? 1) - 1;
    if (left > 0) syncInFlight.set(userId, left);
    else syncInFlight.delete(userId);
  };
}

export type ConversionSlot = { granted: true; release: () => void } | { granted: false; limit: number };

/** Takes a slot for a synchronous conversion of `userId`, held until `release` is called. Not granted when the caller already has `limit` conversions in flight. */
export async function acquireSyncSlot(userId: string, tier: string | undefined): Promise<ConversionSlot> {
  const limit = concurrencyLimitFor(tier);
  // The slot is taken before the queue is asked, so requests that race on this process cannot all pass the check.
  const release = takeSyncSlot(userId);
  try {
    const mine = syncInFlight.get(userId) ?? 1;
    if (mine > limit || mine + (await queuedJobs(userId, limit)) > limit) {
      release();
      return { granted: false, limit };
    }
  } catch (error) {
    release();
    throw error;
  }
  return { granted: true, release };
}

/** Whether `userId` may put one more job on the queue; false when it already has `limit` conversions in flight. */
export async function mayEnqueue(userId: string, tier: string | undefined): Promise<{ allowed: true } | { allowed: false; limit: number }> {
  const limit = concurrencyLimitFor(tier);
  const inFlight = (syncInFlight.get(userId) ?? 0) + (await queuedJobs(userId, limit));
  return inFlight >= limit ? { allowed: false, limit } : { allowed: true };
}

/** The 429 problem response of a caller over its limit. */
export function concurrencyLimitResponse(limit: number, instance: string, extraHeaders: Record<string, string> = {}): NextResponse {
  return createProblemDetailsResponse(
    HTTP_TOO_MANY_REQUESTS,
    `This account already has ${limit} conversions in progress. Wait for one to finish, then try again.`,
    instance,
    'Too Many Requests',
    CONCURRENCY_LIMIT_PROBLEM_TYPE,
    { ...extraHeaders, 'Retry-After': String(CONCURRENCY_RETRY_AFTER_SECONDS) },
    undefined,
    { limit }
  );
}
