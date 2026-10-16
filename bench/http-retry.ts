/**
 * The retry pause both sample fetchers use (the parity corpus in `corpora.ts` and the real-world corpus in `realworld/http.ts`), so
 * one policy decides how long a busy host is waited for.
 */

const BACKOFF_BASE_MS = 2000;
export const HTTP_TOO_MANY_REQUESTS = 429;
export const HTTP_UNAVAILABLE = 503;
/** A rate limit that names no time is a window of seconds to minutes; the pause that fits it. */
const RATE_LIMIT_DEFAULT_WAIT_MS = 30_000;
/** The longest pause a host may ask for; a longer one is a failed fetch, which the cache of the verified samples lets the next run resume. */
const RATE_LIMIT_MAX_WAIT_MS = 120_000;

/** True for a status by which a host refuses for its rate (429) or its load (503). */
export function isBusyHostStatus(status: number): boolean {
  return status === HTTP_TOO_MANY_REQUESTS || status === HTTP_UNAVAILABLE;
}

/**
 * The pause before retry number `tryNumber` + 1. It doubles with the attempt; a host that refuses for its rate or load and names
 * the seconds to wait (`Retry-After`) is waited for that long, up to RATE_LIMIT_MAX_WAIT_MS, and a rate limit that names no time
 * gets RATE_LIMIT_DEFAULT_WAIT_MS. The pause is never shorter than the ordinary one.
 */
export function retryDelayMs(tryNumber: number, status: number | null, retryAfter: string | null): number {
  const ordinary = BACKOFF_BASE_MS * 2 ** tryNumber;
  const seconds = retryAfter !== null && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) : null;
  if (seconds !== null && status !== null && isBusyHostStatus(status)) return Math.max(ordinary, Math.min(seconds * 1000, RATE_LIMIT_MAX_WAIT_MS));
  if (status === HTTP_TOO_MANY_REQUESTS) return Math.max(ordinary, RATE_LIMIT_DEFAULT_WAIT_MS);
  return ordinary;
}
