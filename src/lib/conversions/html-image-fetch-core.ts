import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { ImageFetchRefusal, SUPPORTED_TYPES_TEXT, sniffImageType, type FetchedImage } from './html-image-types';
import { isPublicAddress } from './public-address';

/**
 * Fetches one image for an HTML document. This module is run only by the fetcher child process
 * (html-image-fetch-child.ts), never by the worker itself; the session that drives the child is html-image-fetch.ts.
 *
 * Guards against request forgery:
 * - Only absolute http and https URLs, without credentials, on port 80 or 443.
 * - The host is resolved once, through a resolver that can be cancelled, and every answer must be a public address
 *   (see public-address.ts). The connection is pinned to those answers through the socket's lookup, so a second answer
 *   from the name server is never used, and the peer address of the connected socket is checked again. Host names that
 *   only exist inside a network are refused without resolving them.
 * - Redirects are followed by hand, a few at most, and every hop goes through the same checks.
 * - No proxy from the environment, no cookies, no credentials, no referrer, no compression.
 * - The body is read up to a size cap, within a time cap, and must carry a PNG, JPEG, GIF or WebP signature.
 */

/** How an address, a port and a host name are looked up and judged. Production uses the defaults; tests replace parts. */
export interface ImageFetchEnvironment {
  resolve(hostname: string, signal: AbortSignal): Promise<string[]>;
  permitAddress(address: string): boolean;
  permitPort(port: number): boolean;
}

const DEFAULT_PORTS: ReadonlySet<number> = new Set([80, 443]);
/** Milliseconds one query of the resolver waits for a name server, and how many times it asks. */
const RESOLVER_QUERY_TIMEOUT_MS = 2500;
const RESOLVER_TRIES = 2;

/** The A and AAAA records of a host. The queries run in the resolver library, not on the shared thread pool, and are cancelled with the signal. */
async function resolveWithResolver(hostname: string, signal: AbortSignal): Promise<string[]> {
  const resolver = new dns.promises.Resolver({ timeout: RESOLVER_QUERY_TIMEOUT_MS, tries: RESOLVER_TRIES });
  const cancel = (): void => resolver.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const [v4, v6] = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    return [...(v4.status === 'fulfilled' ? v4.value : []), ...(v6.status === 'fulfilled' ? v6.value : [])];
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

const productionEnvironment: ImageFetchEnvironment = {
  resolve: resolveWithResolver,
  permitAddress: isPublicAddress,
  permitPort: (port) => DEFAULT_PORTS.has(port),
};

let environment: ImageFetchEnvironment = productionEnvironment;

/**
 * Replaces parts of the lookup and address rules for the length of a test. Returns the function that puts the
 * production rules back. Nothing in the product calls this.
 */
export function overrideImageFetchEnvironment(overrides: Partial<ImageFetchEnvironment>): () => void {
  const previous = environment;
  environment = { ...productionEnvironment, ...overrides };
  return () => {
    environment = previous;
  };
}

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
/** Host name suffixes that only exist inside a network. */
const INTERNAL_SUFFIXES = ['localhost', 'local', 'localdomain', 'internal', 'intranet', 'lan', 'home.arpa'];
const OCTET_STREAM_TYPES: ReadonlySet<string> = new Set(['application/octet-stream', 'binary/octet-stream']);
const ACCEPT_HEADER = 'image/png,image/jpeg,image/gif,image/webp';
const USER_AGENT = 'EasyConvert-HTML-Image-Loader';
const NOT_PUBLIC = 'the host is not a public address';

function isInternalHostName(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/, '');
  if (!name.includes('.')) return true;
  return INTERNAL_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
}

function bareHostname(url: URL): string {
  return url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
}

