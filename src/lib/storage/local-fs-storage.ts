import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform, type Writable } from 'node:stream';
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
import { isProductionRuntime, LOCAL_PARTS_SUBDIR, resolveLocalStorageDir, resolveSigningSecret } from './storage-config';
import { resolveDeclaredFormat } from './declared-format';
import { assertNotSpoofedFilePath } from '../security/file-guard';
import { LARGEST_PLAN_FILE_BYTES, UPLOAD_PART_MAX_BYTES } from '../plan-limits';
import {
  EXCLUSIVE_CREATE,
  keepTouched,
  LEFTOVER_AGE_MS,
  sweepByNameTime,
  syncDirectory,
  syncFile,
  uniqueTempPath,
  writeFileAtomic,
  writeFlushedTemp,
} from './temp-file';
import { commitObjectFile, objectPathsFor, type ObjectPaths } from './shared-store';

/** Part numbers run from 1 to 10,000, as in the S3 multipart limits. */
export const MULTIPART_MAX_PARTS = 10_000;
/**
 * A part reaches this application in one request, so it holds at most what one request may carry (entry 137), not the
 * 5 GiB of an object store part: a larger body would be cut short by the framework before the route reads it.
 */
export const MULTIPART_MAX_PART_BYTES = UPLOAD_PART_MAX_BYTES;
/** The most one multipart upload may hold in all, and the cap of a session that declared no size. */
export const MULTIPART_MAX_TOTAL_BYTES = LARGEST_PLAN_FILE_BYTES;

const PROVIDER_NAME = 'local-fs';
const UPLOAD_ID_RANDOM_BYTES = 12;
/** Exactly the ids createMultipart generates: `up_<epoch ms>_<24 hex digits>`. */
const UPLOAD_ID_PATTERN = /^up_(\d{1,15})_[0-9a-f]{24}$/;
/** The record beside each stored part, as an object store server keeps `part.N.meta` beside `part.N`. */
const PART_RECORD_PATTERN = /^part-(\d+)\.meta$/;
const SESSION_FILE = 'session.json';
const DEFAULT_PART_BYTES = 5 * 1024 * 1024;
/**
 * How long a session takes parts, from its creation (its id holds the time): a day, as the stale uploads expiry of an
 * object store server (24 h by default). Past it and LEFTOVER_AGE_MS, the sweep removes what is left.
 */
export const MULTIPART_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

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

/** A stored part: its number, its size and the ETag it was acknowledged with. */
export interface StoredPart {
  partNumber: number;
  size: number;
  etag: string;
}

function isLocalUploadId(value: unknown): value is string {
  return typeof value === 'string' && UPLOAD_ID_PATTERN.test(value);
}

/** The time a session of this store was opened at, from its id; undefined for any other name. */
function sessionCreatedAt(name: string): number | undefined {
  const match = UPLOAD_ID_PATTERN.exec(name);
  return match ? Number(match[1]) : undefined;
}

function partPathOf(sessionDir: string, partNumber: number): string {
  return path.join(sessionDir, `part-${partNumber}.bin`);
}

function partRecordPathOf(sessionDir: string, partNumber: number): string {
  return path.join(sessionDir, `part-${partNumber}.meta`);
}

/** The bytes one part may hold: the S3 part maximum, within what the declared total leaves after the other parts. */
export function multipartPartByteLimit(declaredTotalBytes: number, otherPartsBytes: number): number {
  return Math.max(0, Math.min(MULTIPART_MAX_PART_BYTES, declaredTotalBytes - otherPartsBytes));
}

