import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  MultipartUploadInit,
  UploadedPart,
  MultipartUploadComplete,
} from '../types';
import {
  IStorageBackend,
  StoredObject,
  PresignedUrlResult,
  ObjectStat,
  UploadSessionInfo,
} from './oci-storage';
import { StorageServiceError } from './adapters/adapter-interface';
import { StorageSigningSecretMissingError } from './errors';
import { lazySingleton } from './lazy-singleton';
import {
  LOCAL_DIRECT_PART_PATH,
  LOCAL_EMULATION_ACCESS_KEY_ID,
  LOCAL_EMULATION_REGION,
  isProductionRuntime,
  resolveAppBaseUrl,
  resolveSigningSecret,
} from './storage-config';
import { presignSigV4QueryUrl, verifySigV4QueryUrl } from './sigv4-presigner';
import { multipartUploadKey } from './key-namespace';
import { LocalFsStorage, localFsStorage, type LocalMultipartSession, type StoredPart } from './local-fs-storage';
import { extendStoredExpiry, fileBackedObject, globalSharedObjects, type SavedVersion } from './shared-store';
import { sweepStaleJobDirectories } from './temp-file';

export * from './oci-storage';

const DEFAULT_OBJECT_TTL_MS = 24 * 60 * 60 * 1000;
const UPLOAD_KEY_RANDOM_BYTES = 8;
const HTTP_PAYLOAD_TOO_LARGE = 413;

function invalidSession(uploadId: string): Error {
  return new Error(`Invalid or expired multipart upload session: ${uploadId}`);
}

function sessionInfo(session: LocalMultipartSession): UploadSessionInfo {
  const totalSize = session.totalSize ?? 0;
  return {
    uploadId: session.uploadId,
    key: session.key,
    filename: session.metadata?.filename ?? path.basename(session.key),
    mimeType: session.metadata?.contentType ?? 'application/octet-stream',
    totalSize,
    partSize: session.partSize,
    totalParts: Math.max(1, Math.ceil(totalSize / session.partSize)),
    createdAt: session.createdAt,
    ownerUserId: session.ownerUserId,
  };
}

/** The parts to complete from: the listed ones, which must be stored with the ETag they list, else every stored part in order. */
function partsToComplete(uploadId: string, stored: readonly StoredPart[], expectedParts?: { partNumber: number; etag?: string }[]): StoredPart[] {
  if (expectedParts === undefined) {
    if (stored.length === 0) throw new Error(`Cannot complete empty multipart upload session: ${uploadId}`);
    return [...stored].sort((a, b) => a.partNumber - b.partNumber);
  }
  if (!Array.isArray(expectedParts) || expectedParts.length === 0) {
    throw new Error(`Cannot complete multipart upload with zero parts: ${uploadId}`);
  }
  const byNumber = new Map(stored.map((part) => [part.partNumber, part] as const));
  return expectedParts
    .map((listed) => {
      const part = byNumber.get(listed?.partNumber);
      if (!part) throw new Error(`Missing part number ${listed?.partNumber} in multipart upload session: ${uploadId}`);
      if (listed.etag && listed.etag !== part.etag) {
        throw new Error(`ETag mismatch for part number ${listed.partNumber}: expected ${listed.etag}, got ${part.etag}`);
      }
      return part;
    })
    .sort((a, b) => a.partNumber - b.partNumber);
}

/**
 * Job storage of the local driver: objects in the storage directory that the web process and the workers share
 * (`SharedObjectStore`), and uploads in parts through `LocalFsStorage`, whose sessions live on that disk beside their
 * parts and so survive a restart of the web process. Signed part URLs are verified with the signing secret.
 */
export class S3ObjectStorageService implements IStorageBackend {
  readonly providerName: string = 's3';
  readonly kind = 'local' as const;
  private readonly objects = new Map<string, StoredObject>();
  private gcTimer: NodeJS.Timeout | null = null;
  private readonly configuredSigningSecret: string | undefined;
  private readonly multipart: LocalFsStorage;

  readonly DEFAULT_PART_SIZE = 5 * 1024 * 1024; // 5 MB S3 minimum part size

