import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type {
  ByteRange,
  CompletedPart,
  IObjectStorage,
  MultipartSession,
  ObjectMetadata,
  ObjectReadStream,
  StoragePresignedUrlResult,
  StoredObjectMetadata,
} from './object-storage';
import { StorageSigningSecretMissingError } from './errors';
import { StorageInputError, StorageServiceError } from './adapters/adapter-interface';
import { lazySingleton } from './lazy-singleton';
import { isProductionRuntime, resolveLocalStorageDir, resolveSigningSecret } from './storage-config';
import { resolveDeclaredFormat } from './declared-format';
import { assertNotSpoofedFilePath } from '../security/file-guard';

/** Part numbers run from 1 to 10,000 and one part holds at most 5 GiB, as in the S3 multipart limits. */
export const MULTIPART_MAX_PARTS = 10_000;
export const MULTIPART_MAX_PART_BYTES = 5 * 1024 * 1024 * 1024;
/** The most one multipart upload may hold in all, and the cap of a session that declared no size. */
export const MULTIPART_MAX_TOTAL_BYTES = 10 * 1024 * 1024 * 1024;

const PROVIDER_NAME = 'local-fs';
const UPLOAD_ID_RANDOM_BYTES = 12;
/** Exactly the ids createMultipart generates: `up_<epoch ms>_<24 hex digits>`. */
const UPLOAD_ID_PATTERN = /^up_\d{1,15}_[0-9a-f]{24}$/;
const PART_FILE_PATTERN = /^part-(\d+)\.bin$/;
const SESSION_FILE = 'session.json';

export interface LocalFsStorageOptions {
  storageDir?: string;
  signingSecret?: string;
  defaultTtlSeconds?: number;
}

interface StoredMetaFile {
  key: string;
  filename: string;
  mimeType: string;
  size: number;
  etag: string;
  uploadedAt: number;
  expiresAt: number;
  metadata?: Record<string, string>;
}

/** Who started a multipart upload and the size they declared for it. */
export interface DeclaredMultipartUpload {
  ownerUserId: string;
  totalSize: number;
}

export interface LocalMultipartSession extends MultipartSession, Partial<DeclaredMultipartUpload> {}

function isLocalUploadId(value: unknown): value is string {
  return typeof value === 'string' && UPLOAD_ID_PATTERN.test(value);
}

/** The bytes one part may hold: the S3 part maximum, within what the declared total leaves after the other parts. */
export function multipartPartByteLimit(declaredTotalBytes: number, otherPartsBytes: number): number {
  return Math.max(0, Math.min(MULTIPART_MAX_PART_BYTES, declaredTotalBytes - otherPartsBytes));
}

function noSuchUpload(): StorageServiceError {
  return new StorageServiceError('Multipart upload session not found or expired', PROVIDER_NAME, {
    statusCode: 404,
    code: 'NoSuchUpload',
    retryable: false,
  });
}

function partTooLarge(limit: number): StorageServiceError {
  return new StorageServiceError(`Part exceeds the ${limit} bytes this upload has left`, PROVIDER_NAME, {
    statusCode: 400,
    code: 'EntityTooLarge',
    retryable: false,
  });
}

function assertPartNumber(partNumber: number): void {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MULTIPART_MAX_PARTS) {
    throw new StorageInputError(`Invalid part number ${partNumber}: it must be an integer from 1 to ${MULTIPART_MAX_PARTS}`, PROVIDER_NAME);
  }
}

/**
 * High-Performance Local Filesystem Object Storage Provider.
 * Zero-copy streaming directly to/from disk with zero permanent heap retention.
 */
export class LocalFsStorage implements IObjectStorage {
  readonly providerName: string = 'local-fs';

  private readonly storageDir: string;
  private readonly partsDir: string;
  private readonly configuredSigningSecret: string | undefined;
  private readonly defaultTtlSeconds: number;
  private gcTimer: NodeJS.Timeout | null = null;

  constructor(options?: LocalFsStorageOptions) {
    this.storageDir = options?.storageDir || resolveLocalStorageDir();
    this.partsDir = path.join(this.storageDir, '.parts');
    this.defaultTtlSeconds = options?.defaultTtlSeconds || 3600;

    const secret = options?.signingSecret || resolveSigningSecret();
    if (!secret && isProductionRuntime()) {
      throw new Error('Missing required STORAGE_SIGNING_SECRET environment variable in production');
    }
    this.configuredSigningSecret = secret;

    this.ensureDirectories();

    this.gcTimer = setInterval(() => {
      this.sweepExpiredObjects();
    }, 60000);
    if (this.gcTimer && typeof this.gcTimer.unref === 'function') {
      this.gcTimer.unref();
    }
  }

