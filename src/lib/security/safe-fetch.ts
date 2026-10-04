import { fetch as undiciFetch, type Dispatcher, type RequestInit as UndiciRequestInit } from 'undici';
import { createSsrfSafeAgent, validateUrlForSsrf } from './ssrf';

/** Redirects followed for a GET or HEAD request; other methods never follow redirects. */
export const MAX_SAFE_REDIRECTS = 3;
const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);
const BODYLESS_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);
const REDIRECT_MIN_STATUS = 300;
const REDIRECT_MAX_STATUS = 399;

/** An outbound request was refused because its target is not a public HTTP(S) address. */
export class OutboundRequestBlockedError extends Error {
  constructor(readonly target: string, reason: string) {
    super(`Outbound request to "${target}" blocked: ${reason}`);
    this.name = 'OutboundRequestBlockedError';
  }
}

export interface SafeFetchOptions {
  /** Connection dispatcher. Defaults to an agent that re-checks every resolved IP at connect time. */
  dispatcher?: Dispatcher;
  maxRedirects?: number;
}

async function assertPublicHttpUrl(url: URL): Promise<void> {
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new OutboundRequestBlockedError(url.href, `scheme "${url.protocol}" is not allowed`);
  }
  if (!(await validateUrlForSsrf(url))) {
    throw new OutboundRequestBlockedError(url.href, 'the host is private, loopback, link-local, or unresolvable');
  }
}

/**
 * Fetches a user-supplied URL without reaching internal networks. Every hop is validated before
 * it is requested and pinned again at connect time. GET and HEAD follow at most
 * `maxRedirects` redirects; any other method fails on a redirect instead of resending its body.
 */
export async function safeFetch(
  input: string,
  init: UndiciRequestInit = {},
  options: SafeFetchOptions = {}
): Promise<Response> {
  const dispatcher = options.dispatcher ?? createSsrfSafeAgent();
  const maxRedirects = options.maxRedirects ?? MAX_SAFE_REDIRECTS;
  const method = (init.method ?? 'GET').toUpperCase();

  let current: URL;
  try {
    current = new URL(input);
  } catch {
    throw new OutboundRequestBlockedError(input, 'not a valid URL');
  }

  for (let redirects = 0; ; redirects++) {
    await assertPublicHttpUrl(current);
    const response = (await undiciFetch(current, { ...init, method, dispatcher, redirect: 'manual' })) as unknown as Response;
    if (response.status < REDIRECT_MIN_STATUS || response.status > REDIRECT_MAX_STATUS) {
      return response;
    }

    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!location) {
      throw new Error(`Redirect ${response.status} from ${current.href} has no Location header`);
    }
    if (!BODYLESS_METHODS.has(method)) {
      throw new Error(`Refusing to follow a ${response.status} redirect for a ${method} request to ${current.href}`);
    }
    if (redirects >= maxRedirects) {
      throw new Error(`Too many redirects (more than ${maxRedirects}) starting from ${input}`);
    }
    current = new URL(location, current);
  }
}