  constructor(options?: { signingSecret?: string; multipart?: LocalFsStorage }) {
    const secret = options?.signingSecret || resolveSigningSecret();
    if (!secret && isProductionRuntime()) {
      throw new Error('Missing required STORAGE_SIGNING_SECRET environment variable in production');
    }
    this.configuredSigningSecret = secret;
    this.multipart = options?.multipart ?? localFsStorage;

    this.gcTimer = setInterval(() => {
      this.sweepExpiredObjects();
      void this.sweepLeftovers();
    }, 60000);
    if (this.gcTimer && typeof this.gcTimer.unref === 'function') {
      this.gcTimer.unref();
    }
  }

  stopGc(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
  }

  async initiateMultipartUpload(
    filename: string,
    mimeType: string,
    totalSize: number,
    ownerUserId?: string,
    partSize?: number
  ): Promise<MultipartUploadInit> {
    const sanitizedFilename = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    const unique = `${Date.now()}_${crypto.randomBytes(UPLOAD_KEY_RANDOM_BYTES).toString('hex')}`;
    const key = multipartUploadKey(ownerUserId, `${unique}_${sanitizedFilename}`);
    const resolvedPartSize = partSize && partSize > 0 ? partSize : this.DEFAULT_PART_SIZE;
    const session = await this.multipart.createMultipart(
      key,
      { filename, contentType: mimeType },
      { ownerUserId, totalSize, partSize: resolvedPartSize }
    );
    return {
      uploadId: session.uploadId,
      key,
      partSize: resolvedPartSize,
      totalParts: Math.max(1, Math.ceil(totalSize / resolvedPartSize)),
      expiresAt: session.expiresAt,
    };
  }

  async getUploadSession(uploadId: string): Promise<UploadSessionInfo | undefined> {
    const session = await this.multipart.getMultipartSession(uploadId);
    return session ? sessionInfo(session) : undefined;
  }

  async getUploadOwner(uploadId: string): Promise<string | undefined> {
    return (await this.multipart.getMultipartSession(uploadId))?.ownerUserId;
  }

  async getUploadedParts(uploadId: string): Promise<StoredPart[] | undefined> {
    return this.multipart.listPartSizes(uploadId);
  }

  async uploadPart(uploadId: string, partNumber: number, buffer: Buffer): Promise<UploadedPart> {
    return this.uploadPartStream(uploadId, partNumber, Readable.from([buffer]));
  }

  /** Stores one part; a part over what the session has room for fails with `statusCode` 413, as part admission answers. */
  async uploadPartStream(
    uploadId: string,
    partNumber: number,
    stream: NodeJS.ReadableStream | ReadableStream<Uint8Array>,
    maxPartBytes?: number
  ): Promise<UploadedPart> {
    if (!(await this.multipart.getMultipartSession(uploadId))) throw invalidSession(uploadId);
    try {
      return await this.multipart.savePartStream(uploadId, partNumber, stream, maxPartBytes);
    } catch (error) {
      if (error instanceof StorageServiceError && error.code === 'EntityTooLarge') {
        throw Object.assign(new Error(error.message), { statusCode: HTTP_PAYLOAD_TOO_LARGE });
      }
      throw error;
    }
  }

  async completeMultipartUpload(
    uploadId: string,
    expectedParts?: { partNumber: number; etag?: string }[]
  ): Promise<MultipartUploadComplete> {
    const session = await this.multipart.getMultipartSession(uploadId);
    if (!session) throw invalidSession(uploadId);
    const parts = partsToComplete(uploadId, (await this.multipart.listPartSizes(uploadId)) ?? [], expectedParts);
    const stored = await this.multipart.assembleMultipart(uploadId, parts, Date.now() + DEFAULT_OBJECT_TTL_MS);
    return {
      location: `/api/storage/file/${encodeURIComponent(stored.key)}`,
      key: stored.key,
      size: stored.size,
      etag: stored.etag,
    };
  }

  async abortMultipartUpload(uploadId: string): Promise<boolean> {
    const session = await this.multipart.getMultipartSession(uploadId);
    return session ? this.multipart.abortMultipart(session.key, uploadId) : false;
  }

  saveObject(
    key: string,
    buffer: Buffer,
    mimeType: string,
    filename: string,
    ttlMs: number = DEFAULT_OBJECT_TTL_MS
  ): StoredObject {
    const etag = `"${crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32)}"`;
    const obj: StoredObject = {
      key,
      filename,
      mimeType,
      buffer,
      size: buffer.length,
      etag,
      uploadedAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
    };
    this.objects.set(key, obj);
    globalSharedObjects.set(key, obj);
    return obj;
  }

