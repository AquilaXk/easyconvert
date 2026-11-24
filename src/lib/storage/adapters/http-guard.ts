import { Agent, request, type Dispatcher } from 'undici';
import {
  StorageAdapterError,
  StorageInputError,
  StorageInvalidKeyError,
  StorageSsrfError,
  StorageTimeoutError,
  assertValidMaxFiles,
  assertValidUploadSize,
} from './adapter-interface';
import { ssrfSafeLookup, validateUrlForSsrf } from '../../security/ssrf';
import { ADAPTER_BODY_CAP_BYTES, ADAPTER_HEADERS_TIMEOUT_MS, ADAPTER_RESPONSE_TIMEOUT_MS } from './http-limits';
export { ADAPTER_BODY_CAP_BYTES, ADAPTER_HEADERS_TIMEOUT_MS, ADAPTER_RESPONSE_TIMEOUT_MS, assertValidMaxFiles, assertValidUploadSize };

const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR_MIN = 500;
const HTTP_SERVER_ERROR_MAX = 599;

/** Control characters, Unicode line/paragraph separators, and backslashes forbidden in adapter paths. */
export const FORBIDDEN_PATH_CHAR = /[\p{Cc}\p{Zl}\p{Zp}\\]/u;

export function isRetryableHttpStatus(statusCode: number): boolean {
  return statusCode === HTTP_TOO_MANY_REQUESTS || (statusCode >= HTTP_SERVER_ERROR_MIN && statusCode <= HTTP_SERVER_ERROR_MAX);
}

export function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) {
    end--;
  }
  return s.slice(0, end);
}

export function stripLeadingSlashes(s: string): string {
  let start = 0;
  while (start < s.length && s.charCodeAt(start) === 47) {
    start++;
  }
  return s.slice(start);
}

export function stripSlashes(s: string): string {
  return stripTrailingSlashes(stripLeadingSlashes(s));
}

export function encodeSafePathSegments(remotePath: string, provider: string): string {
  if (typeof remotePath !== 'string' || !remotePath || !remotePath.isWellFormed() || FORBIDDEN_PATH_CHAR.test(remotePath)) {
    const label = typeof remotePath === 'string' ? remotePath : typeof remotePath;
    throw new StorageInvalidKeyError(`Invalid remote path "${label}"`, provider);
  }
  const cleanPath = stripLeadingSlashes(remotePath);
  const segments = cleanPath.split('/');
  if (segments.length === 0 || segments.some((seg) => !seg || seg === '.' || seg === '..')) {
    throw new StorageInvalidKeyError(`Path traversal or empty segment rejected in "${remotePath}"`, provider);
  }
  return segments.map((seg) => encodeURIComponent(seg)).join('/');
}

export function assertValidAzureContainerName(containerName: unknown, provider = 'azure-blob'): asserts containerName is string {
  if (
    typeof containerName !== 'string' ||
    !containerName ||
    containerName === '.' ||
    !containerName.isWellFormed() ||
    FORBIDDEN_PATH_CHAR.test(containerName) ||
    containerName.includes('/') ||
    containerName.includes('..')
  ) {
    throw new StorageInputError('Invalid Azure Blob containerName', provider);
  }
}

/**
 * What the HTTP adapters (WebDAV, Azure Blob, GCS) share: an endpoint is reached over TLS and only when it resolves to
 * public addresses, a request that gets no answer is given up, and the body of an error or metadata answer is read
 * under a byte cap and a deadline. A streamed object is bounded by the callers' own limits, not by these.
 */

/**
 * Comma-separated `host:port` list of endpoints that may be private or plain HTTP, for a local server during
 * development. It is server configuration, never a field of the customer's credentials, and is honoured only when
 * NODE_ENV is exactly "development".
 */
export const BYOS_HTTP_DEV_ENDPOINT_ALLOWLIST_ENV = 'BYOS_HTTP_DEV_ENDPOINT_ALLOWLIST';

const DEVELOPMENT_ENV = 'development';

