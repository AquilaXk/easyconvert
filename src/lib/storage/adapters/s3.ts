import crypto from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import { Agent, fetch as undiciFetch, type Dispatcher, type RequestInit as UndiciRequestInit } from 'undici';
import type { S3Credentials } from '../credentials-vault';
import {
  IStorageAdapter,
  StorageAdapterError,
  StorageAdapterMetadata,
  StorageAuthenticationError,
  StorageNotFoundError,
  StorageServiceError,
  StorageSsrfError,
  StorageTimeoutError,
} from './adapter-interface';
import {
  EMPTY_PAYLOAD_SHA256,
  SigV4SigningError,
  UNSIGNED_PAYLOAD,
  assertValidObjectKey,
  resolveS3Address,
  sha256Hex,
  signS3Request,
} from '../s3-sigv4';
import { OutboundRequestBlockedError, safeFetch } from '../../security/safe-fetch';
import { isPrivateOrRestrictedHost, validateUrlForSsrf } from '../../security/ssrf';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
/** S3 multipart limits: every part but the last is at least 5 MiB, at most 5 GiB, and at most 10,000 parts. */
export const S3_MIN_PART_BYTES = 5 * MIB;
export const S3_MAX_PART_BYTES = 5 * GIB;
export const S3_MAX_PARTS = 10_000;
export const S3_DEFAULT_PART_BYTES = 8 * MIB;
const DEFAULT_REGION = 'us-east-1';
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_RETRY_BASE_DELAY_MS = 200;
const MAX_RETRY_DELAY_MS = 5_000;
/** Inactivity timeout: reset whenever response bytes arrive (S3 keepalive whitespace counts). */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
/**
 * Absolute ceiling for one request, however steadily bytes trickle in, so a slow peer cannot hold
 * a connection open indefinitely. CompleteMultipartUpload of a large object can keep the response
 * open with whitespace for several minutes; 15 minutes leaves a wide margin above that and still
 * bounds a slow-loris peer. A downloaded body handed to the caller is not covered by this ceiling.
 */
export const S3_REQUEST_MAX_DURATION_MS = 15 * 60_000;
/** Error documents are small; a larger body is truncated so a hostile endpoint cannot exhaust memory. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const PROVIDER = 's3';
const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/**
 * Comma-separated `host[:port]` list of endpoints that may be private or plain HTTP, for a local
 * S3-compatible server during development. Honoured only when NODE_ENV is exactly "development".
 */
export const S3_DEV_ENDPOINT_ALLOWLIST_ENV = 'BYOS_S3_DEV_ENDPOINT_ALLOWLIST';

const HTTP_NOT_FOUND = 404;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR_MIN = 500;
const HTTP_REDIRECT_MIN = 300;
const HTTP_REDIRECT_MAX = 399;

const NOT_FOUND_CODES: ReadonlySet<string> = new Set(['NoSuchKey', 'NoSuchBucket', 'NotFound']);
const AUTH_ERROR_CODES: ReadonlySet<string> = new Set([
  'AccessDenied',
  'AccountProblem',
  'AllAccessDisabled',
  'ExpiredToken',
  'InvalidAccessKeyId',
  'InvalidSecurity',
  'InvalidToken',
  'SignatureDoesNotMatch',
  'TokenRefreshRequired',
]);
const RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  'InternalError',
  'RequestLimitExceeded',
  'RequestThrottled',
  'RequestTimeout',
  'ServiceUnavailable',
  'SlowDown',
  'Throttling',
  'ThrottlingException',
  'TooManyRequestsException',
]);
const XML_ENTITIES: ReadonlyMap<string, string> = new Map([
  ['&amp;', '&'],
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&apos;', "'"],
]);
const XML_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['"', '&quot;'],
  ["'", '&apos;'],
]);
const ERROR_ELEMENT_PATTERN = /<Error\b/;
/** S3 never sends a DTD; a document declaring one (or an entity) is refused instead of interpreted. */
const DTD_DECLARATION_PATTERN = /<!(?:DOCTYPE|ENTITY)/i;
const MALFORMED_XML_CODE = 'MalformedXML';
const NO_SUCH_UPLOAD_CODE = 'NoSuchUpload';
/** A 2xx Complete answer that does not prove the object was assembled. */
const UNCONFIRMED_COMPLETION_CODE = 'UnconfirmedCompletion';
const COMPLETE_RESULT_ELEMENT = '<CompleteMultipartUploadResult';
/** XML whitespace (space, tab, LF, CR): S3 pads a slow Complete with it before the result. */
const XML_WHITESPACE_BYTES: ReadonlySet<number> = new Set([0x20, 0x09, 0x0a, 0x0d]);

