import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { MultipartUploadComplete, MultipartUploadInit, UploadedPart } from '../types';
import { StorageAdapterError, StorageInputError, StorageInvalidKeyError } from './adapters/adapter-interface';
import { S3_MAX_PART_BYTES, S3_MAX_PARTS, S3_MIN_PART_BYTES, toNodeReadable } from './adapters/s3';
import {
  ObjectStat,
  PayloadTooLargeForMemoryError,
  StorageSigningSecretMissingError,
  getMaxInMemoryBytes,
} from './errors';
import { buildPutOptions, isObjectExpired, limitFilename, toStoredObjectMetadata } from './object-attributes';
import type {
  IStorageBackend,
  PresignedUrlResult,
  StoredObject,
  UploadSessionInfo,
} from './oci-storage';
import type { ObjectHead, S3ObjectClient } from './s3-object-client';

/**
 * Job storage on an S3-compatible object store (OCI Object Storage in production): the
 * IStorageBackend that STORAGE_DRIVER=oci|s3 puts behind the API routes, the queue and the worker.
 *
 * - Objects, multipart parts and presigned URLs live on the object store; this class holds no
 *   object or session state. An upload session is an HMAC-signed, self-describing token handed out
 *   as the `uploadId`, so any API instance can serve any request of an upload. Parts are tracked by
 *   the object store (ListParts).
 * - Small objects are read into memory; larger ones are staged to a scratch file so native engines
 *   can read them by path. Staged files are short-lived worker scratch, not storage.
 * - Per-object attributes use the mapping in object-attributes.ts, shared with S3CompatibleStorage.
 */

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const MS_PER_SECOND = 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Default part size for a new multipart upload (the S3 minimum for every part but the last). */
export const REMOTE_DEFAULT_PART_BYTES = S3_MIN_PART_BYTES;
/** Open multipart sessions and the objects they produce live for a day, like the local S3 backend. */
export const REMOTE_UPLOAD_SESSION_TTL_MS = 24 * HOUR_MS;
/** Time to live of an object stored without an explicit one. */
export const REMOTE_DEFAULT_OBJECT_TTL_MS = HOUR_MS;
/** A part received from a request body is buffered whole (S3 needs its length); this bounds that buffer. */
export const REMOTE_STREAMED_PART_MAX_BYTES = 64 * MIB;
/** Objects up to this size are read into memory; larger ones are staged to a scratch file. */
export const REMOTE_INLINE_OBJECT_MAX_BYTES = 16 * MIB;
/** Largest object that will be staged to scratch disk. */
export const REMOTE_STAGED_OBJECT_MAX_BYTES = 10 * GIB;
/** Staged scratch files older than this are removed the next time one is staged. */
export const REMOTE_STAGED_FILE_MAX_AGE_MS = 6 * HOUR_MS;
/** deleteByPrefix refuses to walk past this many objects. */
export const REMOTE_DELETE_BY_PREFIX_MAX_OBJECTS = 10_000;
const DELETE_CONCURRENCY = 8;
const UPLOAD_TOKEN_VERSION = 'v1';
const MAX_UPLOAD_TOKEN_LENGTH = 4096;
const MAX_FILENAME_KEY_LENGTH = 200;
const MAX_MIME_TYPE_LENGTH = 255;
const MIME_TYPE_PATTERN = new RegExp(`^[\\x20-\\x7e]{1,${MAX_MIME_TYPE_LENGTH}}$`);
const STAGED_FILE_SUFFIX = '.staged';
const STAGED_DIR_MODE = 0o700;
const STAGED_FILE_MODE = 0o600;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_BAD_REQUEST = 400;
const DEFAULT_PRESIGN_PART_SECONDS = 900;
const DEFAULT_PRESIGN_SECONDS = 3600;

interface UploadToken {
  /** Object store upload id. */
  u: string;
  /** Object key. */
  k: string;
  f: string;
  m: string;
  t: number;
  p: number;
  n: number;
  o?: string;
  /** Creation time, epoch ms. */
  c: number;
}

export interface RemoteStorageBackendOptions {
  /** Secret that signs upload session tokens; the same on every API instance and worker. */
  signingSecret: string;
  providerName?: string;
  /** Directory for staged scratch files; defaults to a private directory under the OS temp dir. */
  scratchDir?: string;
}

