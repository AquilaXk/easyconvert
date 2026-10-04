import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, PassThrough } from 'node:stream';
import Redis from 'ioredis';
import { localFsStorage } from './index';
import { globalSharedObjects } from './shared-store';
import { assertNotSpoofedFilePath } from '../security/file-guard';
import { FORMAT_REGISTRY } from '../registry';

export class TusOffsetMismatchError extends Error {
  constructor(public readonly expectedOffset: number) {
    super(`Upload-Offset mismatch. Expected offset is ${expectedOffset}`);
    this.name = 'TusOffsetMismatchError';
  }
}

export class TusChecksumMismatchError extends Error {
  constructor() {
    super('The checksum for the uploaded chunk did not match the provided Upload-Checksum');
    this.name = 'TusChecksumMismatchError';
  }
}

export class TusInvalidChecksumHeaderError extends Error {
  constructor(message: string = 'Invalid Upload-Checksum header format') {
    super(message);
    this.name = 'TusInvalidChecksumHeaderError';
  }
}

export class TusUnsupportedChecksumAlgorithmError extends Error {
  constructor(algo: string) {
    super(`Unsupported checksum algorithm "${algo}". Only "sha256" is supported.`);
    this.name = 'TusUnsupportedChecksumAlgorithmError';
  }
}

export class TusUploadExceededLengthError extends Error {
  constructor(exceededBytes: number, uploadLength: number) {
    super(`Uploaded bytes (${exceededBytes}) exceed declared Upload-Length (${uploadLength})`);
    this.name = 'TusUploadExceededLengthError';
  }
}

export class TusNotFoundError extends Error {
  constructor(id: string) {
    super(`TUS upload session "${id}" not found or expired`);
    this.name = 'TusNotFoundError';
  }
}

export interface TusSession {
  id: string;
  uploadLength: number;
  uploadOffset: number;
  metadata: string;
  parsedMetadata: Record<string, string>;
  key: string;
  filename: string;
  mimeType: string;
  ownerUserId?: string;
  createdAt: number;
  expiresAt: number;
  completed: boolean;
}

export interface CreateTusSessionParams {
  uploadLength: number;
  metadataHeader?: string;
  ownerUserId?: string;
  ttlSeconds?: number;
}

export interface AppendChunkResult {
  newOffset: number;
  isComplete: boolean;
  session: TusSession;
}

/**
 * TUS Session state store interface for Redis and In-Memory storage.
 */
export interface TusSessionStore {
  saveSession(session: TusSession, ttlSeconds?: number): Promise<void>;
  getSession(id: string): Promise<TusSession | null>;
  deleteSession(id: string): Promise<boolean>;
  reset?(): Promise<void>;
}

export class InMemoryTusSessionStore implements TusSessionStore {
  private readonly sessions = new Map<string, TusSession>();

  async saveSession(session: TusSession): Promise<void> {
    this.sessions.set(session.id, { ...session });
  }

  async getSession(id: string): Promise<TusSession | null> {
    const s = this.sessions.get(id);
    if (!s) return null;
    if (Date.now() > s.expiresAt) {
      this.sessions.delete(id);
      return null;
    }
    return { ...s };
  }

  async deleteSession(id: string): Promise<boolean> {
    return this.sessions.delete(id);
  }

  async reset(): Promise<void> {
    this.sessions.clear();
  }
}

export class RedisTusSessionStore implements TusSessionStore {
  private readonly redis: Redis;
  private readonly prefix: string = 'tus:session:';

  constructor(redisClient?: Redis) {
    if (redisClient) {
      this.redis = redisClient;
    } else {
      const url = process.env.REDIS_URL;
      if (url) {
        this.redis = new Redis(url, { maxRetriesPerRequest: 2, enableOfflineQueue: false });
      } else {
        const host = process.env.REDIS_HOST || '127.0.0.1';
        const port = Number(process.env.REDIS_PORT || 6379);
        this.redis = new Redis({ host, port, maxRetriesPerRequest: 2, enableOfflineQueue: false });
      }
    }
  }

