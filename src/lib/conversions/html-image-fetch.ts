import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { isPublicAddress } from './public-address';

/**
 * Fetches the images an HTML document names, for the converter that stages them as local data. The fetch is the only
 * step that touches the network; the renderers that draw the page never do.
 *
 * Guards against request forgery:
 * - Only absolute http and https URLs, without credentials, on port 80 or 443.
 * - The host is resolved once, every answer must be a public address (see public-address.ts), and the connection is
 *   pinned to those answers through the socket's lookup, so a second answer from the name server is never used. The
 *   peer address of the connected socket is checked again. Host names that only exist inside a network are refused
 *   without resolving them.
 * - Redirects are followed by hand, at most 3, and every hop goes through the same checks.
 * - No proxy from the environment, no cookies, no credentials, no referrer, no compression.
 * - The body is read up to a size cap, within a time cap, and must carry a PNG, JPEG, GIF or WebP signature.
 */

export interface ImageFetchLimits {
  /** Largest single image, in bytes. */
  maxImageBytes: number;
  /** Largest sum of all fetched images of one session, in bytes. */
  maxTotalBytes: number;
  /** Most fetches (successful or not) of one session. */
  maxImages: number;
  /** Longest one fetch, redirects included, in milliseconds. */
  perFetchMs: number;
  /** Longest all fetches of a session together, in milliseconds. */
  totalMs: number;
  /** Most redirects followed for one image. */
  maxRedirects: number;
}

const MEBIBYTE = 1024 * 1024;

export const IMAGE_FETCH_LIMITS: Readonly<ImageFetchLimits> = {
  maxImageBytes: 10 * MEBIBYTE,
  maxTotalBytes: 50 * MEBIBYTE,
  maxImages: 100,
  perFetchMs: 10_000,
  totalMs: 30_000,
  maxRedirects: 3,
};

/** How an address, a port and a host name are looked up and judged. Production uses the defaults; tests replace parts. */
export interface ImageFetchEnvironment {
  resolve(hostname: string): Promise<string[]>;
  permitAddress(address: string): boolean;
  permitPort(port: number): boolean;
}

const DEFAULT_PORTS: ReadonlySet<number> = new Set([80, 443]);

const productionEnvironment: ImageFetchEnvironment = {
  resolve: async (hostname) => (await dns.promises.lookup(hostname, { all: true, verbatim: true })).map((record) => record.address),
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

/** A fetch that was refused or failed; the message is the reason a warning or a 400 reports. */
export class ImageFetchRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageFetchRefusal';
  }
}

export type FetchedImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface FetchedImage {
  bytes: Buffer;
  /** The type of the signature the bytes start with, never the one the server declared. */
  mime: FetchedImageType;
}

const SUPPORTED_TYPES_TEXT = 'PNG, JPEG, GIF or WebP';
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
/** Host name suffixes that only exist inside a network. */
const INTERNAL_SUFFIXES = ['localhost', 'local', 'localdomain', 'internal', 'intranet', 'lan', 'home.arpa'];
const OCTET_STREAM_TYPES: ReadonlySet<string> = new Set(['application/octet-stream', 'binary/octet-stream']);
const ACCEPT_HEADER = 'image/png,image/jpeg,image/gif,image/webp';
const USER_AGENT = 'EasyConvert-HTML-Image-Loader';

function startsWith(bytes: Buffer, signature: readonly number[], offset = 0): boolean {
  return signature.every((value, index) => bytes[offset + index] === value);
}

/** The image type a byte sequence starts as, or null. */
export function sniffImageType(bytes: Buffer): FetchedImageType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  const head = bytes.subarray(0, 6).toString('latin1');
  if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

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

const NOT_PUBLIC = 'the host is not a public address';

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
    answers = await raceAbort(environment.resolve(host), signal);
  } catch (error) {
    if (error instanceof ImageFetchRefusal) throw error;
    throw new ImageFetchRefusal('the host could not be resolved');
  }
  if (answers.length === 0) throw new ImageFetchRefusal('the host could not be resolved');
  if (!answers.every((address) => environment.permitAddress(address))) throw new ImageFetchRefusal(NOT_PUBLIC);
  return answers;
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

function timedOut(): ImageFetchRefusal {
  return new ImageFetchRefusal('loading the image took too long');
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

async function readBody(response: Response, limit: number, signal: AbortSignal, tooLarge: () => ImageFetchRefusal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of response.stream as AsyncIterable<Buffer>) {
      total += chunk.length;
      if (total > limit) throw tooLarge();
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

/** The fetches of one conversion: they share the count, size and time caps. */
export class ImageFetchSession {
  private readonly limits: ImageFetchLimits;
  private readonly deadline: number;
  private readonly results = new Map<string, Promise<FetchedImage>>();
  private attempts = 0;
  private totalBytes = 0;

  constructor(limits: Partial<ImageFetchLimits> = {}) {
    this.limits = { ...IMAGE_FETCH_LIMITS, ...limits };
    this.deadline = Date.now() + this.limits.totalMs;
  }

  /** The image at an absolute http or https URL. Rejects with ImageFetchRefusal; the same URL is fetched once. */
  fetch(reference: string): Promise<FetchedImage> {
    const known = this.results.get(reference);
    if (known) return known;
    const started = this.start(reference);
    this.results.set(reference, started);
    return started;
  }

  private async start(reference: string): Promise<FetchedImage> {
    const url = parseHttpUrl(reference);
    if (this.attempts >= this.limits.maxImages) {
      throw new ImageFetchRefusal(`the limit of ${this.limits.maxImages} images per document was reached`);
    }
    this.attempts++;
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) throw timedOut();
    const signal = AbortSignal.timeout(Math.min(this.limits.perFetchMs, remaining));
    const image = await this.follow(url, signal);
    this.totalBytes += image.bytes.length;
    return image;
  }

  private async follow(first: URL, signal: AbortSignal): Promise<FetchedImage> {
    let url = first;
    for (let redirects = 0; ; redirects++) {
      const addresses = await checkedAddresses(url, signal);
      const response = await request(url, addresses, signal);
      if (REDIRECT_STATUSES.has(response.status)) {
        response.stream.destroy();
        if (redirects >= this.limits.maxRedirects) throw new ImageFetchRefusal(`the image redirects more than ${this.limits.maxRedirects} times`);
        const location = response.headers.location;
        if (!location) throw new ImageFetchRefusal('the redirect names no location');
        url = parseHttpUrl(location, url);
        continue;
      }
      return this.read(response, signal);
    }
  }

  private async read(response: Response, signal: AbortSignal): Promise<FetchedImage> {
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
    const allowed = Math.min(this.limits.maxImageBytes, this.limits.maxTotalBytes - this.totalBytes);
    const tooLarge = (): ImageFetchRefusal =>
      allowed < this.limits.maxImageBytes
        ? new ImageFetchRefusal(`the images together would pass the total size of ${this.limits.maxTotalBytes} bytes`)
        : new ImageFetchRefusal(`the image is larger than ${this.limits.maxImageBytes} bytes`);
    const length = declaredLength(response.headers);
    if (length !== null && length > allowed) {
      response.stream.destroy();
      throw tooLarge();
    }
    const bytes = await readBody(response, allowed, signal, tooLarge);
    const mime = sniffImageType(bytes);
    if (mime === null) throw new ImageFetchRefusal(`the response is not a ${SUPPORTED_TYPES_TEXT} image`);
    return { bytes, mime };
  }
}