  /** The configured signing secret; signing without one is refused rather than done with an invented secret. */
  private get signingSecret(): string {
    if (!this.configuredSigningSecret) {
      throw new StorageSigningSecretMissingError();
    }
    return this.configuredSigningSecret;
  }

  public stopGc(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
  }

  private ensureDirectories(): void {
    try {
      if (!fs.existsSync(this.storageDir)) {
        fs.mkdirSync(this.storageDir, { recursive: true });
      }
      if (!fs.existsSync(this.partsDir)) {
        fs.mkdirSync(this.partsDir, { recursive: true });
      }
    } catch {
      // Graceful fallback for read-only or restricted environments
    }
  }

  public getPathsForKey(key: string): { metaPath: string; binPath: string } {
    const hash = crypto.createHash('sha256').update(key).digest('hex');
    return {
      metaPath: path.join(this.storageDir, `${hash}.meta.json`),
      binPath: path.join(this.storageDir, `${hash}.bin`),
    };
  }

  /** The directory of a session this store generated; any other id, or one that leaves the parts directory, is NoSuchUpload. */
  private sessionDirFor(uploadId: string): string {
    if (!isLocalUploadId(uploadId)) throw noSuchUpload();
    const partsRoot = path.resolve(this.partsDir);
    const sessionDir = path.resolve(partsRoot, uploadId);
    if (path.dirname(sessionDir) !== partsRoot) throw noSuchUpload();
    return sessionDir;
  }