  /**
   * Moves the regular file into the storage directory (a rename, or a copy across volumes) and stores it there for every
   * process. A `signal` that aborts before the file is renamed into place stores nothing (see `commitObjectFile`).
   */
  async saveObjectFromFile(
    key: string,
    filePath: string,
    mimeType: string,
    filename: string,
    ttlMs: number = DEFAULT_OBJECT_TTL_MS,
    signal?: AbortSignal
  ): Promise<StoredObject> {
    const stat = await fs.promises.lstat(filePath);
    const now = Date.now();
    const obj = await globalSharedObjects.storeFile(key, filePath, {
      key,
      filename,
      mimeType,
      size: stat.size,
      etag: `"${crypto.createHash('sha256').update(`${globalSharedObjects.objectPath(key)}${stat.mtimeMs}${stat.size}`).digest('hex').slice(0, 32)}"`,
      uploadedAt: now,
      expiresAt: now + ttlMs,
    }, signal);
    this.objects.set(key, obj);
    return obj;
  }

  /** Removes the object under `key` while it is still the save `written` describes (see `SharedObjectStore.deleteIfStoredBy`). */
  deleteObjectIfUnchanged(key: string, written: SavedVersion): boolean {
    const own = this.objects.get(key);
    if (own?.etag === written.etag && own.uploadedAt === written.uploadedAt) this.objects.delete(key);
    return globalSharedObjects.deleteIfStoredBy(key, written);
  }

  stat(key: string): ObjectStat | null {
    const obj = this.getObject(key);
    if (!obj) return null;
    return {
      size: obj.size,
      etag: obj.etag,
      mimeType: obj.mimeType,
      filename: obj.filename,
      filePath: obj.filePath,
    };
  }

  openReadStream(key: string, range?: { start: number; end: number }): fs.ReadStream | null {
    return this.getObjectStream(key, range);
  }

  getObject(key: string): StoredObject | undefined {
    return this.objects.get(key) || globalSharedObjects.get(key);
  }

  deleteObject(key: string): boolean {
    const shared = globalSharedObjects.delete(key);
    const obj = this.objects.get(key);
    if (obj?.filePath && fs.existsSync(obj.filePath)) {
      try {
        fs.rmSync(obj.filePath, { force: true });
      } catch {}
    }
    const own = this.objects.delete(key);
    return own || shared;
  }

  deleteByPrefix(prefix: string): number {
    let count = 0;
    for (const key of Array.from(this.objects.keys())) {
      if (key.startsWith(prefix)) {
        if (this.deleteObject(key)) {
          count++;
        }
      }
    }
    for (const key of Array.from(globalSharedObjects.keys())) {
      if (key.startsWith(prefix)) {
        if (this.deleteObject(key)) {
          count++;
        }
      }
    }
    return count;
  }

  getObjectStream(key: string, range?: { start: number; end: number }): fs.ReadStream | null {
    const obj = this.getObject(key);
    if (!obj) return null;
    const streamOpts: { start?: number; end?: number; highWaterMark: number } = {
      highWaterMark: 64 * 1024,
    };
    if (range) {
      if (typeof range.start === 'number') streamOpts.start = range.start;
      if (typeof range.end === 'number') streamOpts.end = range.end;
    }
    if (obj.filePath && fs.existsSync(obj.filePath)) {
      return fs.createReadStream(obj.filePath, streamOpts);
    }
    return globalSharedObjects.getStream(key, range);
  }

  async saveObjectFromStream(
    key: string,
    stream: NodeJS.ReadableStream,
    meta: { filename: string; mimeType: string; size?: number },
    ttlMs: number = DEFAULT_OBJECT_TTL_MS
  ): Promise<StoredObject> {
    const record = await this.multipart.putStream(key, stream, { filename: meta.filename, contentType: meta.mimeType, ttlSeconds: ttlMs / 1000 });
    const stored = fileBackedObject(record, globalSharedObjects.objectPath(key));
    this.objects.set(key, stored);
    return stored;
  }

  getActiveSessionsCount(): number {
    return this.multipart.countOpenSessions();
  }

  getObjectsCount(): number {
    return this.objects.size;
  }

  /** The configured signing secret; signing without one is refused rather than done with an invented secret. */
  getSigningSecret(): string {
    if (!this.configuredSigningSecret) {
      throw new StorageSigningSecretMissingError();
    }
    return this.configuredSigningSecret;
  }