export interface S3AdapterOptions {
  /** Multipart part size; at least 5 MiB. Grows automatically to stay within 10,000 parts. */
  partSizeBytes?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  requestTimeoutMs?: number;
  /** Absolute per-request ceiling; defaults to S3_REQUEST_MAX_DURATION_MS. */
  maxRequestDurationMs?: number;
}

export interface S3ErrorDocument {
  code?: string;
  message?: string;
  requestId?: string;
}

function decodeXmlText(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => XML_ENTITIES.get(entity) ?? entity);
}

function escapeXmlText(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => XML_ESCAPES.get(ch) ?? ch);
}

/** The only S3 response elements the adapter reads. */
type S3XmlElement = 'Code' | 'Message' | 'RequestId' | 'UploadId' | 'ETag';

/**
 * Returns the decoded text of the first `<name>text</name>` whose content has no markup, using
 * plain string search (no pattern is built from input).
 */
function readXmlElement(xml: string, name: S3XmlElement): string | undefined {
  const open = `<${name}>`;
  const close = `</${name}>`;
  let from = xml.indexOf(open);
  while (from !== -1) {
    const start = from + open.length;
    const nextTag = xml.indexOf('<', start);
    if (nextTag === -1) {
      return undefined;
    }
    if (xml.startsWith(close, nextTag)) {
      return decodeXmlText(xml.slice(start, nextTag));
    }
    from = xml.indexOf(open, start);
  }
  return undefined;
}

function declaresDtd(xml: string): boolean {
  return DTD_DECLARATION_PATTERN.test(xml);
}

/**
 * Extracts Code, Message, and RequestId from an S3 `<Error>` document. Elements are read as
 * plain text: only the five predefined entities are decoded, and a document that declares a DTD
 * or entity yields nothing, so the HTTP status alone decides the error.
 */
export function parseS3ErrorXml(xml: string): S3ErrorDocument {
  if (declaresDtd(xml)) {
    return {};
  }
  return {
    code: readXmlElement(xml, 'Code'),
    message: readXmlElement(xml, 'Message'),
    requestId: readXmlElement(xml, 'RequestId'),
  };
}

const DEVELOPMENT_ENV = 'development';
let ignoredAllowlistWarned = false;

