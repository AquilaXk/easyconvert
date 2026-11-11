import { Agent, type Dispatcher } from 'undici';
import { StorageAdapterError, StorageSsrfError, StorageTimeoutError } from './adapter-interface';
import { ssrfSafeLookup, validateUrlForSsrf } from '../../security/ssrf';
import { ADAPTER_BODY_CAP_BYTES, ADAPTER_HEADERS_TIMEOUT_MS, ADAPTER_RESPONSE_TIMEOUT_MS } from './http-limits';

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

/**
 * Refuses a URL before any request: it has to be https and resolve only to public addresses, unless the server's
 * development allowlist names its host. The connection is pinned again at connect time (`adapterDispatcher`).
 */
export async function assertAdapterUrlSafe(urlStr: string, provider: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch (err) {
    throw new StorageAdapterError('The storage endpoint does not form a valid URL', provider, err);
  }
  if (isDevAllowlistedEndpoint(url)) return;
  assertTlsEndpoint(url, provider);
  if (!(await validateUrlForSsrf(url))) {
    throw new StorageSsrfError(urlStr, provider);
  }
}

/** A connection agent that pins every connection to a public address (a development-allowlisted host is not pinned). */
export function adapterDispatcher(urlStr: string): Agent {
  const timeouts = { headersTimeout: ADAPTER_HEADERS_TIMEOUT_MS };
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
