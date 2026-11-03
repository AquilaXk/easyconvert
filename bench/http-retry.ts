/**
 * The retry loop both sample fetchers use (the parity corpus in `corpora.ts` and the real-world corpus in `realworld/http.ts`), so
 * one policy decides how long a busy host is waited for and how the downloads to it are spaced.
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

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SHORT_WEEKDAY = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)';
const LONG_WEEKDAY = '(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)';
const MONTH = `(?<month>${MONTH_NAMES.join('|')})`;
const TIME = '(?<hour>\\d{2}):(?<minute>\\d{2}):(?<second>\\d{2})';
/** The three HTTP-date forms of RFC 9110, section 5.6.7: IMF-fixdate, the obsolete RFC 850 form with a two-digit year, and asctime. */
const HTTP_DATE_FORMS: readonly RegExp[] = [
  new RegExp(`^${SHORT_WEEKDAY}, (?<day>\\d{2}) ${MONTH} (?<year>\\d{4}) ${TIME} GMT$`),
  new RegExp(`^${LONG_WEEKDAY}, (?<day>\\d{2})-${MONTH}-(?<year>\\d{2}) ${TIME} GMT$`),
  new RegExp(`^${SHORT_WEEKDAY} ${MONTH} (?<day>[ \\d]\\d) ${TIME} (?<year>\\d{4})$`),
];
const TWO_DIGIT_YEAR_WINDOW = 50;

/** The instant an HTTP-date names, or null for anything that is not one of the three forms or not a real date. */
function httpDateMs(value: string, now: number): number | null {
  for (const form of HTTP_DATE_FORMS) {
    const groups = form.exec(value)?.groups;
    if (groups === undefined) continue;
    let year = Number(groups.year);
    if (groups.year.length === 2) {
      const currentYear = new Date(now).getUTCFullYear();
      year += Math.floor(currentYear / 100) * 100;
      if (year > currentYear + TWO_DIGIT_YEAR_WINDOW) year -= 100;
    }
    const month = MONTH_NAMES.indexOf(groups.month);
    const day = Number(groups.day.trim());
    const instant = new Date(Date.UTC(year, month, day, Number(groups.hour), Number(groups.minute), Number(groups.second)));
    const real = instant.getUTCFullYear() === year && instant.getUTCMonth() === month && instant.getUTCDate() === day && Number(groups.hour) < 24 && Number(groups.minute) < 60 && Number(groups.second) < 61;
    return real ? instant.getTime() : null;
  }
  return null;
}

/**
 * The seconds a `Retry-After` header names, null when it names no time to wait. Only the two forms of RFC 9110, section 10.2.3
 * count: whole seconds, or an HTTP-date counted from `now`. Read as urllib3 reads it (`Retry.parse_retry_after`, urllib3
 * src/urllib3/util/retry.py:346-368 at c5347bbd): digits, else a date that must parse, a date already past is zero seconds. Unlike
 * urllib3, which skips the pause for zero, a wait of zero or less is "no time named" here, so a refusal is never answered at once.
 */
function retryAfterSeconds(retryAfter: string | null, now: number): number | null {
  const value = retryAfter?.trim() ?? '';
  const seconds = /^\d+$/.test(value) ? Number(value) : ((httpDateMs(value, now) ?? Number.NaN) - now) / 1000;
  return seconds > 0 ? seconds : null;
}

/**
 * The pause before retry number `tryNumber` + 1. It doubles with the attempt; a host that refuses for its rate or load and names
 * the time to wait (`Retry-After`, in seconds or as a date) is waited for that long, up to RATE_LIMIT_MAX_WAIT_MS, and a rate limit
 * that names no time (or a time already past) gets RATE_LIMIT_DEFAULT_WAIT_MS. The pause is never shorter than the ordinary one.
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

interface HostState {
  blockedUntil: number;
  refusedAt: number;
  gapMs: number;
  lastRelease: number;
  waiting: Array<(releasedAt: number) => void>;
  draining: boolean;
}

/**
 * What the downloads of one process know about the hosts that refused them, kept per process: ten shards that run on ten runners
 * each pace themselves. A refusal for rate or load is a statement about the host, not about the request: while it holds, the
 * downloads to the same host queue, and one queued download is released per gap.
 *
 * The release loop follows Scrapy's per-host slot (`Downloader._process_queue`, scrapy/core/downloader/__init__.py:397-428, and
 * `_latercall`, :448-450, at e397746c): it releases one request, stamps `lastseen` in the same step, and re-reads the delay and the
 * stamp each time it wakes, so a delay that changed while the requests slept is the one that counts. Here that re-read is of
 * `blockedUntil` too, which a second refusal pushes out under the queued downloads. The gap shrinks as Scrapy's AutoThrottle
 * shrinks a slot's delay (`_adjust_delay`, scrapy/extensions/throttle.py:100-125): each good response moves it to the mean of the
 * delay and a target, here a target of zero, and a response that is not good, or a request that left before the last refusal,
 * does not lower it. Bottleneck's `minTime` reserves the next slot in the step that grants the current one
 * (`LocalDatastore.__register__`, src/LocalDatastore.coffee:107-116, MIT, 2.19.5). Unlike both, nothing is kept once the queue has
 * emptied and the cooldown has passed, so a host that refused once is not spaced for the rest of the run.
 */
