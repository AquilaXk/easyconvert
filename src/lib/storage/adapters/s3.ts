import crypto from 'node:crypto';
import { Readable } from 'node:stream';
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
import { isPrivateOrRestrictedHost } from '../../security/ssrf';

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
/** Time allowed until response headers arrive; body streaming is bounded by the agent's idle body timeout. */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
/** Error documents are small; a larger body is truncated so a hostile endpoint cannot exhaust memory. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const PROVIDER = 's3';
const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/**
 * Comma-separated `host[:port]` list of endpoints that may be private or plain HTTP, for a local
 * S3-compatible server during development. Ignored when NODE_ENV is "production".
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

export interface S3AdapterOptions {
  /** Multipart part size; at least 5 MiB. Grows automatically to stay within 10,000 parts. */
  partSizeBytes?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  requestTimeoutMs?: number;
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

function readXmlElement(xml: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml);
  return match ? decodeXmlText(match[1]) : undefined;
}

/** Extracts Code, Message, and RequestId from an S3 `<Error>` document. */
export function parseS3ErrorXml(xml: string): S3ErrorDocument {
  return {
    code: readXmlElement(xml, 'Code'),
    message: readXmlElement(xml, 'Message'),
    requestId: readXmlElement(xml, 'RequestId'),
  };
}

function readDevAllowlist(): ReadonlySet<string> {
  if (process.env.NODE_ENV === 'production') {
    return new Set();
  }
  const raw = process.env[S3_DEV_ENDPOINT_ALLOWLIST_ENV] ?? '';
  return new Set(
    raw
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
}

function isDevAllowlisted(origin: URL): boolean {
  const allowlist = readDevAllowlist();
  return allowlist.has(origin.host.toLowerCase()) || allowlist.has(origin.hostname.toLowerCase());
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

async function readLimitedText(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < MAX_ERROR_BODY_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await reader.cancel().catch(() => undefined);
  return Buffer.concat(chunks).subarray(0, MAX_ERROR_BODY_BYTES).toString('utf-8');
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
  private readonly partSizeBytes: number;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly requestTimeoutMs: number;

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

    const origin = new URL(this.address('').origin);
    this.devAllowlisted = isDevAllowlisted(origin);
    this.assertEndpointPolicy(origin);
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
    if (this.devAllowlisted) {
      return (await undiciFetch(url, { ...init, redirect: 'manual', dispatcher: devDispatcher() })) as unknown as Response;
    }
    return safeFetch(url, init, { maxRedirects: 0 });
  }

  private async toServiceError(res: Response, key: string, body?: string): Promise<StorageAdapterError> {
    const text = body ?? (await readLimitedText(res));
    const doc = parseS3ErrorXml(text);
    const status = res.status;
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
      const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
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
        clearTimeout(timer);
        lastError = isAbortError(err)
          ? new StorageTimeoutError(this.requestTimeoutMs, PROVIDER)
          : this.mapTransportError(err);
        const retryable = lastError instanceof StorageTimeoutError || (lastError instanceof StorageServiceError && lastError.retryable);
        if (retryable && request.replayable) continue;
        throw lastError;
      }

      try {
        if (res.status === HTTP_NOT_FOUND && request.allowNotFound) {
          await res.body?.cancel();
          return { res };
        }
        if (res.ok && !request.readBody) {
          return { res };
        }
        if (res.ok) {
          const text = await readLimitedText(res);
          if (!ERROR_ELEMENT_PATTERN.test(text)) {
            return { res, text };
          }
          lastError = await this.toServiceError(res, request.key, text);
        } else {
          lastError = await this.toServiceError(res, request.key);
        }
      } finally {
        clearTimeout(timer);
      }

      if (!(lastError instanceof StorageServiceError && lastError.retryable && request.replayable)) {
        throw lastError;
      }
    }
    throw lastError ?? new StorageServiceError('S3 request failed', PROVIDER, { retryable: false });
  }

  async downloadStream(remotePath: string): Promise<NodeJS.ReadableStream> {
    const key = this.toKey(remotePath);
    const { res } = await this.send({ method: 'GET', key, payloadHash: EMPTY_PAYLOAD_SHA256, replayable: true });
    if (!res.body) {
      return Readable.from([]);
    }
    return Readable.fromWeb(res.body as unknown as NodeWebReadableStream<Uint8Array>);
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
      const etag = await this.completeMultipartUpload(key, uploadId, parts);
      return { size: total, etag, contentType, lastModified: new Date() };
    } catch (err) {
      await this.abortMultipartUpload(key, uploadId).catch(() => undefined);
      throw err;
    }
  }

  private async createMultipartUpload(key: string, contentType: string): Promise<string> {
    const { text } = await this.send({
      method: 'POST',
      key,
      query: [['uploads', '']],
      headers: { 'content-type': contentType },
      payloadHash: EMPTY_PAYLOAD_SHA256,
      replayable: true,
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
  ): Promise<string | undefined> {
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
    return stripQuotes(text ? readXmlElement(text, 'ETag') : undefined);
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
