import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import { fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';
import {
  StorageAdapterError,
  StorageAuthenticationError,
  StorageInputError,
  StorageInvalidKeyError,
  StorageNotFoundError,
  StorageServiceError,
  StorageTimeoutError,
} from './adapters/adapter-interface';
import {
  AUTH_ERROR_CODES,
  BODY_LENGTH_MISMATCH_CODE,
  COMPLETE_RESULT_ELEMENT,
  DEFAULT_CONTENT_TYPE,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_RETRY_BASE_DELAY_MS,
  ERROR_ELEMENT_PATTERN,
  HTTP_FORBIDDEN,
  HTTP_NOT_FOUND,
  HTTP_REDIRECT_MAX,
  HTTP_REDIRECT_MIN,
  HTTP_SERVER_ERROR_MIN,
  HTTP_TOO_MANY_REQUESTS,
  HTTP_UNAUTHORIZED,
  MALFORMED_XML_CODE,
  MAX_RETRY_DELAY_MS,
  NOT_FOUND_CODES,
  NO_SUCH_UPLOAD_CODE,
  RETRYABLE_ERROR_CODES,
  S3_DEFAULT_PART_BYTES,
  S3_MAX_PARTS,
  S3_MAX_PART_BYTES,
  S3_MIN_PART_BYTES,
  S3_REQUEST_MAX_DURATION_MS,
  UNCONFIRMED_COMPLETION_CODE,
  XML_WHITESPACE_BYTES,
  declaresDtd,
  decodeXmlText,
  escapeXmlText,
  expectedMultipartEtag,
  isAbortError,
  parseS3ErrorXml,
  readChunks,
  readLimitedText,
  readXmlElement,
  sleep,
  stripQuotes,
  toNodeReadable,
} from './adapters/s3';
import {
  EMPTY_PAYLOAD_SHA256,
  PRESIGN_MAX_EXPIRES_SECONDS,
  SigV4SigningError,
  UNSIGNED_PAYLOAD,
  assertValidBucketName,
  assertValidObjectKey,
  presignS3Request,
  resolveS3Address,
  sha256Hex,
  signS3Request,
} from './s3-sigv4';

/**
 * Network client for the internal object store: any S3-compatible endpoint, in production the
 * OCI Object Storage S3 compatibility endpoint
 * `https://<namespace>.compat.objectstorage.<region>.oraclecloud.com` with path-style addressing.
 *
 * Every request is signed with SigV4 header authentication (see s3-sigv4.ts). Bodies are
 * streamed: a part is the largest buffer ever held, and a download is handed to the caller as a
 * stream under an inactivity timeout and an absolute ceiling.
 *
 * Unlike the BYOS adapter, the endpoint here is operator configuration and never customer input,
 * so there is no SSRF layer; the endpoint must still be https in production.
 */

const MIB = 1024 * 1024;
const DEFAULT_PROVIDER = 's3-compatible';
const PRODUCTION_ENV = 'production';

/** Maximum number of user metadata bytes S3 accepts in the request headers. */
export const S3_MAX_METADATA_BYTES = 2 * 1024;
/** Bound for one XML answer (list pages are the largest); a larger answer is refused, not truncated. */
export const S3_MAX_XML_RESPONSE_BYTES = 8 * MIB;
/** Keys per ListObjectsV2 page; S3 returns at most this many. */
export const S3_LIST_PAGE_MAX_KEYS = 1000;
/** Upper bound on pages followed by one `listAll` walk, so a hostile or looping endpoint cannot spin forever. */
export const S3_LIST_MAX_PAGES = 10_000;
/** Parts per ListParts page. */
export const S3_LIST_PARTS_PAGE_SIZE = 1000;
/** Default and maximum validity of a presigned URL created by this client. */
export const DEFAULT_PRESIGN_EXPIRES_SECONDS = 900;

const METADATA_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Printable ASCII only: header values cannot carry anything else safely. */
const METADATA_VALUE_PATTERN = /^[\x20-\x7e]*$/;
const META_HEADER_PREFIX = 'x-amz-meta-';
const MAX_UPLOAD_ID_LENGTH = 1024;
const HTTP_RANGE_NOT_SATISFIABLE = 416;
const HTTP_PARTIAL_CONTENT = 206;
const RANGE_NOT_HONORED_CODE = 'RangeNotHonored';
const RESPONSE_TOO_LARGE_CODE = 'ResponseTooLarge';
const MALFORMED_RESPONSE_CODE = 'MalformedResponse';
const CONTENT_RANGE_PATTERN = /^bytes (\d+)-(\d+)\/(\d+)$/;

export interface S3ObjectClientConfig {
  /** Origin of the S3-compatible endpoint, e.g. `https://ns.compat.objectstorage.ap-seoul-1.oraclecloud.com`. */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Path-style addressing (`/<bucket>/<key>`); defaults to true, which OCI requires. */
  forcePathStyle?: boolean;
  /** Label used in typed errors, e.g. `oci`. */
  providerName?: string;
  /** Multipart part size; between 5 MiB and 5 GiB. Grows automatically to stay within 10,000 parts. */
  partSizeBytes?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  requestTimeoutMs?: number;
  maxRequestDurationMs?: number;
}

export interface PutObjectOptions {
  contentType?: string;
  /** User metadata, sent as `x-amz-meta-<name>`; names are lowercase `[a-z0-9-]`, values printable ASCII. */
  metadata?: Record<string, string>;
}

export interface ObjectHead {
  key: string;
  size: number;
  etag: string;
  contentType?: string;
  lastModified?: Date;
  metadata: Record<string, string>;
}

export interface ByteRangeRequest {
  /** Inclusive first byte offset. */
  start: number;
  /** Inclusive last byte offset. */
  end: number;
}

export interface GetObjectResult extends ObjectHead {
  stream: Readable;
  /** Present for a ranged read: the bytes `[start, end]` served out of `total` (when the server states it). */
  range?: { start: number; end: number; total: number };
}

export interface PutObjectResult {
  size: number;
  etag: string;
  contentType: string;
}

export interface ListedObject {
  key: string;
  size: number;
  etag: string;
  lastModified?: Date;
}

export interface ListObjectsPage {
  objects: ListedObject[];
  isTruncated: boolean;
  nextContinuationToken?: string;
}

export interface ListObjectsOptions {
  prefix?: string;
  maxKeys?: number;
  continuationToken?: string;
}

export interface ListedPart {
  partNumber: number;
  size: number;
  etag: string;
}

export interface MultipartPartRef {
  partNumber: number;
  etag: string;
}

export interface PresignOptions {
  /** Clock override for deterministic URLs. */
  now?: Date;
  /** Sets `response-content-disposition` on a GET so the download carries a filename. */
  responseContentDisposition?: string;
  responseContentType?: string;
}

export interface PresignedObjectUrl {
  url: string;
  /** Millisecond epoch time after which the URL is rejected. */
  expiresAt: number;
  signature: string;
  method: 'GET' | 'PUT';
}

type RequestBody = Buffer | Readable;

interface S3Request {
  method: 'GET' | 'PUT' | 'POST' | 'HEAD' | 'DELETE';
  key: string;
  query?: Array<[string, string]>;
  headers?: Record<string, string>;
  body?: RequestBody;
  payloadHash: string;
  /** Whether the body can be sent again; a consumed stream cannot be retried. */
  replayable: boolean;
  allowNotFound?: boolean;
  /** Keep the deadlines running after success so the caller can bound the response body. */
  streamBody?: boolean;
  /** Read the XML answer (an `<Error>` inside a 2xx is a failure) and return its text. */
  readBody?: boolean;
}

interface RequestDeadlines {
  touch: () => void;
  clear: () => void;
  signal: AbortSignal;
  timedOutAfterMs: () => number | undefined;
}

interface S3Response {
  res: Response;
  text?: string;
  deadlines?: RequestDeadlines;
}

function isIntegerInRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

function parseHttpDate(value: string | null): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function readMetadataHeaders(headers: Headers): Record<string, string> {
  const metadata: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (name.startsWith(META_HEADER_PREFIX)) {
      metadata[name.slice(META_HEADER_PREFIX.length)] = value;
    }
  });
  return metadata;
}