  async saveSession(session: TusSession, ttlSeconds: number = 86400): Promise<void> {
    const key = `${this.prefix}${session.id}`;
    const ttl = Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000));
    await this.redis.set(key, JSON.stringify(session), 'EX', ttl || ttlSeconds);
  }

  async getSession(id: string): Promise<TusSession | null> {
    const key = `${this.prefix}${id}`;
    const raw = await this.redis.get(key);
    if (!raw) return null;
    try {
      const s = JSON.parse(raw) as TusSession;
      if (Date.now() > s.expiresAt) {
        await this.redis.del(key);
        return null;
      }
      return s;
    } catch {
      return null;
    }
  }

  async deleteSession(id: string): Promise<boolean> {
    const key = `${this.prefix}${id}`;
    const res = await this.redis.del(key);
    return res > 0;
  }

  async reset(): Promise<void> {
    const keys = await this.redis.keys(`${this.prefix}*`);
    if (keys.length > 0) {
      await Promise.all(keys.map((k) => this.redis.del(k)));
    }
  }
}

let activeTusSessionStore: TusSessionStore | null = null;

export function getTusSessionStore(): TusSessionStore {
  if (!activeTusSessionStore) {
    if (process.env.REDIS_URL || process.env.REDIS_HOST) {
      try {
        activeTusSessionStore = new RedisTusSessionStore();
      } catch {
        activeTusSessionStore = new InMemoryTusSessionStore();
      }
    } else {
      activeTusSessionStore = new InMemoryTusSessionStore();
    }
  }
  return activeTusSessionStore;
}

export function setTusSessionStore(store: TusSessionStore | null): void {
  activeTusSessionStore = store;
}

/**
 * Parses TUS 1.0 Upload-Metadata header.
 * Format: "key1 base64value1,key2 base64value2"
 */
export function parseTusMetadata(header?: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header || typeof header !== 'string') return result;

  const pairs = header.split(',');
  for (const pair of pairs) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const firstSpace = trimmed.indexOf(' ');
    if (firstSpace === -1) {
      result[trimmed] = '';
    } else {
      const key = trimmed.slice(0, firstSpace).trim();
      const encodedVal = trimmed.slice(firstSpace + 1).trim();
      try {
        result[key] = Buffer.from(encodedVal, 'base64').toString('utf-8');
      } catch {
        result[key] = '';
      }
    }
  }
  return result;
}

/**
 * Serializes parsed key-value metadata into TUS 1.0 header format.
 */
export function serializeTusMetadata(meta: Record<string, string>): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(meta)) {
    const encoded = Buffer.from(value, 'utf-8').toString('base64');
    pairs.push(`${key} ${encoded}`);
  }
  return pairs.join(',');
}

/**
 * In-process promise queue mutex ensuring deterministic serialization of concurrent TUS operations per session ID.
 */
export class SessionLockManager {
  private readonly locks = new Map<string, Promise<void>>();

  get activeLockCount(): number {
    return this.locks.size;
  }

  async runExclusive<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(sessionId) || Promise.resolve();
    let releaseLock!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const chained = prev.then(
      () => current,
      () => current
    );
    this.locks.set(sessionId, chained);

    try {
      await prev;
      return await fn();
    } finally {
      releaseLock();
      if (this.locks.get(sessionId) === chained) {
        this.locks.delete(sessionId);
      }
    }
  }
}