  private async readSession(sessionDir: string): Promise<LocalMultipartSession | undefined> {
    try {
      return JSON.parse(await fs.promises.readFile(path.join(sessionDir, SESSION_FILE), 'utf-8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  /** The stored session of `uploadId`, or undefined when the id is not one this store generated or names no session. */
  async getMultipartSession(uploadId: unknown): Promise<LocalMultipartSession | undefined> {
    if (!isLocalUploadId(uploadId)) return undefined;
    return this.readSession(this.sessionDirFor(uploadId));
  }

  private async otherPartsBytes(sessionDir: string, partNumber: number): Promise<number> {
    const sizes = await Promise.all(
      (await fs.promises.readdir(sessionDir)).map(async (name) => {
        const match = PART_FILE_PATTERN.exec(name);
        if (!match || Number(match[1]) === partNumber) return 0;
        return (await fs.promises.stat(path.join(sessionDir, name))).size;
      })
    );
    return sizes.reduce((sum, size) => sum + size, 0);
  }

  private toNodeReadable(stream: NodeJS.ReadableStream | ReadableStream<Uint8Array>): NodeJS.ReadableStream {
    if (typeof (stream as any)[Symbol.asyncIterator] === 'function' && typeof (stream as any).pipe !== 'function') {
      return Readable.fromWeb(stream as any);
    }
    return stream as NodeJS.ReadableStream;
  }

  async putStream(
    key: string,
    stream: NodeJS.ReadableStream | ReadableStream<Uint8Array>,
    metadata?: ObjectMetadata
  ): Promise<StoredObjectMetadata> {
    this.ensureDirectories();
    const { metaPath, binPath } = this.getPathsForKey(key);
    const tempPath = `${binPath}.tmp.${Date.now()}.${crypto.randomBytes(6).toString('hex')}`;

    const nodeReadable = this.toNodeReadable(stream);
    const hasher = crypto.createHash('sha256');
    let totalBytes = 0;

    const passThrough = new (await import('node:stream')).PassThrough();
    passThrough.on('data', (chunk: Buffer) => {
      hasher.update(chunk);
      totalBytes += chunk.length;
    });

    const fileWriteStream = fs.createWriteStream(tempPath);

    try {
      await pipeline(nodeReadable, passThrough, fileWriteStream);
      const etag = `"${hasher.digest('hex')}"`;
      fs.renameSync(tempPath, binPath);

      const now = Date.now();
      const ttl = metadata?.ttlSeconds ?? this.defaultTtlSeconds;
      const expiresAt = now + ttl * 1000;
      const storedMeta: StoredObjectMetadata = {
        key,
        size: totalBytes,
        etag,
        mimeType: metadata?.contentType || 'application/octet-stream',
        filename: metadata?.filename || path.basename(key) || 'download.bin',
        uploadedAt: now,
        expiresAt,
        metadata: metadata?.customMetadata,
      };

      fs.writeFileSync(metaPath, JSON.stringify(storedMeta), 'utf-8');
      return storedMeta;
    } catch (error) {
      if (fs.existsSync(tempPath)) {
        try {
          fs.unlinkSync(tempPath);
        } catch {}
      }
      throw error;
    }
  }

  async putBuffer(
    key: string,
    buffer: Buffer,
    metadata?: ObjectMetadata
  ): Promise<StoredObjectMetadata> {
    const readable = Readable.from(buffer);
    return this.putStream(key, readable, metadata);
  }

  async getStream(key: string, range?: ByteRange): Promise<ObjectReadStream | null> {
    const meta = await this.head(key);
    if (!meta) return null;

    const { binPath } = this.getPathsForKey(key);
    if (!fs.existsSync(binPath)) return null;

    let stream: NodeJS.ReadableStream;
    if (range) {
      if (range.start < 0 || range.end >= meta.size || range.start > range.end) {
        throw new Error(`Invalid byte range: start=${range.start}, end=${range.end}, size=${meta.size}`);
      }
      stream = fs.createReadStream(binPath, { start: range.start, end: range.end });
    } else {
      stream = fs.createReadStream(binPath);
    }

    return {
      stream,
      metadata: meta,
      range,
    };
  }

  async getBuffer(key: string): Promise<Buffer | null> {
    const meta = await this.head(key);
    if (!meta) return null;

    const { binPath } = this.getPathsForKey(key);
    if (!fs.existsSync(binPath)) return null;

    return fs.promises.readFile(binPath);
  }

  async head(key: string): Promise<StoredObjectMetadata | null> {
    const { metaPath, binPath } = this.getPathsForKey(key);
    if (!fs.existsSync(metaPath)) return null;

    try {
      const raw = fs.readFileSync(metaPath, 'utf-8');
      const parsed: StoredMetaFile = JSON.parse(raw);
      if (parsed.expiresAt && Date.now() > parsed.expiresAt) {
        await this.delete(key);
        return null;
      }
      if (!fs.existsSync(binPath)) {
        await this.delete(key);
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<boolean> {
    const { metaPath, binPath } = this.getPathsForKey(key);
    let deleted = false;
    try {
      if (fs.existsSync(metaPath)) {
        fs.unlinkSync(metaPath);
        deleted = true;
      }
      if (fs.existsSync(binPath)) {
        fs.unlinkSync(binPath);
        deleted = true;
      }
    } catch {}
    return deleted;
  }

  async createMultipart(
    key: string,
    metadata?: ObjectMetadata,
    declared?: DeclaredMultipartUpload
  ): Promise<MultipartSession> {
    this.ensureDirectories();
    const uploadId = `up_${Date.now()}_${crypto.randomBytes(UPLOAD_ID_RANDOM_BYTES).toString('hex')}`;
    const sessionDir = this.sessionDirFor(uploadId);
    await fs.promises.mkdir(sessionDir, { recursive: true });

    const now = Date.now();
    const session: LocalMultipartSession = {
      uploadId,
      key,
      partSize: 5 * 1024 * 1024,
      createdAt: now,
      expiresAt: now + (metadata?.ttlSeconds ?? 86400) * 1000,
      metadata,
      ...declared,
    };

    await fs.promises.writeFile(path.join(sessionDir, SESSION_FILE), JSON.stringify(session), 'utf-8');
    return session;
  }

  async savePartStream(
    uploadId: string,
    partNumber: number,
    stream: NodeJS.ReadableStream | ReadableStream<Uint8Array>
  ): Promise<CompletedPart> {
    const sessionDir = this.sessionDirFor(uploadId);
    assertPartNumber(partNumber);
    const session = await this.readSession(sessionDir);
    if (!session) throw noSuchUpload();
    const limit = multipartPartByteLimit(
      session.totalSize ?? MULTIPART_MAX_TOTAL_BYTES,
      await this.otherPartsBytes(sessionDir, partNumber)
    );

    const partPath = path.join(sessionDir, `part-${partNumber}.bin`);
    const tempPartPath = `${partPath}.tmp.${Date.now()}`;
    const nodeReadable = this.toNodeReadable(stream);
    const hasher = crypto.createHash('sha256');
    let partSize = 0;
    let limitExceeded = false;

    const passThrough = new (await import('node:stream')).PassThrough();
    passThrough.on('data', (chunk: Buffer) => {
      partSize += chunk.length;
      if (partSize > limit) {
        limitExceeded = true;
        passThrough.destroy(partTooLarge(limit));
        return;
      }
      hasher.update(chunk);
    });

    const writeStream = fs.createWriteStream(tempPartPath);
    try {
      await pipeline(nodeReadable, passThrough, writeStream);
      fs.renameSync(tempPartPath, partPath);
      const etag = `"${hasher.digest('hex')}"`;
      return {
        partNumber,
        etag,
        size: partSize,
      };
    } catch (err) {
      if (fs.existsSync(tempPartPath)) {
        try {
          fs.unlinkSync(tempPartPath);
        } catch {}
      }
      throw limitExceeded ? partTooLarge(limit) : err;
    }
  }

  async presignPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds: number = 3600
  ): Promise<StoragePresignedUrlResult> {
    this.sessionDirFor(uploadId);
    assertPartNumber(partNumber);
    const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const stringToSign = `PUT\n${key}\n${uploadId}\n${partNumber}\n${expiresAt}`;
    const signature = crypto
      .createHmac('sha256', this.signingSecret)
      .update(stringToSign)
      .digest('hex');

    const url = `/api/storage/multipart?key=${encodeURIComponent(key)}&uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}&expiresAt=${expiresAt}&signature=${signature}`;
    return {
      url,
      expiresAt,
      signature,
      method: 'PUT',
    };
  }

  private validateContiguousParts(parts: CompletedPart[]): CompletedPart[] {
    if (!Array.isArray(parts) || parts.length === 0) {
      throw new Error('Multipart completion requires at least one part');
    }
    if (parts.length > MULTIPART_MAX_PARTS) {
      throw new StorageInputError(`Multipart completion takes at most ${MULTIPART_MAX_PARTS} parts`, PROVIDER_NAME);
    }

    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].partNumber !== i + 1) {
        throw new Error(
          `Multipart parts must be strictly contiguous and 1-indexed. Missing part ${i + 1}, found ${sorted[i].partNumber}`
        );
      }
    }
    return sorted;
  }

  private appendPartStream(
    partFile: string,
    writeCombined: fs.WriteStream,
    overallHasher: crypto.Hash
  ): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      let partBytes = 0;
      const readPart = fs.createReadStream(partFile);
      readPart.on('data', (chunk: Buffer | string) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        overallHasher.update(buf);
        partBytes += buf.length;
      });
      readPart.on('end', () => resolve(partBytes));
      readPart.on('error', reject);
      readPart.pipe(writeCombined, { end: false });
    });
  }

  async completeMultipart(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
    expectedSize?: number
  ): Promise<StoredObjectMetadata> {
    const sessionDir = this.sessionDirFor(uploadId);
    const session = await this.readSession(sessionDir);
    if (!session) throw noSuchUpload();
    if (session.key !== key) {
      throw new Error(`Session key "${session.key}" does not match requested key "${key}"`);
    }

    const sorted = this.validateContiguousParts(parts);
    const filename = session.metadata?.filename || path.basename(key) || 'download.bin';

    const { metaPath, binPath } = this.getPathsForKey(key);
    const tempCombined = `${binPath}.comb.${Date.now()}`;
    const writeCombined = fs.createWriteStream(tempCombined);
    const overallHasher = crypto.createHash('sha256');
    let totalBytes = 0;

    try {
      for (const part of sorted) {
        const partFile = path.join(sessionDir, `part-${part.partNumber}.bin`);
        if (!fs.existsSync(partFile)) {
          throw new Error(`Part file "${part.partNumber}" missing on disk`);
        }
        totalBytes += await this.appendPartStream(partFile, writeCombined, overallHasher);
      }

      await new Promise<void>((resolve, reject) => {
        writeCombined.end((err?: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });

      if (expectedSize !== undefined && totalBytes !== expectedSize) {
        throw new Error(`Assembled multipart size ${totalBytes} does not match expected size ${expectedSize}`);
      }
      if (session.totalSize !== undefined && totalBytes !== session.totalSize) {
        throw new Error(`Assembled multipart size ${totalBytes} does not match the declared size ${session.totalSize}`);
      }

      assertNotSpoofedFilePath(tempCombined, resolveDeclaredFormat(filename, session.metadata?.contentType), filename);
    } catch (err) {
      writeCombined.destroy();
      if (fs.existsSync(tempCombined)) fs.unlinkSync(tempCombined);
      throw err;
    }

    fs.renameSync(tempCombined, binPath);
    const etag = `"${overallHasher.digest('hex')}"`;

    const now = Date.now();
    const storedMeta: StoredObjectMetadata = {
      key,
      size: totalBytes,
      etag,
      mimeType: session.metadata?.contentType || 'application/octet-stream',
      filename,
      uploadedAt: now,
      expiresAt: session.expiresAt,
      metadata: session.metadata?.customMetadata,
    };

    fs.writeFileSync(metaPath, JSON.stringify(storedMeta), 'utf-8');

    // Clean up session directory
    try {
      await fs.promises.rm(sessionDir, { recursive: true, force: true });
    } catch {}

    return storedMeta;
  }

  async abortMultipart(key: string, uploadId: string): Promise<boolean> {
    const sessionDir = this.sessionDirFor(uploadId);
    if (!fs.existsSync(sessionDir)) return false;

    try {
      await fs.promises.rm(sessionDir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  async presignGet(key: string, expiresInSeconds: number = 3600): Promise<StoragePresignedUrlResult> {
    const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const stringToSign = `GET\n${key}\n${expiresAt}`;
    const signature = crypto
      .createHmac('sha256', this.signingSecret)
      .update(stringToSign)
      .digest('hex');

    const url = `/api/storage/file/${encodeURIComponent(key)}?expiresAt=${expiresAt}&signature=${signature}`;
    return {
      url,
      expiresAt,
      signature,
      method: 'GET',
    };
  }

  verifyPresignedSignature(
    method: string,
    key: string,
    expiresAt: number,
    signature: string,
    uploadId?: string,
    partNumber?: number
  ): boolean {
    if (Math.floor(Date.now() / 1000) > expiresAt) return false;

    const upperMethod = method.toUpperCase();
    if (upperMethod === 'PUT' && !isLocalUploadId(uploadId)) return false;
    const stringToSign =
      upperMethod === 'PUT'
        ? `PUT\n${key}\n${uploadId || ''}\n${partNumber ?? ''}\n${expiresAt}`
        : `GET\n${key}\n${expiresAt}`;

    const expectedSig = crypto
      .createHmac('sha256', this.signingSecret)
      .update(stringToSign)
      .digest('hex');

    try {
      const sigBuf = Buffer.from(signature, 'hex');
      const expectedBuf = Buffer.from(expectedSig, 'hex');
      if (sigBuf.length !== expectedBuf.length) return false;
      return crypto.timingSafeEqual(sigBuf, expectedBuf);
    } catch {
      return false;
    }
  }

  private sweepFileIfExpired(file: string, now: number): boolean {
    if (!file.endsWith('.meta.json')) return false;

    const metaPath = path.join(this.storageDir, file);
    const binPath = path.join(this.storageDir, file.replace(/\.meta\.json$/, '.bin'));
    try {
      const raw = fs.readFileSync(metaPath, 'utf-8');
      const meta = JSON.parse(raw);
      if (!meta.expiresAt || now <= meta.expiresAt) {
        return false;
      }
      if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
      if (fs.existsSync(binPath)) fs.unlinkSync(binPath);
      return true;
    } catch {
      return false;
    }
  }

  public sweepExpiredObjects(now: number = Date.now()): number {
    try {
      if (!fs.existsSync(this.storageDir)) return 0;
      const files = fs.readdirSync(this.storageDir);
      let swept = 0;
      for (const file of files) {
        if (this.sweepFileIfExpired(file, now)) {
          swept++;
        }
      }
      return swept;
    } catch {
      return 0;
    }
  }
}

export const localFsStorage: LocalFsStorage = lazySingleton(LocalFsStorage.prototype, () => new LocalFsStorage());