/** Reads a whole answer up to `limit` bytes; a longer one is refused so nothing is silently cut off. */
async function readXmlBody(res: Response, limit: number, onBytes: () => void, provider: string): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let started = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onBytes();
    let content = value;
    if (!started) {
      let i = 0;
      while (i < value.length && XML_WHITESPACE_BYTES.has(value[i])) i++;
      content = value.subarray(i);
      started = content.length > 0;
    }
    if (content.length > 0) {
      total += content.length;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new StorageServiceError(
          `S3 answer is larger than ${limit} bytes and was refused`,
          provider,
          { code: RESPONSE_TOO_LARGE_CODE, retryable: false }
        );
      }
      chunks.push(content);
    }
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function wrapSourceError(err: unknown, provider: string): StorageAdapterError {
  if (err instanceof StorageAdapterError) return err;
  return new StorageServiceError('Upload source stream failed', provider, { retryable: false }, err);
}

function isRetryable(err: StorageAdapterError): boolean {
  return err instanceof StorageTimeoutError || (err instanceof StorageServiceError && err.retryable);
}

function isAmbiguousCompletion(err: unknown): boolean {
  return (
    err instanceof StorageTimeoutError ||
    (err instanceof StorageServiceError &&
      (err.retryable || err.code === NO_SUCH_UPLOAD_CODE || err.code === UNCONFIRMED_COMPLETION_CODE))
  );
}

export class S3ObjectClient {
  readonly providerName: string;
  readonly bucket: string;
  readonly region: string;
  readonly endpoint: string;
  readonly #accessKeyId: string;
  readonly #secretAccessKey: string;
  readonly #sessionToken?: string;
  private readonly forcePathStyle: boolean;
  /** Multipart part size used when streaming an upload of unknown size. */
  readonly partSizeBytes: number;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxRequestDurationMs: number;