function parseChecksumHeader(header?: string | null): { algo: string; expectedDigest: string } | null {
  if (header === undefined || header === null) return null;
  if (typeof header !== 'string') {
    throw new TusInvalidChecksumHeaderError('Upload-Checksum header must be a string');
  }
  const trimmed = header.trim();
  if (trimmed === '') {
    throw new TusInvalidChecksumHeaderError('Upload-Checksum header is empty');
  }
  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx === -1) {
    throw new TusInvalidChecksumHeaderError(
      'Upload-Checksum header must consist of algorithm and base64 digest separated by space'
    );
  }
  const algo = trimmed.slice(0, spaceIdx).trim().toLowerCase();
  const expectedDigest = trimmed.slice(spaceIdx + 1).trim();
  if (!expectedDigest) {
    throw new TusInvalidChecksumHeaderError('Missing checksum digest in Upload-Checksum header');
  }
  if (algo !== 'sha256') {
    throw new TusUnsupportedChecksumAlgorithmError(algo);
  }
  return { algo, expectedDigest };
}

/**
 * Truncates appended file chunk back to clientOffset via ftruncateSync.
 */
function rollbackChunk(binPath: string, clientOffset: number): void {
  try {
    if (fs.existsSync(binPath)) {
      const fd = fs.openSync(binPath, 'r+');
      try {
        fs.ftruncateSync(fd, clientOffset);
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    try {
      fs.truncateSync(binPath, clientOffset);
    } catch {
      // Disk state handled fail-closed
    }
  }
}

async function finalizeTusSession(session: TusSession, binPath: string): Promise<void> {
  const { metaPath, binPath: targetBinPath } = localFsStorage.getPathsForKey(session.key);
  try {
    const parentDir = path.dirname(targetBinPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    // Zero-copy OS file copy
    fs.copyFileSync(binPath, targetBinPath);

    const stat = await fs.promises.stat(binPath);
    const hash = crypto.createHash('sha256').update(String(stat.mtimeMs)).digest('hex');
    const etag = `"${hash.slice(0, 32)}"`;

    const meta = {
      key: session.key,
      filename: session.filename,
      contentType: session.mimeType,
      size: session.uploadLength,
      etag,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    };
    await fs.promises.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');

    let cachedBuffer: Buffer | null = null;
    globalSharedObjects.set(session.key, {
      key: session.key,
      filename: session.filename,
      mimeType: session.mimeType,
      size: session.uploadLength,
      etag,
      uploadedAt: Date.now(),
      expiresAt: session.expiresAt,
      filePath: targetBinPath,
      get buffer(): Buffer {
        if (session.uploadLength > 32 * 1024 * 1024) {
          throw new Error('Payload too large for memory');
        }
        if (cachedBuffer) return cachedBuffer;
        if (fs.existsSync(targetBinPath)) {
          cachedBuffer = fs.readFileSync(targetBinPath);
          return cachedBuffer;
        }
        return Buffer.alloc(0);
      },
    });
  } catch {
    // Fallback if needed
    const readStream = fs.createReadStream(binPath);
    await localFsStorage.putStream(session.key, readStream, {
      contentType: session.mimeType,
      filename: session.filename,
      ttlSeconds: Math.max(3600, Math.floor((session.expiresAt - Date.now()) / 1000)),
    });
  }
}

export class TusEngine {
  private readonly tusDir: string;
  private readonly defaultTtlSeconds: number;
  private readonly lockManager = new SessionLockManager();
  readonly maxUploadSize: number = 5 * 1024 * 1024 * 1024; // 5 GiB

  constructor(options?: { tusDir?: string; defaultTtlSeconds?: number }) {
    this.tusDir =
      options?.tusDir ||
      path.resolve(
        process.env.EASYCONVERT_STORAGE_DIR || path.resolve(process.cwd(), '.easyconvert/storage'),
        'tus'
      );
    this.defaultTtlSeconds = options?.defaultTtlSeconds || 86400; // 24 hours
    this.ensureDirectory();
  }

  get sessionStore(): TusSessionStore {
    return getTusSessionStore();
  }

  private ensureDirectory(): void {
    try {
      if (!fs.existsSync(this.tusDir)) {
        fs.mkdirSync(this.tusDir, { recursive: true });
      }
    } catch {
      // In restricted environments, gracefully proceed
    }
  }

  private getPaths(id: string): { infoPath: string; binPath: string } {
    return {
      infoPath: path.join(this.tusDir, `${id}.info`),
      binPath: path.join(this.tusDir, `${id}.bin`),
    };
  }

  private toNodeReadable(
    stream: NodeJS.ReadableStream | ReadableStream<Uint8Array>
  ): NodeJS.ReadableStream {
    if ('pipe' in (stream as any) && typeof (stream as any).pipe === 'function') {
      return stream as NodeJS.ReadableStream;
    }
    return Readable.fromWeb(stream as any);
  }

  async createSession(params: CreateTusSessionParams): Promise<TusSession> {
    this.ensureDirectory();
    if (params.uploadLength > this.maxUploadSize) {
      throw new Error(`Upload length ${params.uploadLength} exceeds maximum allowed size ${this.maxUploadSize}`);
    }

    const id = `tus_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
    const rawMetadata = params.metadataHeader || '';
    const parsed = parseTusMetadata(rawMetadata);

    const filename = parsed.filename || parsed.name || `upload-${id}.bin`;
    const mimeType = parsed.filetype || parsed.contentType || 'application/octet-stream';
    const now = Date.now();
    const expiresAt = now + (params.ttlSeconds || this.defaultTtlSeconds) * 1000;

    // User namespace registration:
    // If ownerUserId is provided, register under user conversions namespace, otherwise uploads
    const base = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
    const sanitizedFilename = base.length > 0 ? base : `upload-${id}.bin`;
    const key = params.ownerUserId
      ? `conversions/${params.ownerUserId}/${id}_${sanitizedFilename}`
      : `uploads/${id}_${sanitizedFilename}`;

    const session: TusSession = {
      id,
      uploadLength: params.uploadLength,
      uploadOffset: 0,
      metadata: rawMetadata,
      parsedMetadata: parsed,
      key,
      filename,
      mimeType,
      ownerUserId: params.ownerUserId,
      createdAt: now,
      expiresAt,
      completed: false,
    };

    const { infoPath, binPath } = this.getPaths(id);
    await fs.promises.writeFile(infoPath, JSON.stringify(session, null, 2), 'utf-8');
    await fs.promises.writeFile(binPath, Buffer.alloc(0));

    // Save state in session store (Redis / In-memory)
    await this.sessionStore.saveSession(session, params.ttlSeconds || this.defaultTtlSeconds);

    return session;
  }

  async getSession(id: string): Promise<TusSession | null> {
    const { infoPath, binPath } = this.getPaths(id);
    let session = await this.sessionStore.getSession(id);

    if (!session) {
      if (fs.existsSync(infoPath)) {
        try {
          const raw = await fs.promises.readFile(infoPath, 'utf-8');
          session = JSON.parse(raw);
          if (session) {
            await this.sessionStore.saveSession(session);
          }
        } catch {
          return null;
        }
      }
    }

    if (!session) {
      return null;
    }

    if (Date.now() > session.expiresAt) {
      await this.terminateSession(id);
      return null;
    }

    // Sync uploadOffset with real byte size on disk
    if (fs.existsSync(binPath)) {
      const stat = await fs.promises.stat(binPath);
      session.uploadOffset = stat.size;
    }

    return session;
  }

  async appendChunk(
    id: string,
    clientOffset: number,
    stream: NodeJS.ReadableStream | ReadableStream<Uint8Array>,
    checksumHeader?: string | null
  ): Promise<AppendChunkResult> {
    return this.lockManager.runExclusive(id, async () => {
      const session = await this.getSession(id);
      if (!session) {
        throw new TusNotFoundError(id);
      }

      if (session.completed) {
        throw new Error(`Upload session "${id}" is already completed`);
      }

      if (session.uploadOffset !== clientOffset) {
        throw new TusOffsetMismatchError(session.uploadOffset);
      }

      const { infoPath, binPath } = this.getPaths(id);
      const nodeReadable = this.toNodeReadable(stream);

      const parsedChecksum = parseChecksumHeader(checksumHeader);
      let checksumHasher: crypto.Hash | null = null;
      if (parsedChecksum) {
        checksumHasher = crypto.createHash(parsedChecksum.algo);
      }

      const passThrough = new PassThrough();
      let chunkBytes = 0;
      let limitExceeded = false;

      passThrough.on('data', (chunk: Buffer | string) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        chunkBytes += buf.length;
        if (clientOffset + chunkBytes > session.uploadLength) {
          limitExceeded = true;
          passThrough.destroy(
            new TusUploadExceededLengthError(clientOffset + chunkBytes, session.uploadLength)
          );
          return;
        }
        if (checksumHasher) {
          checksumHasher.update(buf);
        }
      });

      const fileWriteStream = fs.createWriteStream(binPath, { flags: 'a' });

      try {
        await pipeline(nodeReadable, passThrough, fileWriteStream);
      } catch (err: any) {
        rollbackChunk(binPath, clientOffset);
        if (limitExceeded) {
          throw new TusUploadExceededLengthError(clientOffset + chunkBytes, session.uploadLength);
        }
        throw err;
      }

      if (checksumHasher && parsedChecksum) {
        const computedBase64 = checksumHasher.digest('base64');
        if (computedBase64 !== parsedChecksum.expectedDigest) {
          rollbackChunk(binPath, clientOffset);
          throw new TusChecksumMismatchError();
        }
      }

      const newOffset = clientOffset + chunkBytes;
      session.uploadOffset = newOffset;

      let isComplete = false;
      if (newOffset === session.uploadLength) {
        isComplete = true;
        session.completed = true;

        // Verify first 64 KiB magic bytes (assertNotSpoofedFilePath)
        const ext = path.extname(session.filename);
        let declaredFormat = ext ? ext.replace(/^\./, '').toLowerCase().trim() : '';
        if (!declaredFormat && session.mimeType) {
          const found = Object.values(FORMAT_REGISTRY).find((f) => f.mimeType === session.mimeType);
          if (found) {
            declaredFormat = found.extension;
          } else {
            const sub = session.mimeType.split('/').pop()?.toLowerCase().trim();
            declaredFormat = sub || 'bin';
          }
        }
        if (!declaredFormat) {
          declaredFormat = 'bin';
        }

        try {
          assertNotSpoofedFilePath(binPath, declaredFormat, session.filename);
        } catch (err) {
          session.completed = false;
          rollbackChunk(binPath, clientOffset);
          session.uploadOffset = clientOffset;
          await this.sessionStore.saveSession(session);
          await fs.promises.writeFile(infoPath, JSON.stringify(session, null, 2), 'utf-8');
          throw err;
        }

        await finalizeTusSession(session, binPath);
      }

      await this.sessionStore.saveSession(session);
      await fs.promises.writeFile(infoPath, JSON.stringify(session, null, 2), 'utf-8');

      return {
        newOffset,
        isComplete,
        session,
      };
    });
  }

  async terminateSession(id: string): Promise<boolean> {
    return this.lockManager.runExclusive(id, async () => {
      const { infoPath, binPath } = this.getPaths(id);
      const storeDeleted = await this.sessionStore.deleteSession(id);
      let fileDeleted = false;
      try {
        if (fs.existsSync(infoPath)) {
          await fs.promises.unlink(infoPath);
          fileDeleted = true;
        }
      } catch {
        // In-flight deletion race
      }
      try {
        if (fs.existsSync(binPath)) {
          await fs.promises.unlink(binPath);
          fileDeleted = true;
        }
      } catch {
        // In-flight deletion race
      }
      return storeDeleted || fileDeleted;
    });
  }

  get activeLockCount(): number {
    return this.lockManager.activeLockCount;
  }
}

export const tusEngine = new TusEngine();