export class HostPacer {
  private readonly hosts = new Map<string, HostState>();

  constructor(private readonly clock: Clock = systemClock) {}

  /** Records that `host` asked for `waitMs` of quiet, keeping the longer of two waits, and spaces the downloads that follow. */
  noteBusy(host: string, waitMs: number): void {
    const now = this.clock.now();
    const state = this.hosts.get(host) ?? { blockedUntil: 0, refusedAt: 0, gapMs: 0, lastRelease: Number.NEGATIVE_INFINITY, waiting: [], draining: false };
    state.blockedUntil = Math.max(state.blockedUntil, now + waitMs);
    state.refusedAt = now;
    state.gapMs = LIMITED_HOST_GAP_MS;
    this.hosts.set(host, state);
  }

  /** Records a good response to a request that was released at `releasedAt`; the gap to the host halves. */
  noteSuccess(host: string, releasedAt: number): void {
    const state = this.hosts.get(host);
    if (state === undefined || releasedAt < state.refusedAt) return;
    state.gapMs = Math.floor(state.gapMs / 2);
  }

  /** Resolves with the time a request to `host` may start. Callers that wait together leave in turn, in the order they came. */
  beforeRequest(host: string): Promise<number> {
    const now = this.clock.now();
    const state = this.hosts.get(host);
    if (state === undefined) return Promise.resolve(now);
    if (state.waiting.length === 0 && now >= state.blockedUntil) {
      this.hosts.delete(host);
      return Promise.resolve(now);
    }
    return new Promise((resolve) => {
      state.waiting.push(resolve);
      void this.release(host, state);
    });
  }

  /** Waits on the clock the pacer runs on, so one clock orders every wait of a process. */
  sleep(ms: number): Promise<void> {
    return this.clock.sleep(ms);
  }

  private async release(host: string, state: HostState): Promise<void> {
    if (state.draining) return;
    state.draining = true;
    while (state.waiting.length > 0) {
      const now = this.clock.now();
      const readyAt = Math.max(state.blockedUntil, state.lastRelease + state.gapMs);
      if (readyAt > now) {
        await this.clock.sleep(readyAt - now);
        continue;
      }
      state.lastRelease = now;
      state.waiting.shift()?.(now);
    }
    state.draining = false;
    if (this.clock.now() >= state.blockedUntil && this.hosts.get(host) === state) this.hosts.delete(host);
  }
}

/** The pacer both sample fetchers share, since the parity benchmark and the real-world corpus can read from one host in one process. */
export const hostPacer = new HostPacer();

/** A host that refused for its rate (HTTP 429) or load (HTTP 503), with the `Retry-After` it sent and the host of the response that refused. */
export class BusyHostError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter: string | null,
    readonly refusedBy: string
  ) {
    super(message);
    this.name = 'BusyHostError';
  }
}

/** Throws BusyHostError when `response` refuses for rate or load. The host that refused is the one that answered, which a redirect makes another than the one asked. */
export function throwIfHostBusy(response: Response, requestedUrl: string, message: string): void {
  if (!isBusyHostStatus(response.status)) return;
  throw new BusyHostError(message, response.status, response.headers.get('retry-after'), new URL(response.url || requestedUrl).host);
}

/**
 * Runs `run` up to `retries` + 1 times against the host of `url`: each try waits its turn at the pacer, a refusal for rate or load
 * pauses the refusing host (and the host asked, which leads there) for the time retryDelayMs names, and any other failure is
 * waited out with the ordinary backoff. The error after the last try is made by `fail`, so each fetcher keeps its own error type.
 */
export async function retryPaced<T>(url: string, retries: number, run: () => Promise<T>, fail: (message: string) => Error, pacer: HostPacer = hostPacer): Promise<T> {
  const host = new URL(url).host;
  let last: unknown;
  for (let tryNumber = 0; tryNumber <= retries; tryNumber++) {
    const releasedAt = await pacer.beforeRequest(host);
    try {
      const result = await run();
      pacer.noteSuccess(host, releasedAt);
      return result;
    } catch (error) {
      last = error;
      if (error instanceof BusyHostError) {
        const waitMs = retryDelayMs(tryNumber, error.status, error.retryAfter);
        for (const refusing of new Set([host, error.refusedBy])) pacer.noteBusy(refusing, waitMs);
      } else if (tryNumber < retries) {
        await pacer.sleep(retryDelayMs(tryNumber, null, null));
      }
    }
  }
  throw fail(`${url}: failed after ${retries + 1} attempts: ${describeFetchFailure(last)}`);
}

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