  constructor(config: S3ObjectClientConfig) {
    this.providerName = config.providerName ?? DEFAULT_PROVIDER;
    if (!config.accessKeyId || !config.secretAccessKey) {
      throw new StorageAuthenticationError('accessKeyId and secretAccessKey are required', this.providerName);
    }
    if (!config.bucket || !config.region || !config.endpoint) {
      throw new StorageAdapterError('bucket, region, and endpoint are required', this.providerName);
    }
    try {
      assertValidBucketName(config.bucket);
    } catch (err) {
      throw new StorageAdapterError(err instanceof Error ? err.message : 'Invalid bucket name', this.providerName, err);
    }
    this.endpoint = S3ObjectClient.normalizeEndpoint(config.endpoint, this.providerName);
    this.bucket = config.bucket;
    this.region = config.region;
    this.#accessKeyId = config.accessKeyId;
    this.#secretAccessKey = config.secretAccessKey;
    this.#sessionToken = config.sessionToken || undefined;
    this.forcePathStyle = config.forcePathStyle ?? true;

    const partSize = config.partSizeBytes ?? S3_DEFAULT_PART_BYTES;
    if (!isIntegerInRange(partSize, S3_MIN_PART_BYTES, S3_MAX_PART_BYTES)) {
      throw new StorageAdapterError(
        `Part size must be an integer between ${S3_MIN_PART_BYTES} and ${S3_MAX_PART_BYTES} bytes`,
        this.providerName
      );
    }
    this.partSizeBytes = partSize;
    this.maxAttempts = Math.max(1, config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.retryBaseDelayMs = Math.max(0, config.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS);
    this.requestTimeoutMs = Math.max(1, config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    this.maxRequestDurationMs = Math.max(1, config.maxRequestDurationMs ?? S3_REQUEST_MAX_DURATION_MS);
  }

  /** Origin only (scheme and authority); https is required in production. */
  private static normalizeEndpoint(endpoint: string, provider: string): string {
    let parsed: URL;
    try {
      parsed = new URL(endpoint);
    } catch (err) {
      throw new StorageAdapterError('Storage endpoint does not form a valid URL', provider, err);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new StorageAdapterError(`Storage endpoint must use https, got "${parsed.protocol}"`, provider);
    }
    if (parsed.protocol !== 'https:' && process.env.NODE_ENV === PRODUCTION_ENV) {
      throw new StorageAdapterError('Storage endpoint must use https in production', provider);
    }
    if (parsed.username || parsed.password) {
      throw new StorageAdapterError('Storage endpoint must not carry user info', provider);
    }
    return `${parsed.protocol}//${parsed.host}`;
  }

  // ---------------------------------------------------------------------------------------------
  // Addressing, signing, and the request pipeline
  // ---------------------------------------------------------------------------------------------

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
        throw new StorageAdapterError(err.message, this.providerName, err);
      }
      throw err;
    }
  }

  private assertKey(key: string): void {
    try {
      assertValidObjectKey(key);
    } catch (err) {
      throw new StorageInvalidKeyError(err instanceof Error ? err.message : 'Invalid object key', this.providerName, err);
    }
  }

  private retryDelay(attempt: number): number {
    const ceiling = Math.min(MAX_RETRY_DELAY_MS, this.retryBaseDelayMs * 2 ** (attempt - 1));
    return ceiling > 0 ? crypto.randomInt(0, ceiling + 1) : 0;
  }

  private metadataHeaders(metadata: Record<string, string> | undefined): Record<string, string> {
    const headers: Record<string, string> = {};
    let bytes = 0;
    for (const [name, value] of Object.entries(metadata ?? {})) {
      if (!METADATA_NAME_PATTERN.test(name)) {
        throw new StorageInputError(`Invalid metadata name "${name}"`, this.providerName);
      }
      if (!METADATA_VALUE_PATTERN.test(value)) {
        throw new StorageInputError(`Metadata "${name}" must be printable ASCII`, this.providerName);
      }
      bytes += name.length + value.length;
      headers[`${META_HEADER_PREFIX}${name}`] = value;
    }
    if (bytes > S3_MAX_METADATA_BYTES) {
      throw new StorageInputError(`Object metadata exceeds ${S3_MAX_METADATA_BYTES} bytes`, this.providerName);
    }
    return headers;
  }

  private sign(request: S3Request, address: { origin: string; path: string }) {
    return signS3Request({
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
  }

  private startDeadlines(): RequestDeadlines {
    const controller = new AbortController();
    let timedOutAfterMs: number | undefined;
    const abortAfter = (ms: number) => () => {
      timedOutAfterMs ??= ms;
      controller.abort();
    };
    const onInactive = abortAfter(this.requestTimeoutMs);
    let timer = setTimeout(onInactive, this.requestTimeoutMs);
    const ceiling = setTimeout(abortAfter(this.maxRequestDurationMs), this.maxRequestDurationMs);
    return {
      touch: () => {
        clearTimeout(timer);
        timer = setTimeout(onInactive, this.requestTimeoutMs);
      },
      clear: () => {
        clearTimeout(timer);
        clearTimeout(ceiling);
      },
      signal: controller.signal,
      timedOutAfterMs: () => timedOutAfterMs,
    };
  }

  private mapTransportError(err: unknown, timedOutAfterMs?: number): StorageAdapterError {
    if (err instanceof StorageAdapterError) return err;
    if (timedOutAfterMs !== undefined) return new StorageTimeoutError(timedOutAfterMs, this.providerName);
    if (isAbortError(err)) return new StorageTimeoutError(this.requestTimeoutMs, this.providerName);
    const message = err instanceof Error ? err.message : String(err);
    return new StorageServiceError(`S3 request failed: ${message}`, this.providerName, { retryable: true }, err);
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
    const details = { statusCode: status, code: doc.code, requestId: doc.requestId };
    if (doc.code === NO_SUCH_UPLOAD_CODE) {
      return new StorageServiceError('Multipart upload no longer exists', this.providerName, {
        ...details,
        retryable: false,
      });
    }
    if (status === HTTP_NOT_FOUND || (doc.code && NOT_FOUND_CODES.has(doc.code))) {
      return new StorageNotFoundError(key, this.providerName);
    }
    if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN || (doc.code && AUTH_ERROR_CODES.has(doc.code))) {
      return new StorageAuthenticationError(
        `${doc.code ?? `HTTP ${status}`}${doc.message ? `: ${doc.message}` : ''}`,
        this.providerName
      );
    }
    if (status >= HTTP_REDIRECT_MIN && status <= HTTP_REDIRECT_MAX) {
      return new StorageServiceError(
        `S3 endpoint answered with a redirect (HTTP ${status}); check the bucket region and endpoint`,
        this.providerName,
        { ...details, retryable: false }
      );
    }
    if (status === HTTP_RANGE_NOT_SATISFIABLE) {
      return new StorageServiceError('Requested range is not satisfiable', this.providerName, {
        ...details,
        code: doc.code ?? 'InvalidRange',
        retryable: false,
      });
    }
    const retryable =
      status >= HTTP_SERVER_ERROR_MIN ||
      status === HTTP_TOO_MANY_REQUESTS ||
      (doc.code !== undefined && RETRYABLE_ERROR_CODES.has(doc.code));
    return new StorageServiceError(
      `S3 request failed (HTTP ${status}${doc.code ? ` ${doc.code}` : ''})${doc.message ? `: ${doc.message}` : ''}`,
      this.providerName,
      { ...details, retryable }
    );
  }

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
    const text = await readXmlBody(res, S3_MAX_XML_RESPONSE_BYTES, onBytes, this.providerName);
    if (declaresDtd(text)) {
      return {
        error: new StorageServiceError('S3 response declares a DTD and was refused', this.providerName, {
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

  private async attemptOnce(
    request: S3Request,
    address: { origin: string; path: string }
  ): Promise<{ ok: S3Response } | { error: StorageAdapterError }> {
    const signed = this.sign(request, address);
    const deadlines = this.startDeadlines();
    let res: Response;
    try {
      res = (await undiciFetch(signed.url, {
        method: request.method,
        headers: signed.headers,
        body: request.body,
        duplex: request.body instanceof Readable ? 'half' : undefined,
        redirect: 'manual',
        signal: deadlines.signal,
      } as UndiciRequestInit)) as unknown as Response;
    } catch (err) {
      deadlines.clear();
      return { error: this.mapTransportError(err, deadlines.timedOutAfterMs()) };
    }

    let handedOver = false;
    try {
      const outcome = await this.readOutcome(res, request, deadlines.touch);
      if ('ok' in outcome && request.streamBody && outcome.ok.res.ok) {
        handedOver = true;
        return { ok: { ...outcome.ok, deadlines } };
      }
      return outcome;
    } catch (err) {
      return { error: this.mapTransportError(err, deadlines.timedOutAfterMs()) };
    } finally {
      if (!handedOver) deadlines.clear();
    }
  }

  private async send(request: S3Request): Promise<S3Response> {
    const address = this.address(request.key);
    let lastError: StorageAdapterError | null = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (attempt > 1) {
        await sleep(this.retryDelay(attempt - 1));
      }
      const outcome = await this.attemptOnce(request, address);
      if ('ok' in outcome) {
        return outcome.ok;
      }
      lastError = outcome.error;
      if (!(isRetryable(lastError) && request.replayable)) {
        throw lastError;
      }
    }
    throw lastError ?? new StorageServiceError('S3 request failed', this.providerName, { retryable: false });
  }

  /**
   * Streams a response body under the request's deadlines: every chunk extends the inactivity
   * timeout, the absolute ceiling keeps counting from the request start, and the body length must
   * equal `expectedLength` (the Content-Length) exactly. Any failure destroys the stream with a
   * typed storage error.
   */
  private boundedBody(res: Response, deadlines: RequestDeadlines): Readable {
    const lengthHeader = res.headers.get('content-length');
    const declared = lengthHeader === null ? undefined : Number.parseInt(lengthHeader, 10);
    const source = Readable.fromWeb(res.body as unknown as NodeWebReadableStream<Uint8Array>);
    let received = 0;
    const lengthError = () =>
      new StorageServiceError(
        `Response body length ${received} does not match Content-Length ${declared}`,
        this.providerName,
        { code: BODY_LENGTH_MISMATCH_CODE, retryable: false }
      );

    const output = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        deadlines.touch();
        received += chunk.length;
        if (declared !== undefined && received > declared) {
          callback(lengthError());
          return;
        }
        callback(null, chunk);
      },
      flush: (callback) => {
        deadlines.clear();
        callback(declared !== undefined && received !== declared ? lengthError() : null);
      },
    });

    const fail = (err: unknown) => {
      deadlines.clear();
      if (!output.destroyed) output.destroy(this.mapTransportError(err, deadlines.timedOutAfterMs()));
    };
    const onAbort = () =>
      fail(new StorageTimeoutError(deadlines.timedOutAfterMs() ?? this.requestTimeoutMs, this.providerName));
    deadlines.signal.addEventListener('abort', onAbort, { once: true });
    source.on('error', fail);
    output.on('close', () => {
      deadlines.clear();
      deadlines.signal.removeEventListener('abort', onAbort);
      source.destroy();
    });
    source.pipe(output);
    return output;
  }

  // ---------------------------------------------------------------------------------------------
  // Objects
  // ---------------------------------------------------------------------------------------------

  /** Metadata of an object, or null when it does not exist. */
  async headObject(key: string): Promise<ObjectHead | null> {
    this.assertKey(key);
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
    return this.headFromResponse(key, res);
  }

  private headFromResponse(key: string, res: Response): ObjectHead {
    const length = res.headers.get('content-length');
    return {
      key,
      size: length ? Number.parseInt(length, 10) : 0,
      etag: stripQuotes(res.headers.get('etag')) ?? '',
      contentType: res.headers.get('content-type') ?? undefined,
      lastModified: parseHttpDate(res.headers.get('last-modified')),
      metadata: readMetadataHeaders(res.headers),
    };
  }

  /**
   * Opens an object (or a byte range of it) as a stream; null when it does not exist. A range the
   * server does not honour with 206 is refused rather than served as the whole object.
   */
  async getObject(key: string, range?: ByteRangeRequest): Promise<GetObjectResult | null> {
    this.assertKey(key);
    const headers: Record<string, string> = {};
    if (range) {
      if (
        !Number.isSafeInteger(range.start) ||
        !Number.isSafeInteger(range.end) ||
        range.start < 0 ||
        range.end < range.start
      ) {
        throw new StorageInputError(`Invalid byte range ${range.start}-${range.end}`, this.providerName);
      }
      headers.range = `bytes=${range.start}-${range.end}`;
    }
    const { res, deadlines } = await this.send({
      method: 'GET',
      key,
      headers,
      payloadHash: EMPTY_PAYLOAD_SHA256,
      replayable: true,
      allowNotFound: true,
      streamBody: true,
    });
    if (res.status === HTTP_NOT_FOUND) {
      return null;
    }
    if (!deadlines) {
      throw new StorageServiceError('S3 download lost its deadlines', this.providerName, { retryable: false });
    }
    if (range && res.status !== HTTP_PARTIAL_CONTENT) {
      deadlines.clear();
      await res.body?.cancel().catch(() => undefined);
      throw new StorageServiceError(
        `Server answered a ranged read with HTTP ${res.status} instead of 206`,
        this.providerName,
        { statusCode: res.status, code: RANGE_NOT_HONORED_CODE, retryable: false }
      );
    }
    const head = this.headFromResponse(key, res);
    let servedRange: GetObjectResult['range'];
    if (range) {
      const match = CONTENT_RANGE_PATTERN.exec(res.headers.get('content-range') ?? '');
      if (!match) {
        deadlines.clear();
        await res.body?.cancel().catch(() => undefined);
        throw new StorageServiceError('Ranged read answered without a valid Content-Range', this.providerName, {
          statusCode: res.status,
          code: MALFORMED_RESPONSE_CODE,
          retryable: false,
        });
      }
      servedRange = {
        start: Number.parseInt(match[1], 10),
        end: Number.parseInt(match[2], 10),
        total: Number.parseInt(match[3], 10),
      };
      if (servedRange.start !== range.start || servedRange.end > range.end) {
        deadlines.clear();
        await res.body?.cancel().catch(() => undefined);
        throw this.malformed(
          `Ranged read served bytes ${servedRange.start}-${servedRange.end} for the request ${range.start}-${range.end}`
        );
      }
      // The object's size is the Content-Range total, not the length of the slice.
      head.size = servedRange.total;
    }
    if (!res.body) {
      deadlines.clear();
      return { ...head, stream: Readable.from([]), range: servedRange };
    }
    return { ...head, stream: this.boundedBody(res, deadlines), range: servedRange };
  }

  /** Deletes an object; false when the server reports it did not exist. */
  async deleteObject(key: string): Promise<boolean> {
    this.assertKey(key);
    const { res } = await this.send({
      method: 'DELETE',
      key,
      payloadHash: EMPTY_PAYLOAD_SHA256,
      replayable: true,
      allowNotFound: true,
    });
    return res.status !== HTTP_NOT_FOUND;
  }

  /** Stores a buffer in one PutObject request (the SHA-256 of the payload is signed). */
  async putBuffer(key: string, body: Buffer, options: PutObjectOptions = {}): Promise<PutObjectResult> {
    this.assertKey(key);
    return this.sendBufferWithMetadata(
      key,
      body,
      options.contentType || DEFAULT_CONTENT_TYPE,
      this.metadataHeaders(options.metadata)
    );
  }

  /**
   * Stores a stream. With a known `size` up to one part it is a single streamed PutObject; any
   * other stream is cut into parts and sent as a multipart upload, holding one part at a time.
   */
  async putStream(
    key: string,
    stream: NodeJS.ReadableStream | ReadableStream<Uint8Array>,
    options: PutObjectOptions & { size?: number } = {}
  ): Promise<PutObjectResult> {
    this.assertKey(key);
    const contentType = options.contentType || DEFAULT_CONTENT_TYPE;
    const size = options.size;
    if (size !== undefined && (!Number.isSafeInteger(size) || size < 0)) {
      throw new StorageInputError(`Invalid upload size: ${size}`, this.providerName);
    }
    const source = toNodeReadable(stream);
    const metadata = this.metadataHeaders(options.metadata);

    if (size !== undefined && size <= this.partSizeBytes) {
      return this.putSizedStream(key, source, size, contentType, metadata);
    }
    return this.putChunkedStream(key, source, contentType, metadata, this.partSizeFor(size));
  }

  /** Part size that keeps an upload of `size` bytes within 10,000 parts. */
  private partSizeFor(size: number | undefined): number {
    if (size === undefined) return this.partSizeBytes;
    const needed = Math.ceil(size / S3_MAX_PARTS);
    const partSize = Math.max(this.partSizeBytes, Math.ceil(needed / MIB) * MIB);
    if (partSize > S3_MAX_PART_BYTES) {
      throw new StorageInputError(`Object of ${size} bytes exceeds the multipart upload limit`, this.providerName);
    }
    return partSize;
  }

  private async putSizedStream(
    key: string,
    source: Readable,
    size: number,
    contentType: string,
    metadata: Record<string, string>
  ): Promise<PutObjectResult> {
    const { res } = await this.send({
      method: 'PUT',
      key,
      headers: { 'content-type': contentType, 'content-length': String(size), ...metadata },
      body: size === 0 ? Buffer.alloc(0) : source,
      payloadHash: UNSIGNED_PAYLOAD,
      replayable: false,
    });
    if (size === 0) source.resume();
    return { size, etag: stripQuotes(res.headers.get('etag')) ?? '', contentType };
  }

  private async putChunkedStream(
    key: string,
    source: Readable,
    contentType: string,
    metadata: Record<string, string>,
    partSize: number
  ): Promise<PutObjectResult> {
    const chunks = readChunks(source, partSize);
    try {
      const first = await chunks.next();
      if (first.done) {
        return await this.sendBufferWithMetadata(key, Buffer.alloc(0), contentType, metadata);
      }
      const second = await chunks.next();
      if (second.done) {
        return await this.sendBufferWithMetadata(key, first.value, contentType, metadata);
      }
      return await this.multipartFromChunks(key, contentType, metadata, [first.value, second.value], chunks);
    } catch (err) {
      throw wrapSourceError(err, this.providerName);
    } finally {
      await chunks.return(undefined);
    }
  }

  private async sendBufferWithMetadata(
    key: string,
    body: Buffer,
    contentType: string,
    metadata: Record<string, string>
  ): Promise<PutObjectResult> {
    const { res } = await this.send({
      method: 'PUT',
      key,
      headers: { 'content-type': contentType, ...metadata },
      body,
      payloadHash: sha256Hex(body),
      replayable: true,
    });
    return { size: body.length, etag: stripQuotes(res.headers.get('etag')) ?? '', contentType };
  }

  private async multipartFromChunks(
    key: string,
    contentType: string,
    metadata: Record<string, string>,
    initialParts: Buffer[],
    rest: AsyncGenerator<Buffer>
  ): Promise<PutObjectResult> {
    const uploadId = await this.createMultipartUploadRaw(key, contentType, metadata);
    const parts: MultipartPartRef[] = [];
    let total = 0;
    try {
      const upload = async (body: Buffer): Promise<void> => {
        const partNumber = parts.length + 1;
        if (partNumber > S3_MAX_PARTS) {
          throw new StorageInputError(`Upload exceeds ${S3_MAX_PARTS} parts`, this.providerName);
        }
        const { etag } = await this.uploadPart(key, uploadId, partNumber, body);
        parts.push({ partNumber, etag });
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
      throw wrapSourceError(err, this.providerName);
    }

    try {
      const { etag } = await this.completeMultipartUpload(key, uploadId, parts);
      return { size: total, etag, contentType };
    } catch (err) {
      if (isAmbiguousCompletion(err)) {
        const verifiedEtag = await this.verifyCompletion(
          key,
          uploadId,
          parts.map((part) => part.etag),
          total
        );
        if (verifiedEtag !== undefined) {
          return { size: total, etag: verifiedEtag, contentType };
        }
      }
      await this.abortMultipartUpload(key, uploadId).catch(() => undefined);
      throw err;
    }
  }

  /**
   * After an ambiguous Complete failure the upload counts as completed only when ListParts says
   * the upload is gone and HEAD shows the object with the expected size and exactly the multipart
   * ETag computed from our own part ETags, so another writer's object is never taken as ours.
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
      await this.listParts(key, uploadId);
      return undefined;
    } catch (err) {
      if (!(err instanceof StorageServiceError && err.code === NO_SUCH_UPLOAD_CODE)) {
        return undefined;
      }
    }
    const head = await this.headObject(key).catch(() => null);
    if (head?.size === size && head.etag.toLowerCase() === expected) {
      return expected;
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------------------------
  // Listing
  // ---------------------------------------------------------------------------------------------

  /** One page of ListObjectsV2. */
  async listObjects(options: ListObjectsOptions = {}): Promise<ListObjectsPage> {
    const maxKeys = options.maxKeys ?? S3_LIST_PAGE_MAX_KEYS;
    if (!isIntegerInRange(maxKeys, 1, S3_LIST_PAGE_MAX_KEYS)) {
      throw new StorageAdapterError(`maxKeys must be between 1 and ${S3_LIST_PAGE_MAX_KEYS}`, this.providerName);
    }
    const query: Array<[string, string]> = [
      ['list-type', '2'],
      ['max-keys', String(maxKeys)],
    ];
    if (options.prefix) query.push(['prefix', options.prefix]);
    if (options.continuationToken) query.push(['continuation-token', options.continuationToken]);

    const { text } = await this.send({
      method: 'GET',
      key: '',
      query,
      payloadHash: EMPTY_PAYLOAD_SHA256,
      replayable: true,
      readBody: true,
    });
    return this.parseListObjects(text ?? '');
  }

  private parseListObjects(xml: string): ListObjectsPage {
    const objects: ListedObject[] = [];
    const open = '<Contents>';
    const close = '</Contents>';
    let from = xml.indexOf(open);
    while (from !== -1) {
      const end = xml.indexOf(close, from);
      if (end === -1) {
        throw this.malformed('ListObjectsV2 answer has an unterminated <Contents>');
      }
      const block = xml.slice(from + open.length, end);
      const key = readXmlElement(block, 'Key');
      const size = Number.parseInt(readXmlElement(block, 'Size') ?? '', 10);
      if (key === undefined || !Number.isSafeInteger(size) || size < 0) {
        throw this.malformed('ListObjectsV2 answer has an entry without a valid Key and Size');
      }
      objects.push({
        key,
        size,
        etag: stripQuotes(readXmlElement(block, 'ETag')) ?? '',
        lastModified: parseHttpDate(readXmlElement(block, 'LastModified') ?? null),
      });
      from = xml.indexOf(open, end + close.length);
    }
    const envelope = stripEntryBlocks(xml, ['Contents']);
    const isTruncated = readXmlElement(envelope, 'IsTruncated') === 'true';
    const nextContinuationToken = readXmlElement(envelope, 'NextContinuationToken');
    if (isTruncated && !nextContinuationToken) {
      throw this.malformed('ListObjectsV2 answer is truncated but has no NextContinuationToken');
    }
    return { objects, isTruncated, nextContinuationToken };
  }

  /**
   * Walks every object under a prefix. `maxObjects` bounds the walk (and so the work done for any
   * caller-controlled prefix); the walk throws when more objects exist than the bound allows.
   */
  async *listAll(prefix: string, maxObjects: number): AsyncGenerator<ListedObject> {
    if (!Number.isSafeInteger(maxObjects) || maxObjects < 1) {
      throw new StorageAdapterError('maxObjects must be a positive integer', this.providerName);
    }
    let token: string | undefined;
    let yielded = 0;
    for (let page = 0; page < S3_LIST_MAX_PAGES; page++) {
      const result = await this.listObjects({ prefix, continuationToken: token });
      for (const object of result.objects) {
        if (yielded >= maxObjects) {
          throw new StorageAdapterError(`More than ${maxObjects} objects under prefix "${prefix}"`, this.providerName);
        }
        yielded++;
        yield object;
      }
      if (!result.isTruncated) return;
      token = result.nextContinuationToken;
    }
    throw new StorageAdapterError(`Listing "${prefix}" did not finish within ${S3_LIST_MAX_PAGES} pages`, this.providerName);
  }

  private malformed(message: string): StorageServiceError {
    return new StorageServiceError(message, this.providerName, { code: MALFORMED_RESPONSE_CODE, retryable: false });
  }

  // ---------------------------------------------------------------------------------------------
  // Multipart uploads
  // ---------------------------------------------------------------------------------------------

  private assertUploadId(uploadId: string): void {
    if (!uploadId || uploadId.length > MAX_UPLOAD_ID_LENGTH) {
      throw new StorageInputError('Invalid multipart upload id', this.providerName);
    }
  }

  private assertPartNumber(partNumber: number): void {
    if (!isIntegerInRange(partNumber, 1, S3_MAX_PARTS)) {
      throw new StorageInputError(`Part number must be an integer between 1 and ${S3_MAX_PARTS}`, this.providerName);
    }
  }

  async createMultipartUpload(key: string, options: PutObjectOptions = {}): Promise<string> {
    this.assertKey(key);
    return this.createMultipartUploadRaw(
      key,
      options.contentType || DEFAULT_CONTENT_TYPE,
      this.metadataHeaders(options.metadata)
    );
  }

  private async createMultipartUploadRaw(
    key: string,
    contentType: string,
    metadata: Record<string, string>
  ): Promise<string> {
    const { text } = await this.send({
      method: 'POST',
      key,
      query: [['uploads', '']],
      headers: { 'content-type': contentType, ...metadata },
      payloadHash: EMPTY_PAYLOAD_SHA256,
      // Not idempotent: a replay could open a second, orphaned upload.
      replayable: false,
      readBody: true,
    });
    const uploadId = text ? readXmlElement(text, 'UploadId') : undefined;
    if (!uploadId) {
      throw new StorageServiceError('CreateMultipartUpload response has no UploadId', this.providerName, {
        retryable: false,
      });
    }
    return uploadId;
  }

  /**
   * Uploads one part. A Buffer is retried on transient errors; a stream needs `contentLength`
   * (S3 rejects chunked part bodies) and is sent once.
   */
  async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Buffer | NodeJS.ReadableStream,
    contentLength?: number
  ): Promise<{ etag: string }> {
    this.assertKey(key);
    this.assertUploadId(uploadId);
    this.assertPartNumber(partNumber);
    const isBuffer = Buffer.isBuffer(body);
    const length = isBuffer ? body.length : contentLength;
    if (length === undefined || !isIntegerInRange(length, 0, S3_MAX_PART_BYTES)) {
      throw new StorageInputError(
        `Part length must be known and at most ${S3_MAX_PART_BYTES} bytes`,
        this.providerName
      );
    }
    const { res } = await this.send({
      method: 'PUT',
      key,
      query: [
        ['partNumber', String(partNumber)],
        ['uploadId', uploadId],
      ],
      headers: isBuffer ? undefined : { 'content-length': String(length) },
      body: isBuffer ? body : toNodeReadable(body as NodeJS.ReadableStream),
      payloadHash: isBuffer ? sha256Hex(body) : UNSIGNED_PAYLOAD,
      replayable: isBuffer,
    });
    const etag = res.headers.get('etag');
    if (!etag) {
      throw new StorageServiceError(`UploadPart ${partNumber} response has no ETag`, this.providerName, {
        retryable: false,
      });
    }
    return { etag };
  }

  /** Lists the uploaded parts of an open multipart upload (bounded by the 10,000 part limit). */
  async listParts(key: string, uploadId: string): Promise<ListedPart[]> {
    this.assertKey(key);
    this.assertUploadId(uploadId);
    const parts: ListedPart[] = [];
    let marker = 0;
    const maxPages = Math.ceil(S3_MAX_PARTS / S3_LIST_PARTS_PAGE_SIZE) + 1;
    for (let page = 0; page < maxPages; page++) {
      const query: Array<[string, string]> = [
        ['uploadId', uploadId],
        ['max-parts', String(S3_LIST_PARTS_PAGE_SIZE)],
      ];
      if (marker > 0) query.push(['part-number-marker', String(marker)]);
      const { text } = await this.send({
        method: 'GET',
        key,
        query,
        payloadHash: EMPTY_PAYLOAD_SHA256,
        replayable: true,
        readBody: true,
      });
      const xml = text ?? '';
      const open = '<Part>';
      const close = '</Part>';
      let from = xml.indexOf(open);
      while (from !== -1) {
        const end = xml.indexOf(close, from);
        if (end === -1) throw this.malformed('ListParts answer has an unterminated <Part>');
        const block = xml.slice(from + open.length, end);
        const partNumber = Number.parseInt(readXmlElement(block, 'PartNumber') ?? '', 10);
        const size = Number.parseInt(readXmlElement(block, 'Size') ?? '', 10);
        const etag = readXmlElement(block, 'ETag');
        if (!isIntegerInRange(partNumber, 1, S3_MAX_PARTS) || !Number.isSafeInteger(size) || size < 0 || !etag) {
          throw this.malformed('ListParts answer has an entry without a valid PartNumber, Size and ETag');
        }
        parts.push({ partNumber, size, etag });
        if (parts.length > S3_MAX_PARTS) throw this.malformed(`ListParts returned more than ${S3_MAX_PARTS} parts`);
        from = xml.indexOf(open, end + close.length);
      }
      const envelope = stripEntryBlocks(xml, ['Part']);
      if (readXmlElement(envelope, 'IsTruncated') !== 'true') {
        return parts;
      }
      const next = Number.parseInt(readXmlElement(envelope, 'NextPartNumberMarker') ?? '', 10);
      if (!Number.isInteger(next) || next <= marker) {
        throw this.malformed('ListParts is truncated but has no advancing NextPartNumberMarker');
      }
      marker = next;
    }
    throw this.malformed('ListParts did not finish within its page bound');
  }

  /**
   * Completes an upload from the caller's part list (ascending, unique, 1..10,000). S3 can answer
   * 200 with an `<Error>` document or only whitespace keepalives; both are handled, and an answer
   * without a result ETag is reported as unconfirmed instead of success.
   */
  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: readonly MultipartPartRef[]
  ): Promise<{ etag: string }> {
    this.assertKey(key);
    this.assertUploadId(uploadId);
    if (parts.length === 0 || parts.length > S3_MAX_PARTS) {
      throw new StorageInputError(`A multipart upload needs between 1 and ${S3_MAX_PARTS} parts`, this.providerName);
    }
    let previous = 0;
    for (const part of parts) {
      this.assertPartNumber(part.partNumber);
      if (part.partNumber <= previous) {
        throw new StorageInputError('Parts must be listed in ascending order without duplicates', this.providerName);
      }
      if (!part.etag) {
        throw new StorageInputError(`Part ${part.partNumber} has no ETag`, this.providerName);
      }
      previous = part.partNumber;
    }
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
        this.providerName,
        { code: UNCONFIRMED_COMPLETION_CODE, retryable: false }
      );
    }
    return { etag: decodeXmlText(etag).replace(/"/g, '') };
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    this.assertKey(key);
    this.assertUploadId(uploadId);
    await this.send({
      method: 'DELETE',
      key,
      query: [['uploadId', uploadId]],
      payloadHash: EMPTY_PAYLOAD_SHA256,
      replayable: true,
      allowNotFound: true,
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Presigned URLs (SigV4 query authentication with the real credentials and endpoint)
  // ---------------------------------------------------------------------------------------------

  private presign(
    method: 'GET' | 'PUT',
    key: string,
    query: Array<[string, string]>,
    expiresInSeconds: number,
    now?: Date
  ): PresignedObjectUrl {
    this.assertKey(key);
    if (!isIntegerInRange(expiresInSeconds, 1, PRESIGN_MAX_EXPIRES_SECONDS)) {
      throw new StorageInputError(
        `Presign expiry must be an integer between 1 and ${PRESIGN_MAX_EXPIRES_SECONDS} seconds`,
        this.providerName
      );
    }
    const address = this.address(key);
    const presigned = presignS3Request({
      method,
      origin: address.origin,
      path: address.path,
      query,
      credentials: {
        accessKeyId: this.#accessKeyId,
        secretAccessKey: this.#secretAccessKey,
        sessionToken: this.#sessionToken,
      },
      region: this.region,
      expiresInSeconds,
      now,
    });
    return { url: presigned.url, expiresAt: presigned.expiresAt, signature: presigned.signature, method };
  }

  presignGetUrl(
    key: string,
    expiresInSeconds: number = DEFAULT_PRESIGN_EXPIRES_SECONDS,
    options: PresignOptions = {}
  ): PresignedObjectUrl {
    const query: Array<[string, string]> = [];
    if (options.responseContentDisposition) {
      query.push(['response-content-disposition', options.responseContentDisposition]);
    }
    if (options.responseContentType) {
      query.push(['response-content-type', options.responseContentType]);
    }
    return this.presign('GET', key, query, expiresInSeconds, options.now);
  }

  presignPutUrl(
    key: string,
    expiresInSeconds: number = DEFAULT_PRESIGN_EXPIRES_SECONDS,
    options: PresignOptions = {}
  ): PresignedObjectUrl {
    return this.presign('PUT', key, [], expiresInSeconds, options.now);
  }

  /** URL a client PUTs one part of an open multipart upload to; the part's ETag comes back in the response. */
  presignUploadPartUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds: number = DEFAULT_PRESIGN_EXPIRES_SECONDS,
    options: PresignOptions = {}
  ): PresignedObjectUrl {
    this.assertUploadId(uploadId);
    this.assertPartNumber(partNumber);
    return this.presign(
      'PUT',
      key,
      [
        ['partNumber', String(partNumber)],
        ['uploadId', uploadId],
      ],
      expiresInSeconds,
      options.now
    );
  }
}

/**
 * The document with every `<name>...</name>` entry block removed, so the paging fields that
 * surround the entries can be read without an entry-level element of the same name getting in
 * the way. Plain string search; no pattern is built from input.
 */
function stripEntryBlocks(xml: string, names: readonly string[]): string {
  let result = xml;
  for (const name of names) {
    const open = `<${name}>`;
    const close = `</${name}>`;
    let out = '';
    let cursor = 0;
    let from = result.indexOf(open);
    while (from !== -1) {
      const end = result.indexOf(close, from);
      if (end === -1) break;
      out += result.slice(cursor, from);
      cursor = end + close.length;
      from = result.indexOf(open, cursor);
    }
    result = out + result.slice(cursor);
  }
  return result;
}