/** Opt-in: the allowlist is honoured only when NODE_ENV is exactly "development". */
function readDevAllowlist(): ReadonlySet<string> {
  const raw = process.env[S3_DEV_ENDPOINT_ALLOWLIST_ENV] ?? '';
  if (process.env.NODE_ENV !== DEVELOPMENT_ENV) {
    if (raw.trim() && !ignoredAllowlistWarned) {
      ignoredAllowlistWarned = true;
      console.warn(`[S3StorageAdapter] ${S3_DEV_ENDPOINT_ALLOWLIST_ENV} is set but ignored because NODE_ENV is not "${DEVELOPMENT_ENV}".`);
    }
    return new Set();
  }
  return new Set(
    raw
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
}

/** The allowlist entry (from server configuration) that exactly equals the origin's host[:port], if any. */
function findDevAllowlistEntry(origin: URL): string | undefined {
  const host = origin.host.toLowerCase();
  return [...readDevAllowlist()].find((entry) => entry === host);
}

let devAgent: Dispatcher | null = null;

/** Connection agent for development-allowlisted endpoints only; it does not pin public IPs. */
function devDispatcher(): Dispatcher {
  devAgent ??= new Agent();
  return devAgent;
}

function toNodeReadable(stream: NodeJS.ReadableStream | ReadableStream<Uint8Array>): Readable {
  if ('getReader' in stream) {
    return Readable.fromWeb(stream as unknown as NodeWebReadableStream<Uint8Array>);
  }
  return stream instanceof Readable ? stream : Readable.from(stream as AsyncIterable<Uint8Array>);
}

/** Splits a stream into buffers of exactly `chunkSize` bytes (the last may be shorter), holding one chunk at a time. */
async function* readChunks(stream: Readable, chunkSize: number): AsyncGenerator<Buffer> {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  for await (const piece of stream) {
    let buf = Buffer.isBuffer(piece) ? piece : Buffer.from(piece as Uint8Array);
    while (pendingBytes + buf.length >= chunkSize) {
      const take = chunkSize - pendingBytes;
      pending.push(buf.subarray(0, take));
      yield Buffer.concat(pending, chunkSize);
      pending = [];
      pendingBytes = 0;
      buf = buf.subarray(take);
    }
    if (buf.length > 0) {
      pending.push(buf);
      pendingBytes += buf.length;
    }
  }
  if (pendingBytes > 0) {
    yield Buffer.concat(pending, pendingBytes);
  }
}

function stripQuotes(etag: string | null | undefined): string | undefined {
  return etag ? etag.replace(/"/g, '') : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/** Index of the first non-whitespace byte, or the length when the chunk is all whitespace. */
function firstContentByte(chunk: Uint8Array): number {
  let i = 0;
  while (i < chunk.length && XML_WHITESPACE_BYTES.has(chunk[i])) i++;
  return i;
}

/**
 * Reads at most MAX_ERROR_BODY_BYTES of a response body, not counting leading whitespace, which
 * S3 sends as keepalive while completing an upload. `onBytes` runs for every chunk so the caller
 * can extend its inactivity deadline.
 */
async function readLimitedText(res: Response, onBytes?: () => void): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let started = false;
  while (total < MAX_ERROR_BODY_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    onBytes?.();
    let content = value;
    if (!started) {
      content = value.subarray(firstContentByte(value));
      started = content.length > 0;
    }
    if (content.length > 0) {
      chunks.push(content);
      total += content.length;
    }
  }
  await reader.cancel().catch(() => undefined);
  return Buffer.concat(chunks).subarray(0, MAX_ERROR_BODY_BYTES).toString('utf-8');
}

type RequestBody = Buffer | Readable;

function isRetryable(err: StorageAdapterError): boolean {
  return err instanceof StorageTimeoutError || (err instanceof StorageServiceError && err.retryable);
}

/**
 * A CompleteMultipartUpload failure after which the object may exist anyway: a timeout, a
 * retryable service or transport error, or a retry that finds the upload already gone.
 */
function isAmbiguousCompletion(err: unknown): boolean {
  return (
    err instanceof StorageTimeoutError ||
    (err instanceof StorageServiceError &&
      (err.retryable || err.code === NO_SUCH_UPLOAD_CODE || err.code === UNCONFIRMED_COMPLETION_CODE))
  );
}

const PART_MD5_PATTERN = /^[0-9a-f]{32}$/i;

/**
 * The ETag S3 gives a completed multipart object: MD5 of the concatenated binary part MD5s, then
 * `-<part count>`. MD5 is S3's integrity checksum here, not a security control. Returns undefined
 * when a part ETag is not a plain MD5 (e.g. server-side encryption with KMS), in which case
 * completion cannot be proven this way.
 */
function expectedMultipartEtag(partEtags: readonly string[]): string | undefined {
  const digests: Buffer[] = [];
  for (const etag of partEtags) {
    const hex = etag.replace(/"/g, '');
    if (!PART_MD5_PATTERN.test(hex)) return undefined;
    digests.push(Buffer.from(hex, 'hex'));
  }
  return `${crypto.createHash('md5').update(Buffer.concat(digests)).digest('hex')}-${partEtags.length}`;
}

/** Wraps a failure of the caller's source stream; StorageAdapterErrors pass through unchanged. */
function wrapSourceError(err: unknown): StorageAdapterError {
  if (err instanceof StorageAdapterError) return err;
  return new StorageServiceError('Upload source stream failed', PROVIDER, { retryable: false }, err);
}

interface S3Request {
  method: 'GET' | 'PUT' | 'POST' | 'HEAD' | 'DELETE';
  key: string;
  query?: Array<[string, string]>;
  headers?: Record<string, string>;
  body?: RequestBody;
  payloadHash: string;
  /** Whether the body can be sent again; a consumed stream cannot be retried. */
  replayable: boolean;
  /** Return a 404 response to the caller instead of throwing. */
  allowNotFound?: boolean;
  /** Treat an `<Error>` document in a 2xx body as a failure (CompleteMultipartUpload) and return the body text. */
  readBody?: boolean;
}

interface S3Response {
  res: Response;
  text?: string;
}

/**
 * S3-compatible BYOS adapter with SigV4 header authentication. Every request goes through
 * safeFetch (SSRF validation plus connect-time IP pinning) over TLS; a private or plain-HTTP
 * endpoint is only reachable when it is listed in the development allowlist.
 */
export class S3StorageAdapter implements IStorageAdapter {
  readonly providerName = PROVIDER;
  readonly #accessKeyId: string;
  readonly #secretAccessKey: string;
  readonly #sessionToken?: string;
  private readonly bucket: string;
  private readonly region: string;
  private readonly endpoint?: string;
  private readonly forcePathStyle?: boolean;
  private readonly devAllowlisted: boolean;
  /** Origin built from the server-side allowlist entry, never from customer input. */
  private readonly devOrigin?: string;
  private readonly origin: URL;
  private readonly partSizeBytes: number;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxRequestDurationMs: number;

  constructor(credentials: S3Credentials, options: S3AdapterOptions = {}) {
    if (!credentials.bucket || !credentials.accessKeyId || !credentials.secretAccessKey) {
      throw new StorageAuthenticationError('bucket, accessKeyId, and secretAccessKey are required', PROVIDER);
    }
    this.#accessKeyId = credentials.accessKeyId;
    this.#secretAccessKey = credentials.secretAccessKey;
    this.#sessionToken = credentials.sessionToken || undefined;
    this.bucket = credentials.bucket;
    this.region = credentials.region || DEFAULT_REGION;
    this.endpoint = credentials.endpoint || undefined;
    this.forcePathStyle = credentials.forcePathStyle;

    const partSize = options.partSizeBytes ?? S3_DEFAULT_PART_BYTES;
    if (!Number.isInteger(partSize) || partSize < S3_MIN_PART_BYTES || partSize > S3_MAX_PART_BYTES) {
      throw new StorageAdapterError(
        `Part size must be an integer between ${S3_MIN_PART_BYTES} and ${S3_MAX_PART_BYTES} bytes`,
        PROVIDER
      );
    }
    this.partSizeBytes = partSize;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS);
    this.requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    this.maxRequestDurationMs = Math.max(1, options.maxRequestDurationMs ?? S3_REQUEST_MAX_DURATION_MS);

    this.origin = this.parseOrigin(this.address('').origin);
    const devEntry = findDevAllowlistEntry(this.origin);
    this.devAllowlisted = devEntry !== undefined;
    if (devEntry !== undefined) {
      this.devOrigin = `${this.origin.protocol === 'https:' ? 'https:' : 'http:'}//${devEntry}`;
    }
    this.assertEndpointPolicy(this.origin);
  }

  /**
   * Resolves the endpoint host and refuses it when any address is private, loopback, or
   * link-local. Used when credentials are registered; every request is checked again at
   * connect time because DNS can change.
   */
  async verifyEndpoint(): Promise<void> {
    if (this.devAllowlisted) return;
    if (!(await validateUrlForSsrf(this.origin))) {
      throw new StorageSsrfError(this.origin.host, PROVIDER);
    }
  }

  /** Static checks before any request: TLS and no private or metadata host, unless dev-allowlisted. */
  private assertEndpointPolicy(origin: URL): void {
    if (this.devAllowlisted) return;
    if (origin.protocol !== 'https:') {
      throw new StorageSsrfError(`${origin.protocol}//${origin.host} (TLS is required)`, PROVIDER);
    }
    if (isPrivateOrRestrictedHost(origin.hostname)) {
      throw new StorageSsrfError(origin.host, PROVIDER);
    }
  }

  private address(key: string) {
    try {
      return resolveS3Address({
        bucket: this.bucket,
        key,
        region: this.region,
        endpoint: this.endpoint,
        forcePathStyle: this.forcePathStyle,
      });
    } catch (err) {
      if (err instanceof SigV4SigningError) {
        throw new StorageAdapterError(err.message, PROVIDER, err);
      }
      throw err;
    }
  }

  private parseOrigin(origin: string): URL {
    try {
      return new URL(origin);
    } catch (err) {
      throw new StorageAdapterError('S3 endpoint does not form a valid URL', PROVIDER, err);
    }
  }

  private toKey(remotePath: string): string {
    const key = remotePath.replace(/^\/+/, '');
    try {
      assertValidObjectKey(key);
    } catch (err) {
      throw new StorageAdapterError(err instanceof Error ? err.message : 'Invalid object key', PROVIDER, err);
    }
    return key;
  }

  private retryDelay(attempt: number): number {
    const ceiling = Math.min(MAX_RETRY_DELAY_MS, this.retryBaseDelayMs * 2 ** (attempt - 1));
    return ceiling > 0 ? crypto.randomInt(0, ceiling + 1) : 0;
  }

  private async fetchOnce(url: string, init: UndiciRequestInit): Promise<Response> {
    if (this.devOrigin !== undefined) {
      // The host comes from the server-side allowlist; only the signed path and query come from the request.
      const target = new URL(url);
      const devUrl = `${this.devOrigin}${target.pathname}${target.search}`;
      return (await undiciFetch(devUrl, { ...init, redirect: 'manual', dispatcher: devDispatcher() })) as unknown as Response;
    }
    return safeFetch(url, init, { maxRedirects: 0 });
  }

  private async toServiceError(
    res: Response,
    key: string,
    body?: string,
    onBytes?: () => void
  ): Promise<StorageAdapterError> {
    const text = body ?? (await readLimitedText(res, onBytes));
    const doc = parseS3ErrorXml(text);
    const status = res.status;
    if (doc.code === NO_SUCH_UPLOAD_CODE) {
      return new StorageServiceError('Multipart upload no longer exists', PROVIDER, {
        statusCode: status,
        code: doc.code,
        requestId: doc.requestId,
        retryable: false,
      });
    }
    if (status === HTTP_NOT_FOUND || (doc.code && NOT_FOUND_CODES.has(doc.code))) {
      return new StorageNotFoundError(key, PROVIDER);
    }
    if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN || (doc.code && AUTH_ERROR_CODES.has(doc.code))) {
      return new StorageAuthenticationError(`${doc.code ?? `HTTP ${status}`}${doc.message ? `: ${doc.message}` : ''}`, PROVIDER);
    }
    if (status >= HTTP_REDIRECT_MIN && status <= HTTP_REDIRECT_MAX) {
      return new StorageServiceError(
        `S3 endpoint answered with a redirect (HTTP ${status}); check the bucket region and endpoint`,
        PROVIDER,
        { statusCode: status, code: doc.code, requestId: doc.requestId, retryable: false }
      );
    }
    const retryable =
      status >= HTTP_SERVER_ERROR_MIN ||
      status === HTTP_TOO_MANY_REQUESTS ||
      (doc.code !== undefined && RETRYABLE_ERROR_CODES.has(doc.code));
    return new StorageServiceError(
      `S3 request failed (HTTP ${status}${doc.code ? ` ${doc.code}` : ''})${doc.message ? `: ${doc.message}` : ''}`,
      PROVIDER,
      { statusCode: status, code: doc.code, requestId: doc.requestId, retryable }
    );
  }

  private mapTransportError(err: unknown): StorageAdapterError {
    if (err instanceof StorageAdapterError) return err;
    if (err instanceof OutboundRequestBlockedError) {
      if (/redirect/i.test(err.message)) {
        return new StorageServiceError(
          'S3 endpoint answered with a redirect; check the bucket region and endpoint',
          PROVIDER,
          { code: 'Redirect', retryable: false },
          err
        );
      }
      return new StorageSsrfError(err.target, PROVIDER);
    }
    const message = err instanceof Error ? err.message : String(err);
    return new StorageServiceError(`S3 request failed: ${message}`, PROVIDER, { retryable: true }, err);
  }

  /**
   * Types a failure while a request or body is in flight: a deadline firing (`timedOutAfterMs`
   * names which one), or the connection dropping.
   */
  private mapBodyError(err: unknown, timedOutAfterMs?: number): StorageAdapterError {
    if (err instanceof StorageAdapterError) return err;
    if (timedOutAfterMs !== undefined) return new StorageTimeoutError(timedOutAfterMs, PROVIDER);
    if (isAbortError(err)) return new StorageTimeoutError(this.requestTimeoutMs, PROVIDER);
    return this.mapTransportError(err);
  }

  private async send(request: S3Request): Promise<S3Response> {
    const address = this.address(request.key);
    let lastError: StorageAdapterError | null = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (attempt > 1) {
        await sleep(this.retryDelay(attempt - 1));
      }
      const signed = signS3Request({
        method: request.method,
        origin: address.origin,
        path: address.path,
        query: request.query,
        headers: request.headers,
        payloadHash: request.payloadHash,
        credentials: {
          accessKeyId: this.#accessKeyId,
          secretAccessKey: this.#secretAccessKey,
          sessionToken: this.#sessionToken,
        },
        region: this.region,
      });

      const controller = new AbortController();
      let timedOutAfterMs: number | undefined;
      const abortAfter = (ms: number) => () => {
        timedOutAfterMs ??= ms;
        controller.abort();
      };
      const onInactive = abortAfter(this.requestTimeoutMs);
      let timer = setTimeout(onInactive, this.requestTimeoutMs);
      const ceiling = setTimeout(abortAfter(this.maxRequestDurationMs), this.maxRequestDurationMs);
      // Received bytes extend the inactivity deadline (whitespace keepalives keep a Complete
      // alive); the absolute ceiling never moves.
      const touch = () => {
        clearTimeout(timer);
        timer = setTimeout(onInactive, this.requestTimeoutMs);
      };
      const clearDeadlines = () => {
        clearTimeout(timer);
        clearTimeout(ceiling);
      };
      let res: Response;
      try {
        res = await this.fetchOnce(signed.url, {
          method: request.method,
          headers: signed.headers,
          body: request.body,
          duplex: request.body instanceof Readable ? 'half' : undefined,
          signal: controller.signal,
        } as UndiciRequestInit);
      } catch (err) {
        clearDeadlines();
        lastError = this.mapBodyError(err, timedOutAfterMs);
        if (isRetryable(lastError) && request.replayable) continue;
        throw lastError;
      }

      try {
        const outcome = await this.readOutcome(res, request, touch);
        if ('ok' in outcome) {
          return outcome.ok;
        }
        lastError = outcome.error;
      } catch (err) {
        lastError = this.mapBodyError(err, timedOutAfterMs);
      } finally {
        clearDeadlines();
      }

      if (!(isRetryable(lastError) && request.replayable)) {
        throw lastError;
      }
    }
    throw lastError ?? new StorageServiceError('S3 request failed', PROVIDER, { retryable: false });
  }

  /** Decides whether a response is the result or an error; DTD-bearing bodies are refused. */
  private async readOutcome(
    res: Response,
    request: S3Request,
    onBytes: () => void
  ): Promise<{ ok: S3Response } | { error: StorageAdapterError }> {
    if (res.status === HTTP_NOT_FOUND && request.allowNotFound) {
      await res.body?.cancel();
      return { ok: { res } };
    }
    if (res.ok && !request.readBody) {
      return { ok: { res } };
    }
    if (!res.ok) {
      return { error: await this.toServiceError(res, request.key, undefined, onBytes) };
    }
    const text = await readLimitedText(res, onBytes);
    if (declaresDtd(text)) {
      return {
        error: new StorageServiceError('S3 response declares a DTD and was refused', PROVIDER, {
          statusCode: res.status,
          code: MALFORMED_XML_CODE,
          retryable: false,
        }),
      };
    }
    if (ERROR_ELEMENT_PATTERN.test(text)) {
      return { error: await this.toServiceError(res, request.key, text) };
    }
    return { ok: { res, text } };
  }

  async downloadStream(remotePath: string): Promise<NodeJS.ReadableStream> {
    const key = this.toKey(remotePath);
    const { res } = await this.send({ method: 'GET', key, payloadHash: EMPTY_PAYLOAD_SHA256, replayable: true });
    if (!res.body) {
      return Readable.from([]);
    }
    const source = Readable.fromWeb(res.body as unknown as NodeWebReadableStream<Uint8Array>);
    const output = new PassThrough();
    source.on('error', (err) => output.destroy(this.mapBodyError(err)));
    output.on('close', () => source.destroy());
    source.pipe(output);
    return output;
  }

  async head(remotePath: string): Promise<StorageAdapterMetadata | null> {
    const key = this.toKey(remotePath);
    const { res } = await this.send({
      method: 'HEAD',
      key,
      payloadHash: EMPTY_PAYLOAD_SHA256,
      replayable: true,
      allowNotFound: true,
    });
    if (res.status === HTTP_NOT_FOUND) {
      return null;
    }
    const length = res.headers.get('content-length');
    const lastModified = res.headers.get('last-modified');
    return {
      size: length ? Number.parseInt(length, 10) : 0,
      etag: stripQuotes(res.headers.get('etag')),
      contentType: res.headers.get('content-type') ?? undefined,
      lastModified: lastModified ? new Date(lastModified) : undefined,
    };
  }

  async delete(remotePath: string): Promise<boolean> {
    const key = this.toKey(remotePath);
    const { res } = await this.send({
      method: 'DELETE',
      key,
      payloadHash: EMPTY_PAYLOAD_SHA256,
      replayable: true,
      allowNotFound: true,
    });
    return res.status !== HTTP_NOT_FOUND;
  }

  async uploadStream(
    remotePath: string,
    stream: NodeJS.ReadableStream | ReadableStream<Uint8Array>,
    options?: { contentType?: string; size?: number }
  ): Promise<StorageAdapterMetadata> {
    const key = this.toKey(remotePath);
    const contentType = options?.contentType || DEFAULT_CONTENT_TYPE;
    const size = options?.size;
    if (size !== undefined && (!Number.isSafeInteger(size) || size < 0)) {
      throw new StorageAdapterError(`Invalid upload size: ${size}`, PROVIDER);
    }
    const source = toNodeReadable(stream);

    if (size !== undefined && size <= this.partSizeBytes) {
      return this.putStreamed(key, source, size, contentType);
    }
    return this.putChunked(key, source, contentType, this.partSizeFor(size));
  }

  /** Part size that keeps an upload of `size` bytes within 10,000 parts. */
  private partSizeFor(size: number | undefined): number {
    if (size === undefined) return this.partSizeBytes;
    const needed = Math.ceil(size / S3_MAX_PARTS);
    const partSize = Math.max(this.partSizeBytes, Math.ceil(needed / MIB) * MIB);
    if (partSize > S3_MAX_PART_BYTES) {
      throw new StorageAdapterError(`Object of ${size} bytes exceeds the multipart upload limit`, PROVIDER);
    }
    return partSize;
  }

  /** PutObject with a streamed, unsigned payload of a known length. A consumed stream is not retried. */
  private async putStreamed(key: string, source: Readable, size: number, contentType: string): Promise<StorageAdapterMetadata> {
    const { res } = await this.send({
      method: 'PUT',
      key,
      headers: { 'content-type': contentType, 'content-length': String(size) },
      body: size === 0 ? Buffer.alloc(0) : source,
      payloadHash: UNSIGNED_PAYLOAD,
      replayable: false,
    });
    if (size === 0) source.resume();
    return { size, etag: stripQuotes(res.headers.get('etag')), contentType, lastModified: new Date() };
  }

  private async putBuffer(key: string, body: Buffer, contentType: string): Promise<StorageAdapterMetadata> {
    const { res } = await this.send({
      method: 'PUT',
      key,
      headers: { 'content-type': contentType },
      body,
      payloadHash: sha256Hex(body),
      replayable: true,
    });
    return { size: body.length, etag: stripQuotes(res.headers.get('etag')), contentType, lastModified: new Date() };
  }

  /** Reads the stream one part at a time: one part is a PutObject, more become a multipart upload. */
  private async putChunked(key: string, source: Readable, contentType: string, partSize: number): Promise<StorageAdapterMetadata> {
    const chunks = readChunks(source, partSize);
    try {
      const first = await chunks.next();
      if (first.done) {
        return await this.putBuffer(key, Buffer.alloc(0), contentType);
      }
      const second = await chunks.next();
      if (second.done) {
        return await this.putBuffer(key, first.value, contentType);
      }
      return await this.multipartUpload(key, contentType, [first.value, second.value], chunks);
    } catch (err) {
      throw wrapSourceError(err);
    } finally {
      await chunks.return(undefined);
    }
  }

  private async multipartUpload(
    key: string,
    contentType: string,
    initialParts: Buffer[],
    rest: AsyncGenerator<Buffer>
  ): Promise<StorageAdapterMetadata> {
    const uploadId = await this.createMultipartUpload(key, contentType);
    const parts: Array<{ partNumber: number; etag: string }> = [];
    let total = 0;
    try {
      const upload = async (body: Buffer): Promise<void> => {
        const partNumber = parts.length + 1;
        if (partNumber > S3_MAX_PARTS) {
          throw new StorageAdapterError(`Upload exceeds ${S3_MAX_PARTS} parts`, PROVIDER);
        }
        parts.push({ partNumber, etag: await this.uploadPart(key, uploadId, partNumber, body) });
        total += body.length;
      };
      for (const body of initialParts) {
        await upload(body);
      }
      for await (const body of rest) {
        await upload(body);
      }
    } catch (err) {
      await this.abortMultipartUpload(key, uploadId).catch(() => undefined);
      throw wrapSourceError(err);
    }

    try {
      const etag = await this.completeMultipartUpload(key, uploadId, parts);
      return { size: total, etag, contentType, lastModified: new Date() };
    } catch (err) {
      if (isAmbiguousCompletion(err)) {
        const verifiedEtag = await this.verifyCompletion(
          key,
          uploadId,
          parts.map((part) => part.etag),
          total
        );
        if (verifiedEtag !== undefined) {
          return { size: total, etag: verifiedEtag, contentType, lastModified: new Date() };
        }
      }
      await this.abortMultipartUpload(key, uploadId).catch(() => undefined);
      throw err;
    }
  }

  /**
   * After an ambiguous Complete failure: the upload counts as completed only when ListParts says
   * the upload is gone and HEAD shows the object with the expected size and exactly the multipart
   * ETag computed from our own part ETags, so another writer's object is never taken as ours.
   * Returns that ETag, or undefined when completion is not proven.
   */
  private async verifyCompletion(
    key: string,
    uploadId: string,
    partEtags: readonly string[],
    size: number
  ): Promise<string | undefined> {
    const expected = expectedMultipartEtag(partEtags);
    if (expected === undefined) {
      return undefined;
    }
    try {
      await this.send({
        method: 'GET',
        key,
        query: [['uploadId', uploadId]],
        payloadHash: EMPTY_PAYLOAD_SHA256,
        replayable: true,
        readBody: true,
      });
      return undefined;
    } catch (err) {
      if (!(err instanceof StorageServiceError && err.code === NO_SUCH_UPLOAD_CODE)) {
        return undefined;
      }
    }
    const head = await this.head(key).catch(() => null);
    if (head?.size === size && head.etag?.toLowerCase() === expected) {
      return expected;
    }
    return undefined;
  }

  private async createMultipartUpload(key: string, contentType: string): Promise<string> {
    const { text } = await this.send({
      method: 'POST',
      key,
      query: [['uploads', '']],
      headers: { 'content-type': contentType },
      payloadHash: EMPTY_PAYLOAD_SHA256,
      // Not idempotent: a replay could open a second, orphaned upload.
      replayable: false,
      readBody: true,
    });
    const uploadId = text ? readXmlElement(text, 'UploadId') : undefined;
    if (!uploadId) {
      throw new StorageServiceError('CreateMultipartUpload response has no UploadId', PROVIDER, { retryable: false });
    }
    return uploadId;
  }

  private async uploadPart(key: string, uploadId: string, partNumber: number, body: Buffer): Promise<string> {
    const { res } = await this.send({
      method: 'PUT',
      key,
      query: [
        ['partNumber', String(partNumber)],
        ['uploadId', uploadId],
      ],
      body,
      payloadHash: sha256Hex(body),
      replayable: true,
    });
    const etag = res.headers.get('etag');
    if (!etag) {
      throw new StorageServiceError(`UploadPart ${partNumber} response has no ETag`, PROVIDER, { retryable: false });
    }
    return etag;
  }

  private async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: Array<{ partNumber: number; etag: string }>
  ): Promise<string> {
    const xml =
      '<CompleteMultipartUpload>' +
      parts
        .map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${escapeXmlText(part.etag)}</ETag></Part>`)
        .join('') +
      '</CompleteMultipartUpload>';
    const body = Buffer.from(xml, 'utf-8');
    const { text } = await this.send({
      method: 'POST',
      key,
      query: [['uploadId', uploadId]],
      headers: { 'content-type': 'application/xml' },
      body,
      payloadHash: sha256Hex(body),
      replayable: true,
      readBody: true,
    });
    const etag = text?.includes(COMPLETE_RESULT_ELEMENT) ? readXmlElement(text, 'ETag') : undefined;
    if (!etag) {
      throw new StorageServiceError(
        'CompleteMultipartUpload answered without a result ETag; completion is unconfirmed',
        PROVIDER,
        { code: UNCONFIRMED_COMPLETION_CODE, retryable: false }
      );
    }
    return etag.replace(/"/g, '');
  }

  private async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.send({
      method: 'DELETE',
      key,
      query: [['uploadId', uploadId]],
      payloadHash: EMPTY_PAYLOAD_SHA256,
      replayable: true,
      allowNotFound: true,
    });
  }
}
