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
/** The seconds field of RFC 5322 runs to 60, for a leap second, which the timeline of POSIX time places on the first second of the next minute. */
const MAX_SECOND = 60;

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
    const [hour, minute, second] = [Number(groups.hour), Number(groups.minute), Number(groups.second)];
    const calendarDay = new Date(Date.UTC(year, month, day));
    const real = calendarDay.getUTCFullYear() === year && calendarDay.getUTCMonth() === month && calendarDay.getUTCDate() === day && hour < 24 && minute < 60 && second <= MAX_SECOND;
    return real ? Date.UTC(year, month, day, hour, minute, second) : null;
  }
  return null;
}

/**
 * The seconds a `Retry-After` header names, null when it names no time to wait. Only the two forms of RFC 9110, section 10.2.3
 * count: whole seconds, or an HTTP-date counted from `now`. The shape is urllib3's (`Retry.parse_retry_after`, urllib3
 * src/urllib3/util/retry.py:346-368 at c5347bbd): digits, else a date that must parse, a date already past is zero seconds. The date
 * is narrower here, the three forms of the RFC where urllib3 hands it to `email.utils.parsedate_tz`, and unlike urllib3, which skips
 * the pause for zero (`sleep_for_retry`, 380-386), a wait of zero or less is "no time named" here, so a refusal is never answered at once.
 */
function retryAfterSeconds(retryAfter: string | null, now: number): number | null {
  const value = retryAfter?.trim() ?? '';
  const seconds = /^\d+$/.test(value) ? Number(value) : ((httpDateMs(value, now) ?? Number.NaN) - now) / 1000;
  return seconds > 0 ? seconds : null;
}

/** The milliseconds a host that refused for its rate or load asked to be left alone, null when its status is not one of those or it named no time. */
function askedWaitMs(status: number | null, retryAfter: string | null, now: number): number | null {
  const seconds = retryAfterSeconds(retryAfter, now);
  return seconds !== null && status !== null && isBusyHostStatus(status) ? seconds * 1000 : null;
}

/** The pause a refusal with the wait `askedMs` (null when it named none) gets before try number `tryNumber` + 1. */
function pauseMs(tryNumber: number, status: number | null, askedMs: number | null): number {
  const ordinary = BACKOFF_BASE_MS * 2 ** tryNumber;
  if (askedMs !== null) return Math.max(ordinary, Math.min(askedMs, RATE_LIMIT_MAX_WAIT_MS));
  if (status === HTTP_TOO_MANY_REQUESTS) return Math.max(ordinary, RATE_LIMIT_DEFAULT_WAIT_MS);
  return ordinary;
}

/**
 * The pause before retry number `tryNumber` + 1. It doubles with the attempt; a host that refuses for its rate or load and names
 * the time to wait (`Retry-After`, in seconds or as a date) is waited for that long, up to RATE_LIMIT_MAX_WAIT_MS, and a rate limit
 * that names no time (or a time already past) gets RATE_LIMIT_DEFAULT_WAIT_MS. The pause is never shorter than the ordinary one.
 */
export function retryDelayMs(tryNumber: number, status: number | null, retryAfter: string | null, now: number = Date.now()): number {
  return pauseMs(tryNumber, status, askedWaitMs(status, retryAfter, now));
}

/**
 * The hosts that publish a request limit, with the spacing it gives; every other host is not spaced. This is Scrapy's per-slot
 * configuration (`DOWNLOAD_SLOTS`, scrapy/settings/default_settings.py:334, read by `Downloader._get_slot`,
 * scrapy/core/downloader/__init__.py:317-331 at e397746c), whose default delay is 0 (`DOWNLOAD_DELAY`, default_settings.py:315).
 */
export const PUBLISHED_SPACING_MS: ReadonlyMap<string, number> = new Map([
  // 150 requests a minute for media under /storage-services/ (www.loc.gov/apis/json-and-yaml/working-within-limits/).
  ['tile.loc.gov', 60_000 / 150],
]);

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

/** A request to a host that asked for more quiet than a download waits; it is refused without being sent, since a request inside the block may restart it. */
export class RetryAfterTooLongError extends Error {
  constructor(host: string, remainingMs: number) {
    super(`${host} asked to be left alone for ${Math.round(remainingMs / 1000)} s, longer than the ${RATE_LIMIT_MAX_WAIT_MS / 1000} s a download waits`);
    this.name = 'RetryAfterTooLongError';
  }
}

/** Throws BusyHostError when `response` refuses for rate or load. The host that refused is the one that answered, which a redirect makes another than the one asked. */
export function throwIfHostBusy(response: Response, requestedUrl: string, message: string): void {
  if (!isBusyHostStatus(response.status)) return;
  throw new BusyHostError(message, response.status, response.headers.get('retry-after'), new URL(response.url || requestedUrl).host);
}

interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const systemClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

interface Waiter {
  resolve(): void;
  reject(error: Error): void;
}

interface HostState {
  readonly spacingMs: number;
  /** The instant before which the host asked to be left alone, as long as it asked, so a block past the bound is known as one. */
  blockedUntil: number;
  lastRelease: number;
  waiting: Waiter[];
  draining: boolean;
}

