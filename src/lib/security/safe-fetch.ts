import {
  fetch as undiciFetch,
  Headers as UndiciHeaders,
  type Dispatcher,
  type RequestInit as UndiciRequestInit,
} from 'undici';
import { createSsrfSafeAgent, validateUrlForSsrf } from './ssrf';

/** Redirects followed for a GET or HEAD request; other methods never follow redirects. */
export const MAX_SAFE_REDIRECTS = 3;
const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);
const BODYLESS_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);
const REDIRECT_MIN_STATUS = 300;
const REDIRECT_MAX_STATUS = 399;
const UNPARSEABLE_TARGET = '(invalid URL)';

/** An outbound request was refused because its target is not a public HTTP(S) address. */
export class OutboundRequestBlockedError extends Error {
  constructor(readonly target: string, reason: string) {
    super(`Outbound request to "${target}" blocked: ${reason}`);
    this.name = 'OutboundRequestBlockedError';
  }
}

export interface SafeFetchOptions {
  /** Connection dispatcher. Defaults to a shared agent that re-checks every resolved IP at connect time. */
  dispatcher?: Dispatcher;
  maxRedirects?: number;
}

let sharedAgent: Dispatcher | null = null;

/** One connection agent for every safeFetch call that does not bring its own, so sockets are pooled. */
function defaultDispatcher(): Dispatcher {
  sharedAgent ??= createSsrfSafeAgent();
  return sharedAgent;
}

/** Origin and path only, so query-string credentials never reach error messages or logs. */
function describeTarget(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

async function assertPublicHttpUrl(url: URL): Promise<void> {
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new OutboundRequestBlockedError(describeTarget(url), `scheme "${url.protocol}" is not allowed`);
  }
  if (!(await validateUrlForSsrf(url))) {
    throw new OutboundRequestBlockedError(
      describeTarget(url),
      'the host is private, loopback, link-local, or unresolvable'
    );
  }
}

/**
 * Fetches a user-supplied URL without reaching internal networks. Every hop is validated before
 * it is requested and pinned again at connect time. GET and HEAD follow at most
 * `maxRedirects` redirects; any other method fails on a redirect instead of resending its body.
 * Every caller-supplied header is dropped once a redirect leaves the original origin.
 */
export async function safeFetch(
  input: string,
  init: UndiciRequestInit = {},
  options: SafeFetchOptions = {}
): Promise<Response> {
  const dispatcher = options.dispatcher ?? defaultDispatcher();
  const maxRedirects = options.maxRedirects ?? MAX_SAFE_REDIRECTS;
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new UndiciHeaders(init.headers);

  let current: URL;
  try {
    current = new URL(input);
  } catch {
    throw new OutboundRequestBlockedError(UNPARSEABLE_TARGET, 'not a valid URL');
  }
  const start = current;

  for (let redirects = 0; ; redirects++) {
    await assertPublicHttpUrl(current);
    const response = (await undiciFetch(current, {
      ...init,
      method,
      headers,
      dispatcher,
      redirect: 'manual',
    })) as unknown as Response;
    if (response.status < REDIRECT_MIN_STATUS || response.status > REDIRECT_MAX_STATUS) {
      return response;
    }

    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!location) {
      throw new OutboundRequestBlockedError(describeTarget(current), `redirect ${response.status} has no Location header`);
    }
    if (!BODYLESS_METHODS.has(method)) {
      throw new OutboundRequestBlockedError(
        describeTarget(current),
        `refusing to follow a ${response.status} redirect for a ${method} request`
      );
    }
    if (redirects >= maxRedirects) {
      throw new OutboundRequestBlockedError(describeTarget(start), `too many redirects (more than ${maxRedirects})`);
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new OutboundRequestBlockedError(describeTarget(current), 'redirect Location is not a valid URL');
    }
    if (next.origin !== current.origin) {
      // Which header carries a credential is the caller's secret (X-Api-Key, X-Amz-Security-Token, ...),
      // so nothing the caller supplied follows a redirect to another origin.
      for (const name of [...headers.keys()]) {
        headers.delete(name);
      }
    }
    current = next;
  }
}
