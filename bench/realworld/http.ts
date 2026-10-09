/**
 * HTTP reads for the corpus fetcher: whole files and byte ranges, with bounded retries and a size cap. A proxy named in
 * HTTPS_PROXY is honoured so the fetcher works behind one.
 */
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

const RETRIES = 6;
const BACKOFF_BASE_MS = 2000;
const HTTP_OK = 200;
const HTTP_PARTIAL = 206;
const REQUEST_TIMEOUT_MS = 120_000;

let dispatcherSet = false;

function applyProxyFromEnvironment(): void {
  if (dispatcherSet) return;
  dispatcherSet = true;
  if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY) setGlobalDispatcher(new EnvHttpProxyAgent());
}

export class FetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FetchError';
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function attempt(url: string, range: [number, number] | null, maxBytes: number): Promise<Buffer> {
  const headers: Record<string, string> = {};
  if (range) headers.range = `bytes=${range[0]}-${range[1]}`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const expectedStatus = range ? HTTP_PARTIAL : HTTP_OK;
  if (response.status !== expectedStatus) throw new FetchError(`${url}: HTTP ${response.status}, expected ${expectedStatus}`);
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new FetchError(`${url}: ${declared} bytes exceeds the ${maxBytes}-byte cap`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > maxBytes) throw new FetchError(`${url}: ${body.length} bytes exceeds the ${maxBytes}-byte cap`);
  if (range && body.length !== range[1] - range[0] + 1) throw new FetchError(`${url}: range returned ${body.length} bytes, expected ${range[1] - range[0] + 1}`);
  return body;
}

async function withRetries<T>(url: string, run: () => Promise<T>): Promise<T> {
  applyProxyFromEnvironment();
  let lastError: unknown;
  for (let tryNumber = 0; tryNumber <= RETRIES; tryNumber++) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (tryNumber < RETRIES) await sleep(BACKOFF_BASE_MS * 2 ** tryNumber);
    }
  }
  throw new FetchError(`${url}: failed after ${RETRIES + 1} attempts: ${String(lastError)}`);
}

/** The body of `url`, or of bytes [start, end] of it, retried with exponential backoff on network and server errors. */
export function fetchBytes(url: string, range: [number, number] | null, maxBytes: number): Promise<Buffer> {
  return withRetries(url, () => attempt(url, range, maxBytes));
}

/** Size of the resource at `url`, from a one-byte range request's Content-Range header. */
export function fetchSize(url: string): Promise<number> {
  return withRetries(url, async () => {
    const response = await fetch(url, { headers: { range: 'bytes=0-0' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    await response.arrayBuffer();
    const total = /\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
    if (response.status !== HTTP_PARTIAL || total === null) throw new FetchError(`${url}: server did not answer a range request (HTTP ${response.status})`);
    return Number(total[1]);
  });
}