/**
 * The turns of the requests of one process at each host, kept per process: ten shards on ten runners each pace themselves. A host
 * of PUBLISHED_SPACING_MS gets one request per its spacing from its first request on; any host that refused gets nothing until
 * the time it asked for has passed, and a request to a host whose block runs past RATE_LIMIT_MAX_WAIT_MS is refused at once.
 *
 * The release loop is Scrapy's per-slot queue (`Downloader._process_queue`, scrapy/core/downloader/__init__.py:397-428, and
 * `_latercall`, :448-450, at e397746c): it releases one request, stamps `lastseen` in the same step, and reads the delay and the
 * stamp again each time it wakes, so a block renewed while requests slept holds the requests already queued.
 */
export class HostPacer {
  private readonly hosts = new Map<string, HostState>();

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly spacing: ReadonlyMap<string, number> = PUBLISHED_SPACING_MS
  ) {}

  now(): number {
    return this.clock.now();
  }

  sleep(ms: number): Promise<void> {
    return this.clock.sleep(ms);
  }

  /** Runs `task`, one request to `host`, when the host's turn comes; requests that wait together leave in the order they came. */
  async run<T>(host: string, task: () => Promise<T>): Promise<T> {
    await this.turn(host);
    return task();
  }

  /** Holds `host` for `ms` from now, keeping the longer of two blocks, and refuses the requests waiting for it when the block runs past the bound. */
  pause(host: string, ms: number): void {
    const state = this.stateOf(host);
    state.blockedUntil = Math.max(state.blockedUntil, this.clock.now() + ms);
    const tooLong = this.blockPastBound(host, state);
    if (tooLong !== null) for (const waiter of state.waiting.splice(0)) waiter.reject(tooLong);
  }

  private stateOf(host: string): HostState {
    let state = this.hosts.get(host);
    if (state === undefined) {
      state = { spacingMs: this.spacing.get(host) ?? 0, blockedUntil: 0, lastRelease: Number.NEGATIVE_INFINITY, waiting: [], draining: false };
      this.hosts.set(host, state);
    }
    return state;
  }

  private blockPastBound(host: string, state: HostState): RetryAfterTooLongError | null {
    const remaining = state.blockedUntil - this.clock.now();
    return remaining > RATE_LIMIT_MAX_WAIT_MS ? new RetryAfterTooLongError(host, remaining) : null;
  }

  private turn(host: string): Promise<void> {
    const state = this.stateOf(host);
    const tooLong = this.blockPastBound(host, state);
    if (tooLong !== null) return Promise.reject(tooLong);
    return new Promise((resolve, reject) => {
      state.waiting.push({ resolve, reject });
      void this.drain(state);
    });
  }

  private async drain(state: HostState): Promise<void> {
    if (state.draining) return;
    state.draining = true;
    while (state.waiting.length > 0) {
      const now = this.clock.now();
      const readyAt = Math.max(state.blockedUntil, state.lastRelease + state.spacingMs);
      if (readyAt > now) {
        await this.clock.sleep(readyAt - now);
        continue;
      }
      state.lastRelease = now;
      state.waiting.shift()?.resolve();
    }
    state.draining = false;
  }
}

/** The pacer both sample fetchers share, since the parity benchmark and the real-world corpus can read from one host in one process. */
export const hostPacer = new HostPacer();

export interface PacedOptions {
  pacer?: HostPacer;
  /** The host the next try reaches, read before each try; the host of `url` unless a remembered redirect goes elsewhere. */
  contactedHost?: () => string;
}

/**
 * Runs `task` up to `retries` + 1 times, each try in its turn at the host it reaches. A refusal for rate or load holds that host,
 * the host that answered and the host of `url` for the time the refusal asked (`Retry-After`, read once), which the next try
 * waits for; a host that asked for longer than a download waits fails the download without another request. Any other failure is
 * waited out with the ordinary backoff. The error after the last try is made by `fail`, so each fetcher keeps its own error type.
 */
export async function retryPaced<T>(url: string, retries: number, task: () => Promise<T>, fail: (message: string) => Error, options: PacedOptions = {}): Promise<T> {
  const { pacer = hostPacer, contactedHost = () => new URL(url).host } = options;
  let last: unknown;
  for (let tryNumber = 0; tryNumber <= retries; tryNumber++) {
    const host = contactedHost();
    try {
      return await pacer.run(host, task);
    } catch (error) {
      if (error instanceof RetryAfterTooLongError) throw fail(`${url}: ${error.message}`);
      last = error;
      if (error instanceof BusyHostError) {
        const askedMs = askedWaitMs(error.status, error.retryAfter, pacer.now());
        const blockMs = askedMs !== null && askedMs > RATE_LIMIT_MAX_WAIT_MS ? askedMs : pauseMs(tryNumber, error.status, askedMs);
        for (const refusing of new Set([new URL(url).host, host, error.refusedBy])) pacer.pause(refusing, blockMs);
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
