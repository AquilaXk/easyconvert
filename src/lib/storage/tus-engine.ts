import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, PassThrough } from 'node:stream';
import type Redis from 'ioredis';
import { createConfiguredRedisClient, hasConfiguredRedis } from '../redis/client-factory';
import { pipelineReplies } from '../redis/pipeline-replies';
import { readyGatedRedis } from '../redis/when-ready';
import { localFsStorage } from './local-fs-storage';
import { objectStorage, storageProvider } from './selected-storage';
import { commitCopiedObjectFile, globalSharedObjects } from './shared-store';
import { assertNotSpoofedFile, assertNotSpoofedFilePath } from '../security/file-guard';
import { LARGEST_PLAN_FILE_BYTES } from '../plan-limits';
import { resolveDeclaredFormat } from './declared-format';
import { StorageServiceError } from './adapters/adapter-interface';
import { multipartUploadKey } from './key-namespace';
import { registerCompletedUpload } from './retention-service';
import { MAX_CONTENT_TYPE_LENGTH, isValidContentType } from './object-attributes';
import { clearKeysMatching } from '../redis/clear-keys';

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

/**
 * The completed upload was stored but its record could not be written, so it was removed again. A store the upload needs is
 * unavailable for now: the routes answer it as a storage error (503 with `Retry-After`), and the last chunk may be sent again.
 */
export class TusUploadNotRecordedError extends StorageServiceError {
  constructor(cause: unknown) {
    super('The upload could not be recorded.', 'retention', { retryable: true }, cause);
    this.name = 'TusUploadNotRecordedError';
  }
}

/** The metadata sent when creating an upload cannot be accepted (for example a content type that is not a header value). */
export class TusInvalidMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TusInvalidMetadataError';
  }
}

/** Exactly the ids createSession generates: `tus_<epoch ms>_<16 hex digits>`. */
const TUS_ID_PATTERN = /^tus_\d{1,15}_[0-9a-f]{16}$/;
/** A file of the staging directory: the id of its session, then `info` (the record) or `bin` (the staged bytes). */
const TUS_FILE_PATTERN = /^(tus_\d{1,15}_[0-9a-f]{16})\.(info|bin)$/;
/** How long after a session's time is over a staged file with no record is left, for a request that is still writing it. */
const ORPHAN_GRACE_MS = 3_600_000;
/** The sweep of the staging directory runs at most this often, when an upload is created. */
const SWEEP_INTERVAL_MS = 10 * 60_000;

/** The time (epoch ms) a session id was made at. */
function tusIdTime(id: string): number {
  return Number(id.split('_')[1]);
}

function isTusId(id: string): boolean {
  return TUS_ID_PATTERN.test(id);
}

export class TusNotFoundError extends Error {
  constructor(id: string) {
    super(`TUS upload session "${id}" not found or expired`);
    this.name = 'TusNotFoundError';
  }
}

export interface TusRemotePartRecord {
  partNumber: number;
  etag: string;
  size: number;
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
  /** S3/OCI-native multipart upload session token (`tus/tusd` `pkg/s3store` streaming model for `> 8 MiB` remote uploads). */
  remoteUploadId?: string;
  remoteParts?: TusRemotePartRecord[];
  remoteFlushedBytes?: number;
  /** First `<= 64 KiB` of the upload captured from byte 0 so magic-byte spoof verification succeeds after flushing early parts. */
  headerProbeBase64?: string;
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
  /** Serializes concurrent operations on `id` across distributed API replicas when backed by Redis. */
  withSessionLock?<T>(id: string, fn: () => Promise<T>): Promise<T>;
  /** Persists staged chunk bytes (`[0, newOffset)`) for cross-replica TUS resumption before finalization. */
  syncStagedBytes?(id: string, binPath: string, previousOffset: number, newOffset: number, ttlSeconds: number): Promise<void>;
  /** Replaces staged tail bytes (`< TUS_REMOTE_PART_BYTES`) after flushing completed S3 multipart parts. */
  replaceStagedTailBytes?(id: string, tail: Buffer, ttlSeconds: number): Promise<void>;
  /** Hydrates local `binPath` up to `expectedOffset` when a subsequent `PATCH` lands on another replica. */
  hydrateStagedFile?(id: string, binPath: string, expectedOffset: number): Promise<number>;
  /** Deletes intermediate cross-replica staged bytes once finalized or terminated. */
  deleteStagedBytes?(id: string): Promise<void>;
  /** The ids of the sessions `ownerUserId` has open, for the erasure of an account. */
  idsOfOwner?(ownerUserId: string): Promise<string[]>;
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

  async idsOfOwner(ownerUserId: string): Promise<string[]> {
    return [...this.sessions.values()].filter((session) => session.ownerUserId === ownerUserId).map((session) => session.id);
  }

  async reset(): Promise<void> {
    this.sessions.clear();
  }
}