function statusError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}

function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function stripEtagQuotes(etag: string): string {
  return etag.replace(/"/g, '');
}

export class RemoteStorageBackend implements IStorageBackend {
  readonly providerName: string;
  readonly kind = 'remote' as const;
  private readonly client: S3ObjectClient;
  private readonly signingSecret: string;
  private readonly scratchDir: string;

  constructor(client: S3ObjectClient, options: RemoteStorageBackendOptions) {
    if (!options.signingSecret) {
      throw new StorageSigningSecretMissingError(
        'Remote storage needs STORAGE_SIGNING_SECRET to sign upload session tokens.'
      );
    }
    this.client = client;
    this.signingSecret = options.signingSecret;
    this.providerName = options.providerName ?? client.providerName;
    this.scratchDir = options.scratchDir ?? path.join(os.tmpdir(), 'easyconvert-staged');
  }

  // ---------------------------------------------------------------------------------------------
  // Upload session tokens
  // ---------------------------------------------------------------------------------------------

  private sign(body: string): string {
    return crypto.createHmac('sha256', this.signingSecret).update(`${UPLOAD_TOKEN_VERSION}.${body}`).digest('base64url');
  }

  private encodeToken(token: UploadToken): string {
    const body = Buffer.from(JSON.stringify(token), 'utf-8').toString('base64url');
    return `${UPLOAD_TOKEN_VERSION}.${body}.${this.sign(body)}`;
  }

  /** The session behind an upload id, or undefined when the token is malformed, forged, or expired. */
  private decodeToken(uploadId: string): UploadToken | undefined {
    if (typeof uploadId !== 'string' || uploadId.length > MAX_UPLOAD_TOKEN_LENGTH) return undefined;
    const pieces = uploadId.split('.');
    if (pieces.length !== 3 || pieces[0] !== UPLOAD_TOKEN_VERSION) return undefined;
    const expected = Buffer.from(this.sign(pieces[1]), 'utf-8');
    const provided = Buffer.from(pieces[2], 'utf-8');
    if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(pieces[1], 'base64url').toString('utf-8'));
    } catch {
      return undefined;
    }
    const token = parsed as Partial<UploadToken> | null;
    if (
      !token ||
      typeof token.u !== 'string' ||
      typeof token.k !== 'string' ||
      typeof token.f !== 'string' ||
      typeof token.m !== 'string' ||
      !isSafeCount(token.t) ||
      !isSafeCount(token.p) ||
      !isSafeCount(token.n) ||
      !isSafeCount(token.c) ||
      (token.o !== undefined && typeof token.o !== 'string')
    ) {
      return undefined;
    }
    if (Date.now() > token.c + REMOTE_UPLOAD_SESSION_TTL_MS) return undefined;
    return token as UploadToken;
  }

  private requireSession(uploadId: string): UploadToken {
    const token = this.decodeToken(uploadId);
    if (!token) {
      throw new Error(`Invalid or expired multipart upload session: ${uploadId}`);
    }
    return token;
  }

  getUploadSession(uploadId: string): UploadSessionInfo | undefined {
    const token = this.decodeToken(uploadId);
    if (!token) return undefined;
    return {
      uploadId,
      key: token.k,
      filename: token.f,
      mimeType: token.m,
      totalSize: token.t,
      partSize: token.p,
      totalParts: token.n,
      createdAt: token.c,
      ownerUserId: token.o,
    };
  }

  getUploadOwner(uploadId: string): string | undefined {
    return this.decodeToken(uploadId)?.o;
  }

  /** The parts the object store holds for an open session (ListParts), or undefined for an unknown session. */
  async getUploadedParts(uploadId: string): Promise<Array<{ partNumber: number; etag: string; size: number }> | undefined> {
    const session = this.decodeToken(uploadId);
    if (!session) return undefined;
    return this.client.listParts(session.k, session.u);
  }

  // ---------------------------------------------------------------------------------------------
  // Multipart uploads
  // ---------------------------------------------------------------------------------------------

  async initiateMultipartUpload(
    filename: string,
    mimeType: string,
    totalSize: number,
    ownerUserId?: string,
    partSize?: number
  ): Promise<MultipartUploadInit> {
    if (!Number.isSafeInteger(totalSize) || totalSize < 0) {
      throw new StorageInputError(`Invalid upload size: ${totalSize}`, this.providerName);
    }
    if (typeof filename !== 'string' || filename.length === 0) {
      throw new StorageInputError('An upload needs a filename', this.providerName);
    }
    if (typeof mimeType !== 'string' || !MIME_TYPE_PATTERN.test(mimeType)) {
      throw new StorageInputError('An upload needs a printable ASCII content type of at most 255 characters', this.providerName);
    }
    const resolvedPartSize = partSize && partSize > 0 ? Math.floor(partSize) : REMOTE_DEFAULT_PART_BYTES;
    const totalParts = Math.max(1, Math.ceil(totalSize / resolvedPartSize));
    if (totalParts > S3_MAX_PARTS) {
      throw new StorageInputError(
        `An upload of ${totalSize} bytes in ${resolvedPartSize}-byte parts needs ${totalParts} parts; the limit is ${S3_MAX_PARTS}.`,
        this.providerName
      );
    }
    if (resolvedPartSize > S3_MAX_PART_BYTES || (totalParts > 1 && resolvedPartSize < S3_MIN_PART_BYTES)) {
      throw new StorageInputError(
        `Part size ${resolvedPartSize} must be between ${S3_MIN_PART_BYTES} and ${S3_MAX_PART_BYTES} bytes for a multi-part upload.`,
        this.providerName
      );
    }

    const now = Date.now();
    const safeName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, MAX_FILENAME_KEY_LENGTH);
    const unique = `${now}_${crypto.randomBytes(8).toString('hex')}`;
    const key = ownerUserId
      ? `conversions/${ownerUserId}/${unique}_${safeName}`
      : `uploads/${unique}_${safeName}`;

    const rawUploadId = await this.client.createMultipartUpload(
      key,
      buildPutOptions(
        this.providerName,
        key,
        // The object's expiry is fixed when the upload opens: the longest open session plus a day of use.
        { contentType: mimeType, filename, ttlSeconds: (2 * REMOTE_UPLOAD_SESSION_TTL_MS) / MS_PER_SECOND },
        now
      )
    );
    const uploadId = this.encodeToken({
      u: rawUploadId,
      k: key,
      f: limitFilename(filename, this.providerName),
      m: mimeType,
      t: totalSize,
      p: resolvedPartSize,
      n: totalParts,
      o: ownerUserId,
      c: now,
    });
    return { uploadId, key, partSize: resolvedPartSize, totalParts, expiresAt: now + REMOTE_UPLOAD_SESSION_TTL_MS };
  }

  async uploadPart(uploadId: string, partNumber: number, buffer: Buffer): Promise<UploadedPart> {
    const session = this.requireSession(uploadId);
    const { etag } = await this.client.uploadPart(session.k, session.u, partNumber, buffer);
    return { partNumber, etag, size: buffer.length };
  }

  /** Buffers one request-body part (S3 needs its length up front), bounded by the part and session limits. */
  async uploadPartStream(
    uploadId: string,
    partNumber: number,
    stream: NodeJS.ReadableStream | ReadableStream<Uint8Array>,
    maxPartBytes?: number,
    maxTotalBytes?: number,
    currentSessionBytes: number = 0
  ): Promise<UploadedPart> {
    this.requireSession(uploadId);
    const limit = Math.min(maxPartBytes ?? REMOTE_STREAMED_PART_MAX_BYTES, S3_MAX_PART_BYTES);
    const source = toNodeReadable(stream);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of source) {
      const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += piece.length;
      if (total > limit) {
        source.destroy();
        throw statusError(`Part size exceeds maximum allowed part size of ${limit} bytes.`, HTTP_PAYLOAD_TOO_LARGE);
      }
      if (maxTotalBytes !== undefined && currentSessionBytes + total > maxTotalBytes) {
        source.destroy();
        throw statusError(`Total upload size exceeds maximum allowed size of ${maxTotalBytes} bytes.`, HTTP_PAYLOAD_TOO_LARGE);
      }
      chunks.push(piece);
    }
    if (total === 0) {
      throw statusError('Chunk payload is empty (0 bytes).', HTTP_BAD_REQUEST);
    }
    return this.uploadPart(uploadId, partNumber, Buffer.concat(chunks, total));
  }

  async completeMultipartUpload(
    uploadId: string,
    expectedParts?: { partNumber: number; etag?: string }[]
  ): Promise<MultipartUploadComplete> {
    const session = this.requireSession(uploadId);
    const listed = await this.client.listParts(session.k, session.u);
    if (listed.length === 0) {
      throw new Error(`Cannot complete empty multipart upload session: ${uploadId}`);
    }
    const byNumber = new Map(listed.map((part) => [part.partNumber, part]));

    let selected = [...listed].sort((a, b) => a.partNumber - b.partNumber);
    if (expectedParts !== undefined) {
      if (!Array.isArray(expectedParts) || expectedParts.length === 0) {
        throw new Error(`Cannot complete multipart upload with zero parts: ${uploadId}`);
      }
      const seen = new Set<number>();
      selected = [];
      for (const expected of expectedParts) {
        const number = expected?.partNumber;
        if (!Number.isInteger(number) || number < 1 || number > S3_MAX_PARTS) {
          throw new Error(`Invalid part number ${number} in expected parts list.`);
        }
        if (seen.has(number)) {
          throw new Error(`Part number ${number} is listed twice.`);
        }
        seen.add(number);
        const part = byNumber.get(number);
        if (!part) {
          throw new Error(`Missing part number ${number} in multipart upload session: ${uploadId}`);
        }
        if (expected.etag && stripEtagQuotes(expected.etag) !== stripEtagQuotes(part.etag)) {
          throw new Error(`ETag mismatch for part number ${number}: expected ${expected.etag}, got ${part.etag}`);
        }
        selected.push(part);
      }
      selected.sort((a, b) => a.partNumber - b.partNumber);
    }

    const { etag } = await this.client.completeMultipartUpload(
      session.k,
      session.u,
      selected.map((part) => ({ partNumber: part.partNumber, etag: part.etag }))
    );
    const size = selected.reduce((sum, part) => sum + part.size, 0);
    return {
      location: `/api/storage/file/${encodeURIComponent(session.k)}`,
      key: session.k,
      size,
      etag: `"${etag}"`,
    };
  }

  async abortMultipartUpload(uploadId: string): Promise<boolean> {
    const session = this.decodeToken(uploadId);
    if (!session) return false;
    await this.client.abortMultipartUpload(session.k, session.u);
    return true;
  }

  // ---------------------------------------------------------------------------------------------
  // Objects
  // ---------------------------------------------------------------------------------------------

  private toStoredObject(
    head: ObjectHead,
    content: { buffer?: Buffer; filePath?: string; staged?: boolean }
  ): StoredObject {
    const attrs = toStoredObjectMetadata(head, Date.now());
    const limit = getMaxInMemoryBytes();
    const { filePath } = content;
    let cached: Buffer | undefined = content.buffer;
    const stagedPath = content.staged ? filePath : undefined;
    const stored: StoredObject = {
      key: attrs.key,
      filename: attrs.filename,
      mimeType: attrs.mimeType,
      size: attrs.size,
      etag: attrs.etag,
      uploadedAt: attrs.uploadedAt,
      expiresAt: attrs.expiresAt,
      metadata: attrs.metadata,
      filePath,
      release: stagedPath
        ? async () => {
            await fs.promises.rm(stagedPath, { force: true });
          }
        : undefined,
      get buffer(): Buffer {
        if (cached) return cached;
        if (attrs.size > limit) {
          throw new PayloadTooLargeForMemoryError(undefined, { size: attrs.size, limit });
        }
        if (filePath) {
          cached = fs.readFileSync(filePath);
          return cached;
        }
        throw new StorageAdapterError(
          'The stored object content is not held in memory; read it with getObject.',
          'remote-storage'
        );
      },
    };
    return stored;
  }

  async saveObject(
    key: string,
    buffer: Buffer,
    mimeType: string,
    filename: string,
    ttlMs: number = REMOTE_DEFAULT_OBJECT_TTL_MS
  ): Promise<StoredObject> {
    const now = Date.now();
    const options = buildPutOptions(
      this.providerName,
      key,
      { contentType: mimeType, filename, ttlSeconds: Math.ceil(ttlMs / MS_PER_SECOND) },
      now
    );
    const result = await this.client.putBuffer(key, buffer, options);
    return this.toStoredObject(
      { key, size: result.size, etag: result.etag, contentType: mimeType, lastModified: new Date(now), metadata: options.metadata ?? {} },
      { buffer }
    );
  }

  async saveObjectFromFile(
    key: string,
    filePath: string,
    mimeType: string,
    filename: string,
    ttlMs: number = REMOTE_DEFAULT_OBJECT_TTL_MS
  ): Promise<StoredObject> {
    const { size } = await fs.promises.stat(filePath);
    return this.saveObjectFromStream(key, fs.createReadStream(filePath), { filename, mimeType, size }, ttlMs);
  }

  async saveObjectFromStream(
    key: string,
    stream: NodeJS.ReadableStream,
    meta: { filename: string; mimeType: string; size?: number },
    ttlMs: number = REMOTE_DEFAULT_OBJECT_TTL_MS
  ): Promise<StoredObject> {
    const now = Date.now();
    const options = buildPutOptions(
      this.providerName,
      key,
      { contentType: meta.mimeType, filename: meta.filename, ttlSeconds: Math.ceil(ttlMs / MS_PER_SECOND) },
      now
    );
    const result = await this.client.putStream(key, stream, { ...options, size: meta.size });
    return this.toStoredObject(
      { key, size: result.size, etag: result.etag, contentType: meta.mimeType, lastModified: new Date(now), metadata: options.metadata ?? {} },
      {}
    );
  }

  /** Metadata of a live (not expired) object, or undefined. */
  private async liveHead(key: string): Promise<ObjectHead | undefined> {
    let head: ObjectHead | null;
    try {
      head = await this.client.headObject(key);
    } catch (err) {
      // A key the store cannot address (for example one with ".." segments) names no object.
      if (err instanceof StorageInvalidKeyError) return undefined;
      throw err;
    }
    if (!head) return undefined;
    if (isObjectExpired(head, Date.now())) {
      await this.client.deleteObject(key).catch(() => undefined);
      return undefined;
    }
    return head;
  }

  async getObject(key: string): Promise<StoredObject | undefined> {
    const head = await this.liveHead(key);
    if (!head) return undefined;

    if (head.size <= REMOTE_INLINE_OBJECT_MAX_BYTES) {
      const got = await this.client.getObject(key);
      if (!got) return undefined;
      const chunks: Buffer[] = [];
      for await (const chunk of got.stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return this.toStoredObject(head, { buffer: Buffer.concat(chunks) });
    }
    return this.toStoredObject(head, { filePath: await this.stageToScratch(key, head.size), staged: true });
  }

  /** Downloads an object to a private scratch file so engines can read it by path. */
  private async stageToScratch(key: string, size: number): Promise<string> {
    if (size > REMOTE_STAGED_OBJECT_MAX_BYTES) {
      throw new StorageAdapterError(
        `Object of ${size} bytes exceeds the ${REMOTE_STAGED_OBJECT_MAX_BYTES} byte staging limit`,
        this.providerName
      );
    }
    await fs.promises.mkdir(this.scratchDir, { recursive: true, mode: STAGED_DIR_MODE });
    await this.sweepStaleScratch();
    const got = await this.client.getObject(key);
    if (!got) {
      throw new StorageAdapterError(`Object "${key}" disappeared while it was being staged`, this.providerName);
    }
    const target = path.join(this.scratchDir, `${crypto.randomUUID()}${STAGED_FILE_SUFFIX}`);
    try {
      await pipeline(got.stream, fs.createWriteStream(target, { mode: STAGED_FILE_MODE }));
      const written = (await fs.promises.stat(target)).size;
      if (written !== size) {
        throw new StorageAdapterError(
          `Staged ${written} bytes of "${key}" but the object has ${size} bytes`,
          this.providerName
        );
      }
    } catch (err) {
      await fs.promises.rm(target, { force: true }).catch(() => undefined);
      throw err;
    }
    return target;
  }

  /** Removes staged files that outlived any plausible job. */
  private async sweepStaleScratch(): Promise<void> {
    const cutoff = Date.now() - REMOTE_STAGED_FILE_MAX_AGE_MS;
    let entries: string[];
    try {
      entries = await fs.promises.readdir(this.scratchDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.endsWith(STAGED_FILE_SUFFIX)) continue;
      const file = path.join(this.scratchDir, entry);
      try {
        const stat = await fs.promises.stat(file);
        if (stat.mtimeMs < cutoff) await fs.promises.rm(file, { force: true });
      } catch {
        // Already gone or unreadable: nothing to sweep.
      }
    }
  }

  async stat(key: string): Promise<ObjectStat | null> {
    const head = await this.liveHead(key);
    if (!head) return null;
    const attrs = toStoredObjectMetadata(head, Date.now());
    return { size: attrs.size, etag: attrs.etag, mimeType: attrs.mimeType, filename: attrs.filename };
  }

  async openReadStream(key: string, range?: { start: number; end: number }): Promise<NodeJS.ReadableStream | null> {
    let got: Awaited<ReturnType<S3ObjectClient['getObject']>>;
    try {
      got = await this.client.getObject(key, range);
    } catch (err) {
      if (err instanceof StorageInvalidKeyError) return null;
      throw err;
    }
    if (!got) return null;
    if (isObjectExpired(got, Date.now())) {
      got.stream.destroy();
      await this.client.deleteObject(key).catch(() => undefined);
      return null;
    }
    return got.stream;
  }

  getObjectStream(key: string, range?: { start: number; end: number }): Promise<NodeJS.ReadableStream | null> {
    return this.openReadStream(key, range);
  }

  async deleteObject(key: string): Promise<boolean> {
    return this.client.deleteObject(key);
  }

  /** Deletes every object under a non-empty prefix, at most REMOTE_DELETE_BY_PREFIX_MAX_OBJECTS of them. */
  async deleteByPrefix(prefix: string): Promise<number> {
    if (!prefix) {
      throw new StorageAdapterError('deleteByPrefix needs a non-empty prefix', this.providerName);
    }
    let deleted = 0;
    let batch: string[] = [];
    const flush = async (): Promise<void> => {
      const results = await Promise.all(batch.map((key) => this.client.deleteObject(key)));
      deleted += results.filter(Boolean).length;
      batch = [];
    };
    for await (const object of this.client.listAll(prefix, REMOTE_DELETE_BY_PREFIX_MAX_OBJECTS)) {
      batch.push(object.key);
      if (batch.length >= DELETE_CONCURRENCY) await flush();
    }
    await flush();
    return deleted;
  }

  /** Sessions and objects live on the object store; counting them would need a full listing. */
  getActiveSessionsCount(): null {
    return null;
  }

  getObjectsCount(): null {
    return null;
  }

  // ---------------------------------------------------------------------------------------------
  // Presigned URLs
  // ---------------------------------------------------------------------------------------------

  generatePresignedUploadPartUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds: number = DEFAULT_PRESIGN_PART_SECONDS
  ): PresignedUrlResult {
    const session = this.requireSession(uploadId);
    if (session.k !== key) {
      throw new Error('Key does not belong to this multipart upload session.');
    }
    const presigned = this.client.presignUploadPartUrl(session.k, session.u, partNumber, expiresInSeconds);
    return { url: presigned.url, expiresAt: presigned.expiresAt, signature: presigned.signature };
  }

  generatePresignedUploadUrl(
    key: string,
    partNumber: number,
    uploadId: string,
    expiresInSeconds: number = DEFAULT_PRESIGN_SECONDS
  ): PresignedUrlResult {
    return this.generatePresignedUploadPartUrl(key, uploadId, partNumber, expiresInSeconds);
  }

  generatePresignedDownloadUrl(
    key: string,
    expiresInSeconds: number = DEFAULT_PRESIGN_SECONDS
  ): PresignedUrlResult {
    const presigned = this.client.presignGetUrl(key, expiresInSeconds);
    return { url: presigned.url, expiresAt: presigned.expiresAt, signature: presigned.signature };
  }
}