function devAllowlist(): ReadonlySet<string> {
  if (process.env.NODE_ENV !== DEVELOPMENT_ENV) return new Set();
  return new Set(
    (process.env[BYOS_HTTP_DEV_ENDPOINT_ALLOWLIST_ENV] ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
}

/** Whether the server's development allowlist names exactly this host and port. */
export function isDevAllowlistedEndpoint(url: URL): boolean {
  return devAllowlist().has(url.host.toLowerCase());
}

/** A refusal that does not echo the userinfo or query of the endpoint (`StorageSsrfError` masks them). */
export function assertTlsEndpoint(url: URL, provider: string): void {
  if (url.protocol !== 'https:') {
    throw new StorageSsrfError(`${url.protocol}//${url.host} (TLS is required)`, provider);
  }
}

/** Parses a customer-supplied base endpoint URL and rejects embedded credentials, query strings, or fragments without echoing the raw URL. */
export function parseCleanBaseEndpointUrl(rawUrl: string, provider: string, invalidMessage?: string): URL {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    throw new StorageAdapterError(invalidMessage ?? `Invalid ${provider} endpoint URL`, provider);
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new StorageAdapterError(invalidMessage ?? `Invalid ${provider} endpoint URL`, provider);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new StorageAdapterError(
      `Invalid ${provider} endpoint URL: embedded credentials, query parameters, and fragments are not permitted`,
      provider
    );
  }
  return parsed;
}

/** Whether `url` names the canonical Google Cloud Storage API host (or a development-allowlisted local test server). */
export function isTrustedGcsOAuthEndpoint(url: URL): boolean {
  if (isDevAllowlistedEndpoint(url)) return true;
  const host = url.host.toLowerCase();
  return url.protocol === 'https:' && (host === 'storage.googleapis.com' || host.endsWith('.storage.googleapis.com'));
}

/**
 * Refuses a URL before any request: it has to be https and resolve only to public addresses, unless the server's
 * development allowlist names its host. The connection is pinned again at connect time (`adapterDispatcher`).
 */
export async function assertAdapterUrlSafe(urlStr: string, provider: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    throw new StorageAdapterError('The storage endpoint does not form a valid URL', provider);
  }
  if (isDevAllowlistedEndpoint(url)) return;
  assertTlsEndpoint(url, provider);
  if (!(await validateUrlForSsrf(url))) {
    throw new StorageSsrfError(urlStr, provider);
  }
}

/** A connection agent that pins every connection to a public address (a development-allowlisted host is not pinned). */
export function adapterDispatcher(urlStr: string): Agent {
  const timeouts = { headersTimeout: ADAPTER_HEADERS_TIMEOUT_MS, bodyTimeout: ADAPTER_RESPONSE_TIMEOUT_MS };
  if (isDevAllowlistedEndpoint(new URL(urlStr))) return new Agent(timeouts);
  return new Agent({ ...timeouts, connect: { lookup: ssrfSafeLookup } });
}

/** Drops the agent and every request still on it, including a body nobody read. */
export async function releaseDispatcher(dispatcher: Dispatcher): Promise<void> {
  try {
    await dispatcher.destroy();
  } catch {
    // an agent that cannot be destroyed holds nothing past the request
  }
}

/**
 * `request`, with a listener on the body for the error an unread body gets when its agent is destroyed
 * (`ClientDestroyedError`): nobody reads that body, and without a listener the error would end the process.
 */
export type GuardedRequestOptions = Omit<NonNullable<Parameters<typeof request>[1]>, 'method'> & {
  method?: NonNullable<Parameters<typeof request>[1]>['method'] | 'PROPFIND';
};

export async function guardedRequest(
  url: Parameters<typeof request>[0],
  options?: GuardedRequestOptions
): Promise<Awaited<ReturnType<typeof request>>> {
  const res = await request(url, options as Parameters<typeof request>[1]);
  res.body.on('error', () => {});
  return res;
}

export interface BoundedBody {
  text: string;
  /** The body went past the cap; `text` holds its first `maxBytes`. */
  truncated: boolean;
}

/**
 * Reads at most `maxBytes` of a response body within `timeoutMs` in all. A body past the cap is cut and destroyed;
 * one that does not finish in time is destroyed and answers `StorageTimeoutError`.
 */
export async function readBoundedBody(
  body: AsyncIterable<unknown> & { destroy(error?: Error): unknown },
  provider: string,
  maxBytes = ADAPTER_BODY_CAP_BYTES,
  timeoutMs = ADAPTER_RESPONSE_TIMEOUT_MS
): Promise<BoundedBody> {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StorageTimeoutError(timeoutMs, provider)), timeoutMs);
  });
  const read = (async () => {
    for await (const chunk of body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      if (size + buf.length > maxBytes) {
        chunks.push(buf.subarray(0, maxBytes - size));
        truncated = true;
        return;
      }
      chunks.push(buf);
      size += buf.length;
    }
  })();
  // a read that loses the race is destroyed below and must not surface as an unhandled rejection
  read.catch(() => {});
  try {
    await Promise.race([read, deadline]);
  } finally {
    clearTimeout(timer);
    body.destroy();
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

/** The text of an error answer for a message: cut at the cap, and empty when the body is late or unreadable. */
export async function readErrorText(body: Parameters<typeof readBoundedBody>[0], provider: string): Promise<string> {
  try {
    return (await readBoundedBody(body, provider)).text;
  } catch {
    return '';
  }
}

/** A JSON answer: a body past the cap or past the deadline is an error, never a partial document. */
export async function readJsonBody<T>(body: Parameters<typeof readBoundedBody>[0], provider: string): Promise<T> {
  const { text, truncated } = await readBoundedBody(body, provider);
  if (truncated) {
    throw new StorageAdapterError(`The ${provider} answer is longer than ${ADAPTER_BODY_CAP_BYTES} bytes`, provider);
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new StorageAdapterError(`The ${provider} answer is not valid JSON`, provider, err);
  }
}