function portOf(url: URL): number {
  if (url.port !== '') return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

function timedOut(): ImageFetchRefusal {
  return new ImageFetchRefusal('loading the image took too long');
}

function parseHttpUrl(text: string, base?: URL): URL {
  let url: URL;
  try {
    url = new URL(text, base);
  } catch {
    throw new ImageFetchRefusal('the reference is not an absolute http or https URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ImageFetchRefusal('only absolute http or https URLs are loaded');
  if (base === undefined && !/^https?:\/\//i.test(text.trim())) throw new ImageFetchRefusal('only absolute http or https URLs are loaded');
  if (url.username !== '' || url.password !== '') throw new ImageFetchRefusal('URLs with credentials are not loaded');
  if (!environment.permitPort(portOf(url))) throw new ImageFetchRefusal('the port is not allowed (only 80 and 443 are loaded)');
  return url;
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(timedOut());
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** The addresses to connect to: every answer of the name server must be public, or none is used. */
async function checkedAddresses(url: URL, signal: AbortSignal): Promise<string[]> {
  const host = bareHostname(url);
  if (net.isIP(host) !== 0) {
    if (!environment.permitAddress(host)) throw new ImageFetchRefusal(NOT_PUBLIC);
    return [host];
  }
  if (isInternalHostName(host)) throw new ImageFetchRefusal('the host name is not allowed');
  let answers: string[];
  try {
    answers = await raceAbort(environment.resolve(host, signal), signal);
  } catch (error) {
    if (error instanceof ImageFetchRefusal) throw error;
    throw new ImageFetchRefusal('the host could not be resolved');
  }
  if (answers.length === 0) throw new ImageFetchRefusal('the host could not be resolved');
  if (!answers.every((address) => environment.permitAddress(address))) throw new ImageFetchRefusal(NOT_PUBLIC);
  return answers;
}

/** A lookup that answers with the addresses that were checked, whatever the name server says now. */
function pinnedLookup(addresses: readonly string[]): net.LookupFunction {
  const records = addresses.map((address) => ({ address, family: net.isIP(address) }));
  return (_hostname, options, callback) => {
    if (options.all) {
      (callback as (error: null, all: typeof records) => void)(null, records);
      return;
    }
    callback(null, records[0].address, records[0].family);
  };
}

interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  stream: http.IncomingMessage;
}

function request(url: URL, addresses: readonly string[], signal: AbortSignal): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const secure = url.protocol === 'https:';
    const host = bareHostname(url);
    const options: https.RequestOptions = {
      host,
      port: portOf(url),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: {
        host: url.host,
        accept: ACCEPT_HEADER,
        'accept-encoding': 'identity',
        'user-agent': USER_AGENT,
        connection: 'close',
      },
      agent: secure ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false }),
      lookup: pinnedLookup(addresses),
      signal,
      ...(secure && net.isIP(host) === 0 ? { servername: host } : {}),
    };
    const req = (secure ? https : http).request(options, (response) => {
      resolve({ status: response.statusCode ?? 0, headers: response.headers, stream: response });
    });
    req.on('socket', (socket) => {
      const check = (): void => {
        if (!environment.permitAddress(socket.remoteAddress ?? '')) req.destroy(new ImageFetchRefusal(NOT_PUBLIC));
      };
      if (socket.connecting) socket.once('connect', check);
      else check();
    });
    req.on('error', (error) => {
      if (error instanceof ImageFetchRefusal) reject(error);
      else if (signal.aborted) reject(timedOut());
      else reject(new ImageFetchRefusal('the server could not be reached'));
    });
    req.end();
  });
}

async function readBody(response: Response, limit: number, signal: AbortSignal, tooLarge: ImageFetchRefusal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of response.stream as AsyncIterable<Buffer>) {
      total += chunk.length;
      if (total > limit) throw tooLarge;
      chunks.push(chunk);
    }
  } catch (error) {
    response.stream.destroy();
    if (error instanceof ImageFetchRefusal) throw error;
    throw signal.aborted ? timedOut() : new ImageFetchRefusal('the server could not be reached');
  }
  return Buffer.concat(chunks);
}

function declaredLength(headers: http.IncomingHttpHeaders): number | null {
  const value = headers['content-length'];
  if (value === undefined || !/^\d+$/.test(value)) return null;
  return Number(value);
}

function assertImageContentType(headers: http.IncomingHttpHeaders): void {
  const type = (headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type === '' || type.startsWith('image/') || OCTET_STREAM_TYPES.has(type)) return;
  throw new ImageFetchRefusal(`the response is not a ${SUPPORTED_TYPES_TEXT} image`);
}

async function readImage(response: Response, options: FetchOptions, signal: AbortSignal): Promise<FetchedImage> {
  if (response.status !== 200) {
    response.stream.destroy();
    throw new ImageFetchRefusal(`the server answered with status ${response.status}`);
  }
  const encoding = (response.headers['content-encoding'] ?? 'identity').toLowerCase();
  if (encoding !== 'identity') {
    response.stream.destroy();
    throw new ImageFetchRefusal('the response is compressed, which is not loaded');
  }
  try {
    assertImageContentType(response.headers);
  } catch (error) {
    response.stream.destroy();
    throw error;
  }
  const tooLarge = new ImageFetchRefusal(options.tooLargeReason);
  const length = declaredLength(response.headers);
  if (length !== null && length > options.maxBytes) {
    response.stream.destroy();
    throw tooLarge;
  }
  const bytes = await readBody(response, options.maxBytes, signal, tooLarge);
  const mime = sniffImageType(bytes);
  if (mime === null) throw new ImageFetchRefusal(`the response is not a ${SUPPORTED_TYPES_TEXT} image`);
  return { bytes, mime };
}

export interface FetchOptions {
  /** Most bytes the body may have. */
  maxBytes: number;
  /** The reason reported when the body is larger than `maxBytes`. */
  tooLargeReason: string;
  /** Longest the whole fetch may take, redirects included. */
  timeoutMs: number;
  maxRedirects: number;
}

/** The image at an absolute http or https URL. Rejects with ImageFetchRefusal. */
export async function fetchImage(reference: string, options: FetchOptions): Promise<FetchedImage> {
  let url = parseHttpUrl(reference);
  const signal = AbortSignal.timeout(options.timeoutMs);
  for (let redirects = 0; ; redirects++) {
    const addresses = await checkedAddresses(url, signal);
    const response = await request(url, addresses, signal);
    if (REDIRECT_STATUSES.has(response.status)) {
      response.stream.destroy();
      if (redirects >= options.maxRedirects) throw new ImageFetchRefusal(`the image redirects more than ${options.maxRedirects} times`);
      const location = response.headers.location;
      if (!location) throw new ImageFetchRefusal('the redirect names no location');
      url = parseHttpUrl(location, url);
      continue;
    }
    return readImage(response, options, signal);
  }
}