const TUS_LOCK_TTL_MS = 30_000;
const TUS_LOCK_RENEW_MS = 10_000;
const TUS_LOCK_WAIT_MS = 15_000;
const TUS_STAGE_SLICE_BYTES = 1024 * 1024;
const MAX_REDIS_STAGED_UPLOAD_BYTES = 128 * 1024 * 1024;
/** S3/OCI multipart flush quantum (`8 MiB >= 5 MiB` S3 minimum; `10 GiB / 8 MiB = 1,280 <= 10,000` parts). */
export const TUS_REMOTE_PART_BYTES = 8 * 1024 * 1024;
const TUS_MAGIC_PROBE_BYTES = 64 * 1024;

const TUS_RENEW_LOCK_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

const TUS_RELEASE_LOCK_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export class RedisTusSessionStore implements TusSessionStore {
  private readonly redis: Redis;
  private readonly prefix: string = 'tus:session:';

  constructor(redisClient?: Redis) {
    if (redisClient) {
      this.redis = redisClient;
    } else {
      this.redis = readyGatedRedis(createConfiguredRedisClient({ maxRetriesPerRequest: 2, enableOfflineQueue: false }));
    }
  }

  private ownerIndexKey(ownerUserId: string): string {
    return `tus:owner:${ownerUserId}`;
  }

  private lockKey(id: string): string {
    return `tus:lock:${id}`;
  }

  private stageChunksKey(id: string): string {
    return `tus:stage:${id}`;
  }

  private stageLengthKey(id: string): string {
    return `tus:stage:len:${id}`;
  }

  async withSessionLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (
      typeof (this.redis as { set?: unknown }).set !== 'function' ||
      typeof (this.redis as { eval?: unknown }).eval !== 'function'
    ) {
      return fn();
    }
    const key = this.lockKey(id);
    const token = crypto.randomBytes(16).toString('hex');
    const deadline = Date.now() + TUS_LOCK_WAIT_MS;
    let attempt = 0;
    for (;;) {
      const acquired = await this.redis.set(key, token, 'PX', TUS_LOCK_TTL_MS, 'NX');
      if (acquired === 'OK') break;
      if (Date.now() >= deadline) {
        throw new StorageServiceError(
          `Timed out acquiring distributed TUS session lock for "${id}"`,
          'tus',
          { retryable: true }
        );
      }
      const waitMs = Math.min(100, 15 * 2 ** Math.min(attempt, 3)) + (attempt % 7);
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    const renewTimer = setInterval(() => {
      void this.redis.eval(TUS_RENEW_LOCK_LUA, 1, key, token, String(TUS_LOCK_TTL_MS)).catch(() => undefined);
    }, TUS_LOCK_RENEW_MS);
    if (typeof renewTimer.unref === 'function') renewTimer.unref();

    try {
      return await fn();
    } finally {
      clearInterval(renewTimer);
      await this.redis.eval(TUS_RELEASE_LOCK_LUA, 1, key, token).catch(() => undefined);
    }
  }

  async syncStagedBytes(
    id: string,
    binPath: string,
    previousOffset: number,
    newOffset: number,
    ttlSeconds: number
  ): Promise<void> {
    if (
      newOffset <= 0 ||
      newOffset > MAX_REDIS_STAGED_UPLOAD_BYTES ||
      typeof (this.redis as { rpush?: unknown }).rpush !== 'function'
    ) {
      return;
    }
    const chunksKey = this.stageChunksKey(id);
    const lenKey = this.stageLengthKey(id);
    const effectiveTtl = Math.max(60, Math.floor(ttlSeconds));
    const currentLen = Number((await this.redis.get(lenKey)) || '0');
    let writeFrom = previousOffset;
    if (currentLen !== previousOffset) {
      await this.redis.del(chunksKey, lenKey);
      writeFrom = 0;
    }
    const handle = await fs.promises.open(binPath, 'r');
    try {
      let cursor = writeFrom;
      while (cursor < newOffset) {
        const sliceLen = Math.min(TUS_STAGE_SLICE_BYTES, newOffset - cursor);
        const buf = Buffer.allocUnsafe(sliceLen);
        const { bytesRead } = await handle.read(buf, 0, sliceLen, cursor);
        if (bytesRead <= 0) break;
        const payload = bytesRead === sliceLen ? buf : buf.subarray(0, bytesRead);
        await this.redis.rpush(chunksKey, payload.toString('base64'));
        cursor += bytesRead;
      }
      await this.redis.set(lenKey, String(cursor), 'EX', effectiveTtl);
      if (typeof (this.redis as { expire?: unknown }).expire === 'function') {
        await this.redis.expire(chunksKey, effectiveTtl);
      }
    } finally {
      await handle.close();
    }
  }

  async replaceStagedTailBytes(id: string, tail: Buffer, ttlSeconds: number): Promise<void> {
    if (typeof (this.redis as { del?: unknown }).del !== 'function') return;
    const chunksKey = this.stageChunksKey(id);
    const lenKey = this.stageLengthKey(id);
    await this.redis.del(chunksKey, lenKey);
    if (tail.length === 0 || typeof (this.redis as { rpush?: unknown }).rpush !== 'function') {
      return;
    }
    const effectiveTtl = Math.max(60, Math.floor(ttlSeconds));
    for (let cursor = 0; cursor < tail.length; cursor += TUS_STAGE_SLICE_BYTES) {
      const slice = tail.subarray(cursor, Math.min(tail.length, cursor + TUS_STAGE_SLICE_BYTES));
      await this.redis.rpush(chunksKey, slice.toString('base64'));
    }
    await this.redis.set(lenKey, String(tail.length), 'EX', effectiveTtl);
    if (typeof (this.redis as { expire?: unknown }).expire === 'function') {
      await this.redis.expire(chunksKey, effectiveTtl);
    }
  }

  async hydrateStagedFile(id: string, binPath: string, expectedOffset: number): Promise<number> {
    if (expectedOffset <= 0) {
      await fs.promises.mkdir(path.dirname(binPath), { recursive: true });
      await fs.promises.writeFile(binPath, Buffer.alloc(0));
      return 0;
    }
    if (typeof (this.redis as { lrange?: unknown }).lrange !== 'function') {
      return fs.promises.stat(binPath).then((st) => st.size, () => 0);
    }
    const stagedLen = Number((await this.redis.get(this.stageLengthKey(id))) || '0');
    if (stagedLen < expectedOffset) {
      return fs.promises.stat(binPath).then((st) => st.size, () => 0);
    }
    await fs.promises.mkdir(path.dirname(binPath), { recursive: true });
    const tempPath = `${binPath}.${crypto.randomBytes(6).toString('hex')}.hydrate`;
    const handle = await fs.promises.open(tempPath, 'w');
    let written = 0;
    try {
      const chunksKey = this.stageChunksKey(id);
      const batchSize = 8;
      for (let idx = 0; written < expectedOffset; idx += batchSize) {
        const items = await this.redis.lrange(chunksKey, idx, idx + batchSize - 1);
        if (items.length === 0) break;
        for (const encoded of items) {
          if (written >= expectedOffset) break;
          const decoded = Buffer.from(encoded, 'base64');
          const needed = Math.min(decoded.length, expectedOffset - written);
          await handle.write(decoded, 0, needed, written);
          written += needed;
        }
      }
    } finally {
      await handle.close();
    }
    if (written !== expectedOffset) {
      await fs.promises.rm(tempPath, { force: true });
      return fs.promises.stat(binPath).then((st) => st.size, () => 0);
    }
    await fs.promises.rename(tempPath, binPath);
    return written;
  }

  async deleteStagedBytes(id: string): Promise<void> {
    if (typeof (this.redis as { del?: unknown }).del === 'function') {
      await this.redis.del(this.stageChunksKey(id), this.stageLengthKey(id)).catch(() => undefined);
    }
  }

  private async readManyValues(keys: readonly string[]): Promise<(string | null)[]> {
    if (keys.length === 0) return [];
    if (typeof (this.redis as { pipeline?: unknown }).pipeline === 'function') {
      const pipeline = this.redis.pipeline();
      for (const k of keys) pipeline.get(k);
      return (await pipelineReplies(pipeline)) as (string | null)[];
    }
    return Promise.all(keys.map((k) => this.redis.get(k)));
  }

  async saveSession(session: TusSession, ttlSeconds: number = 86400): Promise<void> {
    const key = `${this.prefix}${session.id}`;
    const ttl = Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000));
    const effectiveTtl = ttl || ttlSeconds;
    await this.redis.set(key, JSON.stringify(session), 'EX', effectiveTtl);
    if (session.ownerUserId && typeof (this.redis as { sadd?: unknown }).sadd === 'function') {
      const ownerKey = this.ownerIndexKey(session.ownerUserId);
      await this.redis.sadd(ownerKey, session.id);
      if (typeof (this.redis as { expire?: unknown }).expire === 'function') {
        await this.redis.expire(ownerKey, Math.max(86400, effectiveTtl));
      }
    }
  }

  async getSession(id: string): Promise<TusSession | null> {
    const key = `${this.prefix}${id}`;
    const raw = await this.redis.get(key);
    if (!raw) return null;
    try {
      const s = JSON.parse(raw) as TusSession;
      if (Date.now() > s.expiresAt) {
        await this.deleteSession(id);
        return null;
      }
      return s;
    } catch {
      return null;
    }
  }

  async deleteSession(id: string): Promise<boolean> {
    const key = `${this.prefix}${id}`;
    let ownerUserId: string | undefined;
    try {
      const raw = await this.redis.get(key);
      if (raw) {
        ownerUserId = (JSON.parse(raw) as Partial<TusSession>).ownerUserId;
      }
    } catch {
      // ignore malformed record
    }
    const res = await this.redis.del(key);
    await this.deleteStagedBytes(id);
    if (ownerUserId && typeof (this.redis as { srem?: unknown }).srem === 'function') {
      await this.redis.srem(this.ownerIndexKey(ownerUserId), id).catch(() => undefined);
    }
    return res > 0;
  }

  /**
   * The sessions of an owner: those its `tus:owner:<userId>` set names, read with pipelined GETs, and always also one pipelined SCAN pass.
   * The set only knows the sessions made since it exists, and the erasure of an account (the only caller) must not miss an older one; a
   * SCAN that fails fails the call, so the erasure stops with the account and its uploads still there.
   */
  async idsOfOwner(ownerUserId: string): Promise<string[]> {
    const indexedIds: string[] = [];
    if (typeof (this.redis as { smembers?: unknown }).smembers === 'function') {
      const ownerKey = this.ownerIndexKey(ownerUserId);
      const indexed = await this.redis.smembers(ownerKey);
      if (indexed.length > 0) {
        const raws = await this.readManyValues(indexed.map((id) => `${this.prefix}${id}`));
        const ids: string[] = [];
        const stale: string[] = [];
        raws.forEach((raw, idx) => {
          if (!raw) {
            stale.push(indexed[idx]);
            return;
          }
          try {
            const session = JSON.parse(raw) as TusSession;
            if (session.ownerUserId === ownerUserId) ids.push(session.id);
            else stale.push(indexed[idx]);
          } catch {
            stale.push(indexed[idx]);
          }
        });
        if (stale.length > 0 && typeof (this.redis as { srem?: unknown }).srem === 'function') {
          await this.redis.srem(ownerKey, ...stale).catch(() => undefined);
        }
        indexedIds.push(...ids);
      }
    }

    const ids: string[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${this.prefix}*`, 'COUNT', 500);
      cursor = next;
      if (keys.length === 0) continue;
      for (const raw of await this.readManyValues(keys)) {
        if (!raw) continue;
        try {
          const session = JSON.parse(raw) as TusSession;
          if (session.ownerUserId === ownerUserId) ids.push(session.id);
        } catch {
          // A record that is not a session names no owner.
        }
      }
    } while (cursor !== '0');
    return [...new Set([...indexedIds, ...ids])];
  }

  async reset(): Promise<void> {
    await clearKeysMatching(this.redis, [`${this.prefix}*`, 'tus:owner:*', 'tus:lock:*', 'tus:stage:*']);
  }
}

let activeTusSessionStore: TusSessionStore | null = null;

export function getTusSessionStore(): TusSessionStore {
  if (!activeTusSessionStore) {
    activeTusSessionStore = hasConfiguredRedis() ? new RedisTusSessionStore() : new InMemoryTusSessionStore();
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

/** Remaining lifetime of a finished upload's object, but never less than an hour. */
function objectTtlSeconds(session: TusSession): number {
  return Math.max(3600, Math.floor((session.expiresAt - Date.now()) / 1000));
}

/** The staged file of a finished upload is not as long as the upload declared, so what it holds is not the upload. */
export class TusStagedSizeMismatchError extends Error {
  constructor(readonly stagedBytes: number, uploadLength: number) {
    super(`The staged upload holds ${stagedBytes} bytes, but the upload declared ${uploadLength} bytes. Continue from the offset of the upload.`);
    this.name = 'TusStagedSizeMismatchError';
  }
}

/** Refuses a staged file whose size is not the declared length of the upload; nothing is stored from it. */
async function assertStagedSize(binPath: string, uploadLength: number): Promise<void> {
  const staged = await fs.promises.stat(binPath).then((stat) => stat.size, () => 0);
  if (staged !== uploadLength) throw new TusStagedSizeMismatchError(staged, uploadLength);
}

/** Records the completed upload under `key` (`registerCompletedUpload`); a record that cannot be written removes the object again. */
async function recordTusUpload(key: string): Promise<void> {
  try {
    await registerCompletedUpload(storageProvider, key);
  } catch (error) {
    console.error('[tus] Could not record a completed upload, which was removed:', error);
    throw new TusUploadNotRecordedError(error);
  }
}

async function finalizeTusSession(session: TusSession, binPath: string): Promise<void> {
  if (storageProvider.kind === 'remote') {
    // The staged file is the only copy until the object store has it and the upload is recorded (`appendChunk` removes it
    // then); a failed store or record fails the upload, and a resend of the last chunk appends to the whole file.
    await objectStorage.putStream(session.key, fs.createReadStream(binPath), {
      contentType: session.mimeType,
      filename: session.filename,
      ttlSeconds: objectTtlSeconds(session),
      size: session.uploadLength,
    });
    return;
  }

  const paths = localFsStorage.getPathsForKey(session.key);
  try {
    const uploadedAt = Date.now();
    const etagHash = crypto
      .createHash('sha256')
      .update(`${session.id}:${session.key}:${session.uploadLength}:${uploadedAt}:${crypto.randomBytes(16).toString('hex')}`)
      .digest('hex');
    const record = {
      key: session.key,
      filename: session.filename,
      mimeType: session.mimeType,
      size: session.uploadLength,
      etag: `"${etagHash.slice(0, 32)}"`,
      uploadedAt,
      expiresAt: session.expiresAt,
    };
    if (path.resolve(paths.binPath) === path.resolve(globalSharedObjects.objectPath(session.key))) {
      await globalSharedObjects.storeCopiedFile(session.key, binPath, record);
    } else {
      await commitCopiedObjectFile(paths, binPath, record);
    }
  } catch {
    // Fallback if needed
    const readStream = fs.createReadStream(binPath);
    await localFsStorage.putStream(session.key, readStream, {
      contentType: session.mimeType,
      filename: session.filename,
      ttlSeconds: objectTtlSeconds(session),
    });
  }
}

export class TusEngine {
  private readonly tusDir: string;
  private readonly defaultTtlSeconds: number;
  private readonly lockManager = new SessionLockManager();
  readonly maxUploadSize: number = LARGEST_PLAN_FILE_BYTES;

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

  private lastSweepAt = 0;
  private inFlightSweep: Promise<number> | null = null;

  /** Starts `sweepExpired` unless one ran in the last ten minutes; its failure never fails the upload being created. */
  private sweepExpiredOften(): void {
    const now = Date.now();
    if (now - this.lastSweepAt < SWEEP_INTERVAL_MS) return;
    this.lastSweepAt = now;
    this.sweepExpired(now).catch((error) => console.warn('[tus] Could not sweep the staging directory:', error));
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

  /** The files of a session this engine generated; any other id could name a path outside the TUS directory. */
  private getPaths(id: string): { infoPath: string; binPath: string } {
    if (!isTusId(id)) throw new TusNotFoundError(id);
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

  /**
   * Removes the files of the sessions that expired, and the staged files that no record belongs to (a removal that stopped
   * between the two) once their id says they are older than a session lives. The sweep of the storage directory does not
   * look here. Returns how many uploads it removed.
   */
  async sweepExpired(now: number = Date.now()): Promise<number> {
    while (this.inFlightSweep) {
      await this.inFlightSweep.catch(() => 0);
    }
    let currentSweep: Promise<number>;
    currentSweep = this.performSweepExpired(now).finally(() => {
      if (this.inFlightSweep === currentSweep) {
        this.inFlightSweep = null;
      }
    });
    this.inFlightSweep = currentSweep;
    return currentSweep;
  }

  private async performSweepExpired(now: number): Promise<number> {
    let names: string[];
    try {
      names = fs.readdirSync(this.tusDir);
    } catch {
      return 0;
    }
    const files = new Set(names);
    let removed = 0;
    for (const name of names) {
      const match = TUS_FILE_PATTERN.exec(name);
      if (!match || !isTusId(match[1])) continue;
      const [, id, extension] = match;
      if (extension === 'info') {
        const expiresAt = await fs.promises.readFile(path.join(this.tusDir, name), 'utf-8').then((raw) => (JSON.parse(raw) as TusSession).expiresAt, () => undefined);
        if (typeof expiresAt === 'number' && now > expiresAt && (await this.terminateSession(id))) removed++;
      } else if (!files.has(`${id}.info`) && now - tusIdTime(id) > this.defaultTtlSeconds * 1000 + ORPHAN_GRACE_MS) {
        if (await this.terminateSession(id)) removed++;
      }
    }
    return removed;
  }

  async createSession(params: CreateTusSessionParams): Promise<TusSession> {
    this.ensureDirectory();
    this.sweepExpiredOften();
    if (params.uploadLength > this.maxUploadSize) {
      throw new Error(`Upload length ${params.uploadLength} exceeds maximum allowed size ${this.maxUploadSize}`);
    }

    const id = `tus_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
    const rawMetadata = params.metadataHeader || '';
    const parsed = parseTusMetadata(rawMetadata);

    const filename = parsed.filename || parsed.name || `upload-${id}.bin`;
    const mimeType = parsed.filetype || parsed.contentType || 'application/octet-stream';
    if (!isValidContentType(mimeType)) {
      throw new TusInvalidMetadataError(
        `The upload's content type must be a printable ASCII content type of at most ${MAX_CONTENT_TYPE_LENGTH} characters.`
      );
    }
    const now = Date.now();
    const expiresAt = now + (params.ttlSeconds || this.defaultTtlSeconds) * 1000;

    const base = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
    const sanitizedFilename = base.length > 0 ? base : `upload-${id}.bin`;
    let key = multipartUploadKey(params.ownerUserId, `${id}_${sanitizedFilename}`);
    let remoteUploadId: string | undefined;
    let remoteParts: TusRemotePartRecord[] | undefined;
    let remoteFlushedBytes: number | undefined;

    if (storageProvider.kind === 'remote' && params.uploadLength > TUS_REMOTE_PART_BYTES) {
      const initiated = await storageProvider.initiateMultipartUpload(
        filename,
        mimeType,
        params.uploadLength,
        params.ownerUserId,
        TUS_REMOTE_PART_BYTES
      );
      key = initiated.key;
      remoteUploadId = initiated.uploadId;
      remoteParts = [];
      remoteFlushedBytes = 0;
    }

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
      ...(remoteUploadId !== undefined
        ? { remoteUploadId, remoteParts, remoteFlushedBytes }
        : {}),
    };

    const { infoPath, binPath } = this.getPaths(id);
    await fs.promises.writeFile(infoPath, JSON.stringify(session, null, 2), 'utf-8');
    await fs.promises.writeFile(binPath, Buffer.alloc(0));

    // Save state in session store (Redis / In-memory)
    await this.sessionStore.saveSession(session, params.ttlSeconds || this.defaultTtlSeconds);

    return session;
  }

  async getSession(id: string): Promise<TusSession | null> {
    if (!isTusId(id)) return null;
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

    // Sync uploadOffset with real byte size on disk when local staging is authoritative (or ahead of shared store)
    if (fs.existsSync(binPath)) {
      const stat = await fs.promises.stat(binPath);
      const flushed = session.remoteUploadId ? (session.remoteFlushedBytes ?? 0) : 0;
      const totalLocalOffset = flushed + stat.size;
      if (!this.sessionStore.hydrateStagedFile || totalLocalOffset >= session.uploadOffset) {
        session.uploadOffset = totalLocalOffset;
      }
    }

    return session;
  }

  private async runSessionExclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
    return this.lockManager.runExclusive(id, async () => {
      const store = this.sessionStore;
      if (store.withSessionLock) {
        return store.withSessionLock(id, fn);
      }
      return fn();
    });
  }

  async appendChunk(
    id: string,
    clientOffset: number,
    stream: NodeJS.ReadableStream | ReadableStream<Uint8Array>,
    checksumHeader?: string | null
  ): Promise<AppendChunkResult> {
    return this.runSessionExclusive(id, async () => {
      this.ensureDirectory();
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
      const isRemoteMultipart = Boolean(session.remoteUploadId);
      const initialFlushed = isRemoteMultipart ? (session.remoteFlushedBytes ?? 0) : 0;
      const expectedLocalTailOffset = clientOffset - initialFlushed;

      if (expectedLocalTailOffset > 0 && this.sessionStore.hydrateStagedFile) {
        const localBytes = await fs.promises.stat(binPath).then((st) => st.size, () => -1);
        if (localBytes < expectedLocalTailOffset) {
          const hydrated = await this.sessionStore.hydrateStagedFile(id, binPath, expectedLocalTailOffset);
          if (hydrated !== expectedLocalTailOffset) {
            const actualTotal = initialFlushed + Math.max(0, hydrated);
            session.uploadOffset = actualTotal;
            await this.sessionStore.saveSession(session);
            await fs.promises.writeFile(infoPath, JSON.stringify(session, null, 2), 'utf-8');
            throw new TusStagedSizeMismatchError(actualTotal, session.uploadLength);
          }
        }
      } else if (expectedLocalTailOffset === 0) {
        await fs.promises.writeFile(binPath, Buffer.alloc(0));
      }

      const existingProbe = session.headerProbeBase64
        ? Buffer.from(session.headerProbeBase64, 'base64')
        : Buffer.alloc(0);
      const probeChunks: Buffer[] = existingProbe.length > 0 ? [existingProbe] : [];
      let probeLength = existingProbe.length;
      if (isRemoteMultipart && initialFlushed === 0 && probeLength < expectedLocalTailOffset && expectedLocalTailOffset > 0) {
        const prefixOnDisk = await fs.promises.readFile(binPath);
        const needed = Math.min(TUS_MAGIC_PROBE_BYTES - probeLength, prefixOnDisk.length);
        if (needed > 0) {
          probeChunks.push(prefixOnDisk.subarray(0, needed));
          probeLength += needed;
        }
      }

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
        const offsetBeforeChunk = clientOffset + chunkBytes;
        chunkBytes += buf.length;
        if (clientOffset + chunkBytes > session.uploadLength) {
          limitExceeded = true;
          passThrough.destroy(
            new TusUploadExceededLengthError(clientOffset + chunkBytes, session.uploadLength)
          );
          return;
        }
        if (isRemoteMultipart && offsetBeforeChunk < TUS_MAGIC_PROBE_BYTES && probeLength < TUS_MAGIC_PROBE_BYTES) {
          const needed = Math.min(TUS_MAGIC_PROBE_BYTES - probeLength, buf.length);
          if (needed > 0) {
            probeChunks.push(Buffer.from(buf.subarray(0, needed)));
            probeLength += needed;
          }
        }
        if (checksumHasher) {
          checksumHasher.update(buf);
        }
      });

      const fileWriteStream = fs.createWriteStream(binPath, { flags: 'a' });

      try {
        await pipeline(nodeReadable, passThrough, fileWriteStream);
      } catch (err: any) {
        rollbackChunk(binPath, expectedLocalTailOffset);
        if (limitExceeded) {
          throw new TusUploadExceededLengthError(clientOffset + chunkBytes, session.uploadLength);
        }
        throw err;
      }

      if (checksumHasher && parsedChecksum) {
        const computedBase64 = checksumHasher.digest('base64');
        if (computedBase64 !== parsedChecksum.expectedDigest) {
          rollbackChunk(binPath, expectedLocalTailOffset);
          throw new TusChecksumMismatchError();
        }
      }

      if (isRemoteMultipart && probeChunks.length > 0) {
        session.headerProbeBase64 = Buffer.concat(probeChunks, probeLength).toString('base64');
      }

      const newOffset = clientOffset + chunkBytes;
      const newTailBytes = expectedLocalTailOffset + chunkBytes;
      session.uploadOffset = newOffset;

      let isComplete = false;
      if (isRemoteMultipart && session.remoteUploadId) {
        const remainingTtl = Math.max(60, Math.floor((session.expiresAt - Date.now()) / 1000));
        if (newOffset === session.uploadLength) {
          isComplete = true;
          session.completed = true;
          try {
            await assertStagedSize(binPath, newTailBytes);
          } catch (err) {
            session.completed = false;
            const actualTail = err instanceof TusStagedSizeMismatchError ? err.stagedBytes : expectedLocalTailOffset;
            session.uploadOffset = initialFlushed + Math.min(actualTail, expectedLocalTailOffset);
            await this.sessionStore.saveSession(session);
            await fs.promises.writeFile(infoPath, JSON.stringify(session, null, 2), 'utf-8');
            throw new TusStagedSizeMismatchError(initialFlushed + actualTail, session.uploadLength);
          }

          try {
            const declaredFormat = resolveDeclaredFormat(session.filename, session.mimeType);
            const probeBuffer = session.headerProbeBase64
              ? Buffer.from(session.headerProbeBase64, 'base64')
              : await fs.promises.readFile(binPath);
            assertNotSpoofedFile(probeBuffer, declaredFormat, session.filename);
          } catch (err) {
            session.completed = false;
            rollbackChunk(binPath, expectedLocalTailOffset);
            session.uploadOffset = clientOffset;
            await this.sessionStore.saveSession(session);
            await fs.promises.writeFile(infoPath, JSON.stringify(session, null, 2), 'utf-8');
            throw err;
          }

          const savedPartsBeforeFinal = [...(session.remoteParts ?? [])];
          const savedFlushedBeforeFinal = session.remoteFlushedBytes ?? 0;
          try {
            const tailBuffer = newTailBytes > 0 ? await fs.promises.readFile(binPath) : Buffer.alloc(0);
            const parts = [...savedPartsBeforeFinal];
            let cursor = 0;
            while (cursor < tailBuffer.length) {
              const sliceLen = Math.min(TUS_REMOTE_PART_BYTES, tailBuffer.length - cursor);
              const partBuf = tailBuffer.subarray(cursor, cursor + sliceLen);
              const nextPartNumber = parts.length + 1;
              const uploaded = await storageProvider.uploadPart(session.remoteUploadId, nextPartNumber, partBuf);
              parts.push({ partNumber: uploaded.partNumber, etag: uploaded.etag, size: uploaded.size });
              cursor += sliceLen;
            }
            session.remoteParts = parts;
            session.remoteFlushedBytes = session.uploadLength;
            await storageProvider.completeMultipartUpload(session.remoteUploadId, parts);
            await recordTusUpload(session.key);
            await fs.promises.rm(binPath, { force: true });
            await this.sessionStore.deleteStagedBytes?.(id);
          } catch (err) {
            session.completed = false;
            session.remoteParts = savedPartsBeforeFinal;
            session.remoteFlushedBytes = savedFlushedBeforeFinal;
            rollbackChunk(binPath, expectedLocalTailOffset);
            session.uploadOffset = clientOffset;
            await this.sessionStore.saveSession(session);
            await fs.promises.writeFile(infoPath, JSON.stringify(session, null, 2), 'utf-8');
            throw err;
          }
        } else {
          // Intermediate chunk on remote multipart: flush completed 8 MiB slices directly to S3 and keep only `< 8 MiB` tail.
          if (newTailBytes >= TUS_REMOTE_PART_BYTES) {
            const fullBuffer = await fs.promises.readFile(binPath);
            const parts = [...(session.remoteParts ?? [])];
            let cursor = 0;
            let flushedNow = initialFlushed;
            while (fullBuffer.length - cursor >= TUS_REMOTE_PART_BYTES) {
              const partBuf = fullBuffer.subarray(cursor, cursor + TUS_REMOTE_PART_BYTES);
              const nextPartNumber = parts.length + 1;
              const uploaded = await storageProvider.uploadPart(session.remoteUploadId, nextPartNumber, partBuf);
              parts.push({ partNumber: uploaded.partNumber, etag: uploaded.etag, size: uploaded.size });
              cursor += TUS_REMOTE_PART_BYTES;
              flushedNow += TUS_REMOTE_PART_BYTES;
            }
            const leftover = fullBuffer.subarray(cursor);
            await fs.promises.writeFile(binPath, leftover);
            session.remoteParts = parts;
            session.remoteFlushedBytes = flushedNow;
            if (this.sessionStore.replaceStagedTailBytes) {
              await this.sessionStore.replaceStagedTailBytes(id, leftover, remainingTtl);
            }
          } else if (newTailBytes > 0 && this.sessionStore.syncStagedBytes) {
            await this.sessionStore.syncStagedBytes(id, binPath, expectedLocalTailOffset, newTailBytes, remainingTtl);
          }
        }
      } else if (newOffset === session.uploadLength) {
        isComplete = true;
        session.completed = true;

        // What was staged must be the whole upload before anything is read from it or stored: a file of another size (lost or
        // appended to out of order) is refused, and the client continues from what the staged file really holds.
        try {
          await assertStagedSize(binPath, session.uploadLength);
        } catch (err) {
          session.completed = false;
          session.uploadOffset = err instanceof TusStagedSizeMismatchError ? Math.min(err.stagedBytes, clientOffset) : clientOffset;
          await this.sessionStore.saveSession(session);
          await fs.promises.writeFile(infoPath, JSON.stringify(session, null, 2), 'utf-8');
          throw err;
        }

        // Verify first 64 KiB magic bytes (assertNotSpoofedFilePath) against the declared format
        try {
          const declaredFormat = resolveDeclaredFormat(session.filename, session.mimeType);
          assertNotSpoofedFilePath(binPath, declaredFormat, session.filename);
        } catch (err) {
          session.completed = false;
          rollbackChunk(binPath, clientOffset);
          session.uploadOffset = clientOffset;
          await this.sessionStore.saveSession(session);
          await fs.promises.writeFile(infoPath, JSON.stringify(session, null, 2), 'utf-8');
          throw err;
        }

        try {
          await finalizeTusSession(session, binPath);
          await recordTusUpload(session.key);
          // The upload is stored and recorded now, wherever the store is; the staged copy would only occupy the local disk a second time.
          await fs.promises.rm(binPath, { force: true });
          await this.sessionStore.deleteStagedBytes?.(id);
        } catch (err) {
          // The upload was not taken: rewind the last chunk so the client can resend it.
          session.completed = false;
          rollbackChunk(binPath, clientOffset);
          session.uploadOffset = clientOffset;
          await this.sessionStore.saveSession(session);
          await fs.promises.writeFile(infoPath, JSON.stringify(session, null, 2), 'utf-8');
          throw err;
        }
      } else if (newOffset > 0 && this.sessionStore.syncStagedBytes) {
        const remainingTtl = Math.max(60, Math.floor((session.expiresAt - Date.now()) / 1000));
        await this.sessionStore.syncStagedBytes(id, binPath, clientOffset, newOffset, remainingTtl);
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
    if (!isTusId(id)) return false;
    return this.runSessionExclusive(id, async () => {
      const { infoPath, binPath } = this.getPaths(id);
      const existing = await this.sessionStore.getSession(id).catch(() => null);
      if (existing?.remoteUploadId && !existing.completed) {
        await Promise.resolve(storageProvider.abortMultipartUpload(existing.remoteUploadId)).catch(() => undefined);
      }
      const storeDeleted = await this.sessionStore.deleteSession(id);
      await this.sessionStore.deleteStagedBytes?.(id);
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

  /**
   * The ids of the uploads `ownerUserId` has open: the sessions of the session store, and the staged records of this host's
   * directory (a record the store lost is still a staged file of the owner).
   */
  async sessionsOfOwner(ownerUserId: string): Promise<string[]> {
    const ids = new Set(await this.sessionStore.idsOfOwner?.(ownerUserId));
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.tusDir);
    } catch {
      // No staging directory, no staged uploads.
    }
    for (const name of names) {
      const match = TUS_FILE_PATTERN.exec(name);
      if (!match || match[2] !== 'info' || !isTusId(match[1])) continue;
      const owner = await fs.promises.readFile(path.join(this.tusDir, name), 'utf-8').then((raw) => (JSON.parse(raw) as TusSession).ownerUserId, () => undefined);
      if (owner === ownerUserId) ids.add(match[1]);
    }
    return [...ids].sort((a, b) => a.localeCompare(b));
  }

  /** Ends every upload `ownerUserId` has open, with its staged file. Answers the ids it ended. */
  async terminateSessionsOfOwner(ownerUserId: string): Promise<string[]> {
    const ids = await this.sessionsOfOwner(ownerUserId);
    for (const id of ids) await this.terminateSession(id);
    return ids;
  }

  get activeLockCount(): number {
    return this.lockManager.activeLockCount;
  }
}

export const tusEngine = new TusEngine();