const EMPTY_PART_DETAIL = 'Chunk payload is empty (0 bytes).';

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
    this.partsDir = path.join(this.storageDir, LOCAL_PARTS_SUBDIR);
    this.defaultTtlSeconds = options?.defaultTtlSeconds || 3600;

    const secret = options?.signingSecret || resolveSigningSecret();
    if (!secret && isProductionRuntime()) {
      throw new Error('Missing required STORAGE_SIGNING_SECRET environment variable in production');
    }
    this.configuredSigningSecret = secret;

    this.ensureDirectories();

    this.gcTimer = setInterval(() => {
      void this.sweepExpiredObjects();
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

  public getPathsForKey(key: string): ObjectPaths {
    return objectPathsFor(this.storageDir, key);
  }

  /** The directory of a session this store generated; any other id, or one that leaves the parts directory, is NoSuchUpload. */
  private sessionDirFor(uploadId: string): string {
    if (!isLocalUploadId(uploadId)) throw noSuchUpload();
    const partsRoot = path.resolve(this.partsDir);
    const sessionDir = path.resolve(partsRoot, uploadId);
    if (path.dirname(sessionDir) !== partsRoot) throw noSuchUpload();
    return sessionDir;
  }

  /** The session stored in `sessionDir`, or undefined when there is none or its time is over. */
  private async readSession(sessionDir: string): Promise<LocalMultipartSession | undefined> {
    let session: LocalMultipartSession;
    try {
      session = JSON.parse(await fs.promises.readFile(path.join(sessionDir, SESSION_FILE), 'utf-8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    return Date.now() > session.expiresAt ? undefined : session;
  }

  /** The stored session of `uploadId`, or undefined when the id is not one this store generated or names no session. */
  async getMultipartSession(uploadId: unknown): Promise<LocalMultipartSession | undefined> {
    if (!isLocalUploadId(uploadId)) return undefined;
    return this.readSession(this.sessionDirFor(uploadId));
  }

  /**
   * The parts stored in `sessionDir`, from their records: a part counts once its record is written, which comes last
   * (see `savePartStream`), so a part a stopped process left without one is not stored.
   */
  private async storedParts(sessionDir: string): Promise<StoredPart[]> {
    const parts = await Promise.all(
      (await fs.promises.readdir(sessionDir)).map(async (name): Promise<StoredPart | undefined> => {
        const match = PART_RECORD_PATTERN.exec(name);
        if (!match) return undefined;
        try {
          const { size, etag } = JSON.parse(await fs.promises.readFile(path.join(sessionDir, name), 'utf-8')) as StoredPart;
          return { partNumber: Number(match[1]), size, etag };
        } catch (err) {
          // A part that is being replaced has no record for a moment.
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw err;
        }
      })
    );
    return parts.filter((part) => part !== undefined);
  }

  private async otherPartsBytes(sessionDir: string, partNumber: number): Promise<number> {
    return (await this.storedParts(sessionDir)).reduce((sum, part) => (part.partNumber === partNumber ? sum : sum + part.size), 0);
  }

  /** The stored parts of the session `uploadId`, by number, size and ETag; undefined when the id names no open session. */
  async listPartSizes(uploadId: string): Promise<StoredPart[] | undefined> {
    if (!(await this.getMultipartSession(uploadId))) return undefined;
    return this.storedParts(this.sessionDirFor(uploadId));
  }

  private toNodeReadable(stream: NodeJS.ReadableStream | ReadableStream<Uint8Array>): NodeJS.ReadableStream {
    if (typeof (stream as any)[Symbol.asyncIterator] === 'function' && typeof (stream as any).pipe !== 'function') {
      return Readable.fromWeb(stream as any);
    }
    return stream as NodeJS.ReadableStream;
  }

  /** Streams `stream` into a temporary file beside the object and stores it (see `commitObjectFile`, which flushes it); a failed stream stores nothing. */
  async putStream(
    key: string,
    stream: NodeJS.ReadableStream | ReadableStream<Uint8Array>,
    metadata?: ObjectMetadata
  ): Promise<StoredObjectMetadata> {
    this.ensureDirectories();
    const paths = this.getPathsForKey(key);
    const tempPath = uniqueTempPath(paths.binPath, 'tmp');
    const hasher = crypto.createHash('sha256');
    let totalBytes = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        hasher.update(chunk);
        totalBytes += chunk.length;
        done(null, chunk);
      },
    });

    const writeStream = fs.createWriteStream(tempPath, { flags: EXCLUSIVE_CREATE });
    await once(writeStream, 'open');
    const stopTouching = await keepTouched(tempPath);
    try {
      await pipeline(this.toNodeReadable(stream), counter, writeStream);
    } catch (error) {
      await fs.promises.rm(tempPath, { force: true });
      throw error;
    } finally {
      stopTouching();
    }

    const now = Date.now();
    const storedMeta: StoredObjectMetadata = {
      key,
      size: totalBytes,
      etag: `"${hasher.digest('hex')}"`,
      mimeType: metadata?.contentType || 'application/octet-stream',
      filename: metadata?.filename || path.basename(key) || 'download.bin',
      uploadedAt: now,
      expiresAt: now + (metadata?.ttlSeconds ?? this.defaultTtlSeconds) * 1000,
      metadata: metadata?.customMetadata,
    };
    try {
      await commitObjectFile(paths, tempPath, storedMeta);
    } catch (error) {
      await fs.promises.rm(tempPath, { force: true });
      throw error;
    }
    return storedMeta;
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
    declared?: Partial<DeclaredMultipartUpload> & { partSize?: number }
  ): Promise<MultipartSession> {
    this.ensureDirectories();
    const createdAt = Date.now();
    const uploadId = `up_${createdAt}_${crypto.randomBytes(UPLOAD_ID_RANDOM_BYTES).toString('hex')}`;
    const sessionDir = this.sessionDirFor(uploadId);
    await fs.promises.mkdir(sessionDir, { recursive: true });

    const session: LocalMultipartSession = {
      ...declared,
      uploadId,
      key,
      partSize: declared?.partSize ?? DEFAULT_PART_BYTES,
      createdAt,
      expiresAt: createdAt + MULTIPART_SESSION_TTL_MS,
      metadata,
    };
    await writeFileAtomic(path.join(sessionDir, SESSION_FILE), JSON.stringify(session));
    return session;
  }

  /**
   * Stores part `partNumber` of the session `uploadId`, at most `maxPartBytes` and what the declared total leaves after
   * the other parts. The part is stored as an object store server stores one (erasure-multipart.go renamePart,
   * xl-storage.go RenamePart): the bytes and the record are flushed to temporary files first, then the record of an
   * earlier attempt is removed, the bytes are renamed into place and the record is renamed last, so a record never
   * describes other bytes than its own.
   */
  async savePartStream(
    uploadId: string,
    partNumber: number,
    stream: NodeJS.ReadableStream | ReadableStream<Uint8Array>,
    maxPartBytes: number = MULTIPART_MAX_PART_BYTES
  ): Promise<Required<CompletedPart>> {
    const sessionDir = this.sessionDirFor(uploadId);
    assertPartNumber(partNumber);
    const session = await this.readSession(sessionDir);
    if (!session) throw noSuchUpload();
    const declaredTotal = session.totalSize ?? MULTIPART_MAX_TOTAL_BYTES;
    const limit = Math.min(maxPartBytes, multipartPartByteLimit(declaredTotal, await this.otherPartsBytes(sessionDir, partNumber)));

    const partPath = partPathOf(sessionDir, partNumber);
    const recordPath = partRecordPathOf(sessionDir, partNumber);
    const tempPartPath = uniqueTempPath(partPath, 'tmp');
    const hasher = crypto.createHash('sha256');
    let partSize = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        partSize += chunk.length;
        if (partSize > limit) {
          done(partTooLarge(limit));
          return;
        }
        hasher.update(chunk);
        done(null, chunk);
      },
    });

    let tempRecordPath: string | undefined;
    try {
      await pipeline(this.toNodeReadable(stream), limiter, fs.createWriteStream(tempPartPath, { flags: EXCLUSIVE_CREATE }));
      if (partSize === 0) throw new StorageInputError(EMPTY_PART_DETAIL, PROVIDER_NAME);
      const etag = `"${hasher.digest('hex')}"`;
      await syncFile(tempPartPath);
      tempRecordPath = await writeFlushedTemp(recordPath, JSON.stringify({ size: partSize, etag }));
      // No await from here to the record, so another attempt of the part in this process cannot slip in between.
      fs.rmSync(recordPath, { force: true });
      fs.renameSync(tempPartPath, partPath);
      fs.renameSync(tempRecordPath, recordPath);
      tempRecordPath = undefined;
      await syncDirectory(sessionDir);
      // Parts that landed while this one streamed were not counted in `limit`, so check the sum again.
      const remaining = multipartPartByteLimit(declaredTotal, await this.otherPartsBytes(sessionDir, partNumber));
      if (partSize > remaining) {
        await fs.promises.rm(recordPath, { force: true });
        await fs.promises.rm(partPath, { force: true });
        throw partTooLarge(remaining);
      }
      return { partNumber, etag, size: partSize };
    } catch (err) {
      await Promise.all([tempPartPath, tempRecordPath].map((stray) => (stray === undefined ? undefined : fs.promises.rm(stray, { force: true }))));
      throw err;
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

  /** The listed parts must be stored and, when the session declared a size, add up to it. */
  private async assertPartsMatchDeclaredSize(sessionDir: string, sorted: CompletedPart[], declaredTotal: number | undefined): Promise<void> {
    const stored = new Map((await this.storedParts(sessionDir)).map((part) => [part.partNumber, part.size] as const));
    let listedBytes = 0;
    for (const { partNumber } of sorted) {
      const size = stored.get(partNumber);
      if (size === undefined) throw new Error(`Part "${partNumber}" is not stored`);
      listedBytes += size;
    }
    if (declaredTotal !== undefined && listedBytes !== declaredTotal) {
      throw new Error(`Listed parts add up to ${listedBytes} bytes, which does not match the declared size ${declaredTotal}`);
    }
  }

  /** Streams the part files in order into `destination`, hashing them; settles with the byte count, or with the destination's error. */
  private async assembleParts(partFiles: string[], destination: Writable, hasher: crypto.Hash): Promise<number> {
    let bytes = 0;
    async function* chunks(): AsyncGenerator<Buffer> {
      for (const partFile of partFiles) {
        for await (const chunk of fs.createReadStream(partFile)) {
          hasher.update(chunk);
          bytes += chunk.length;
          yield chunk;
        }
      }
    }
    await pipeline(Readable.from(chunks()), destination);
    return bytes;
  }

  /**
   * Assembles the listed parts of an open session into its object, which expires at `expiresAt`, and ends the session.
   * `check` may refuse the assembled file before it is stored. Nothing is stored when any step fails.
   */
  private async assemble(
    sessionDir: string,
    session: LocalMultipartSession,
    parts: CompletedPart[],
    expiresAt: number,
    check: (assembledPath: string, totalBytes: number, filename: string) => void
  ): Promise<StoredObjectMetadata> {
    const sorted = this.validateContiguousParts(parts);
    await this.assertPartsMatchDeclaredSize(sessionDir, sorted, session.totalSize);
    const filename = session.metadata?.filename || path.basename(session.key) || 'download.bin';
    const paths = this.getPathsForKey(session.key);
    const tempCombined = uniqueTempPath(paths.binPath, 'comb');
    const overallHasher = crypto.createHash('sha256');
    let totalBytes: number;
    try {
      const writeCombined = fs.createWriteStream(tempCombined, { flags: EXCLUSIVE_CREATE });
      totalBytes = await this.assembleParts(sorted.map(({ partNumber }) => partPathOf(sessionDir, partNumber)), writeCombined, overallHasher);
      if (session.totalSize !== undefined && totalBytes !== session.totalSize) {
        throw new Error(`Assembled multipart size ${totalBytes} does not match the declared size ${session.totalSize}`);
      }
      check(tempCombined, totalBytes, filename);
    } catch (err) {
      await fs.promises.rm(tempCombined, { force: true });
      throw err;
    }

    const storedMeta: StoredObjectMetadata = {
      key: session.key,
      size: totalBytes,
      etag: `"${overallHasher.digest('hex')}"`,
      mimeType: session.metadata?.contentType || 'application/octet-stream',
      filename,
      uploadedAt: Date.now(),
      expiresAt,
      metadata: session.metadata?.customMetadata,
    };
    try {
      await commitObjectFile(paths, tempCombined, storedMeta);
    } catch (err) {
      await fs.promises.rm(tempCombined, { force: true });
      throw err;
    }
    // A session directory that cannot be removed now is removed by the sweep once its time is over.
    await fs.promises.rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
    return storedMeta;
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
    return this.assemble(sessionDir, session, parts, session.expiresAt, (assembledPath, totalBytes, filename) => {
      if (expectedSize !== undefined && totalBytes !== expectedSize) {
        throw new Error(`Assembled multipart size ${totalBytes} does not match expected size ${expectedSize}`);
      }
      assertNotSpoofedFilePath(assembledPath, resolveDeclaredFormat(filename, session.metadata?.contentType), filename);
    });
  }

  /**
   * Assembles the listed parts of the session `uploadId` into the object it was opened for, which expires at
   * `expiresAt`, without looking at what the file holds: for job storage, which checks the format where a job starts.
   */
  async assembleMultipart(uploadId: string, parts: CompletedPart[], expiresAt: number): Promise<StoredObjectMetadata> {
    const sessionDir = this.sessionDirFor(uploadId);
    const session = await this.readSession(sessionDir);
    if (!session) throw noSuchUpload();
    return this.assemble(sessionDir, session, parts, expiresAt, () => undefined);
  }

  /** The sessions whose time is not over, counted by the time in their ids. */
  countOpenSessions(now: number = Date.now()): number {
    let names: string[];
    try {
      names = fs.readdirSync(this.partsDir);
    } catch {
      return 0;
    }
    return names.filter((name) => {
      const createdAt = sessionCreatedAt(name);
      return createdAt !== undefined && now - createdAt <= MULTIPART_SESSION_TTL_MS;
    }).length;
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

  /**
   * Removes the expired objects, and the sessions an hour after their time is over, by the time in their ids: a part
   * that was already on the way when the session expired has that hour to finish.
   */
  public async sweepExpiredObjects(now: number = Date.now()): Promise<number> {
    const sessions = await sweepByNameTime(this.partsDir, sessionCreatedAt, MULTIPART_SESSION_TTL_MS + LEFTOVER_AGE_MS, now);
    try {
      if (!fs.existsSync(this.storageDir)) return sessions;
      const files = fs.readdirSync(this.storageDir);
      let swept = sessions;
      for (const file of files) {
        if (this.sweepFileIfExpired(file, now)) {
          swept++;
        }
      }
      return swept;
    } catch {
      return sessions;
    }
  }
}

export const localFsStorage: LocalFsStorage = lazySingleton(LocalFsStorage.prototype, () => new LocalFsStorage());