  private get signingSecret(): string {
    return this.getSigningSecret();
  }

  generatePresignedUploadUrl(
    key: string,
    partNumber: number,
    uploadId: string,
    expiresInSeconds: number = 900
  ): PresignedUrlResult {
    return this.generatePresignedUploadPartUrl(key, uploadId, partNumber, expiresInSeconds);
  }

  /**
   * URL on this application that accepts one part of a local multipart session (the
   * `/api/v1/uploads/direct/part` route verifies it with the signing secret). Local storage has no
   * object-store endpoint, so it cannot mint S3 URLs.
   */
  generatePresignedUploadPartUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds: number = 900
  ): PresignedUrlResult {
    const res = presignSigV4QueryUrl({
      method: 'PUT',
      url: `${resolveAppBaseUrl()}${LOCAL_DIRECT_PART_PATH}`,
      queryParams: { uploadId, partNumber, key },
      credentials: {
        accessKeyId: LOCAL_EMULATION_ACCESS_KEY_ID,
        secretAccessKey: this.signingSecret,
        region: LOCAL_EMULATION_REGION,
        service: 's3',
      },
      expiresInSeconds,
    });

    return {
      url: res.url,
      expiresAt: res.expiresAt,
      signature: res.signature,
    };
  }

  generatePresignedHmacPartUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds: number = 900
  ): PresignedUrlResult {
    const expiresAt = Date.now() + expiresInSeconds * 1000;
    const stringToSign = `PUT\n${key}\n${uploadId}\n${partNumber}\n${expiresAt}`;
    const signature = crypto
      .createHmac('sha256', this.signingSecret)
      .update(stringToSign)
      .digest('hex');

    const baseUrl = `${resolveAppBaseUrl()}${LOCAL_DIRECT_PART_PATH}`;
    const url = `${baseUrl}?uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}&key=${encodeURIComponent(key)}&expiresAt=${expiresAt}&signature=${signature}`;

    return {
      url,
      expiresAt,
      signature,
    };
  }

  verifyPresignedSignature(
    method: 'GET' | 'PUT',
    key: string,
    expiresAt: number,
    signature: string,
    uploadId?: string,
    partNumber?: number
  ): boolean {
    if (Date.now() > expiresAt) {
      return false;
    }

    const stringToSign =
      method === 'PUT'
        ? `PUT\n${key}\n${uploadId || ''}\n${partNumber ?? ''}\n${expiresAt}`
        : `GET\n${key}\n${expiresAt}`;

    const expectedSig = crypto
      .createHmac('sha256', this.signingSecret)
      .update(stringToSign)
      .digest('hex');

    try {
      const sigBuf = Buffer.from(signature, 'hex');
      const expectedBuf = Buffer.from(expectedSig, 'hex');
      return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
    } catch {
      return false;
    }
  }

  verifySigV4Url(urlStr: string, method: string = 'PUT'): ReturnType<typeof verifySigV4QueryUrl> {
    return verifySigV4QueryUrl(urlStr, {
      secretAccessKey: this.signingSecret,
      expectedMethod: method,
    });
  }

  extendExpiry(key: string, expiresAt: number): boolean {
    return extendStoredExpiry(this.objects, key, expiresAt);
  }

  sweepExpiredObjects(now: number = Date.now()): number {
    let swept = 0;
    for (const [key, obj] of this.objects.entries()) {
      if (obj.expiresAt <= now && globalSharedObjects.renewedExpiry(obj) <= now) {
        if (obj.filePath && fs.existsSync(obj.filePath)) {
          try {
            fs.rmSync(obj.filePath, { force: true });
          } catch {}
        }
        this.objects.delete(key);
        swept++;
      }
    }

    return swept;
  }

  /** Removes what stopped processes left in the storage directory: temporary files, bytes without a record and job directories. */
  async sweepLeftovers(now: number = Date.now()): Promise<number> {
    const [tempFiles, jobDirectories] = await Promise.all([globalSharedObjects.sweepStaleTempFiles(now), sweepStaleJobDirectories(now)]);
    return tempFiles + jobDirectories;
  }
}

export const s3Storage: S3ObjectStorageService = lazySingleton(
  S3ObjectStorageService.prototype,
  () => new S3ObjectStorageService()
);
