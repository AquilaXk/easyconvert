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

/** The seconds a `Retry-After` header names: delay-seconds, or an HTTP-date counted from `now` (RFC 9110, section 10.2.3); null for anything else. */
function retryAfterSeconds(retryAfter: string | null, now: number): number | null {
  const value = retryAfter?.trim() ?? '';
  if (/^\d+$/.test(value)) return Number(value);
  const date = value === '' ? Number.NaN : Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, (date - now) / 1000);
}

/**
 * The pause before retry number `tryNumber` + 1. It doubles with the attempt; a host that refuses for its rate or load and names
 * the time to wait (`Retry-After`, in seconds or as a date) is waited for that long, up to RATE_LIMIT_MAX_WAIT_MS, and a rate limit
 * that names no time gets RATE_LIMIT_DEFAULT_WAIT_MS. The pause is never shorter than the ordinary one.
 */
export function retryDelayMs(tryNumber: number, status: number | null, retryAfter: string | null, now: number = Date.now()): number {
  const ordinary = BACKOFF_BASE_MS * 2 ** tryNumber;
  const seconds = retryAfterSeconds(retryAfter, now);
  if (seconds !== null && status !== null && isBusyHostStatus(status)) return Math.max(ordinary, Math.min(seconds * 1000, RATE_LIMIT_MAX_WAIT_MS));
  if (status === HTTP_TOO_MANY_REQUESTS) return Math.max(ordinary, RATE_LIMIT_DEFAULT_WAIT_MS);
  return ordinary;
}

/**
 * The gap between two requests to a host that has refused for its rate, 3 s: the strictest published limit of a corpus host is
 * 20 requests a minute (the JSON API of loc.gov, "Working within limits"), whose block lasts an hour and restarts at every request
 * made during it. A host that never refused is not spaced.
 */
export const LIMITED_HOST_GAP_MS = 3000;

interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const systemClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

/**
 * What the downloads of one process know about the hosts that refused them. A refusal for rate or load is a statement about the
 * host, not about the request: when one download is told to wait, the others that go to the same host wait too, and are released one
 * per LIMITED_HOST_GAP_MS, so eight concurrent downloads do not answer a 429 with eight more requests.
 */
export class HostPacer {
  private readonly nextFreeAt = new Map<string, number>();

  constructor(private readonly clock: Clock = systemClock) {}

  /** Records that `host` asked for `waitMs` of quiet, keeping the longer of two waits. */
  noteBusy(host: string, waitMs: number): void {
    this.nextFreeAt.set(host, Math.max(this.nextFreeAt.get(host) ?? 0, this.clock.now() + waitMs));
  }

  /** Resolves when a request to `host` may start. The slot is taken before the wait begins, so callers that wait together leave in turn. */
  async beforeRequest(host: string): Promise<void> {
    const now = this.clock.now();
    const free = this.nextFreeAt.get(host);
    if (free === undefined) return;
    if (free <= now) {
      this.nextFreeAt.delete(host);
      return;
    }
    this.nextFreeAt.set(host, free + LIMITED_HOST_GAP_MS);
    await this.clock.sleep(free - now);
  }
}

/** The pacer both sample fetchers share, since the parity benchmark and the real-world corpus can read from one host in one process. */
export const hostPacer = new HostPacer();

/**
 * What a failed request says about itself. `fetch` reports every network failure (DNS, refused or reset connection, timeout,
 * unreachable address) as `TypeError: fetch failed` and keeps the reason in `cause`; a log that drops it cannot tell a host that
 * is down from a runner that cannot reach it.
 */
export function describeFetchFailure(error: unknown): string {
  const summary = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? error.cause : undefined;
  if (!(cause instanceof Error)) return summary;
  const code = (cause as NodeJS.ErrnoException).code;
  return `${summary} (${code === undefined ? cause.message : `${code}: ${cause.message}`})`;
}
