import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { StoredObject } from './oci-storage';
import type { StoredObjectMetadata as ObjectRecord } from './object-storage';
import {
  ObjectStat,
  PayloadTooLargeForMemoryError,
  StoredObjectMissingError,
  getMaxInMemoryBytes,
} from './errors';
import { resolveLocalStorageDir } from './storage-config';
import {
  isTempFileName,
  LEFTOVER_AGE_MS,
  removeLeftover,
  stageBeside,
  syncDirectory,
  writeFileAtomicSync,
  writeFlushedTemp,
} from './temp-file';

/** The name of the bytes of a stored object: the SHA-256 of its key, as `objectPathsFor` gives it. */
const OBJECT_BYTES_NAME = /^([0-9a-f]{64})\.bin$/;

/** What tells one save of a key from another: the ETag of its bytes and the time it was stored. */
export type SavedVersion = Pick<ObjectRecord, 'etag' | 'uploadedAt'>;

/** The two files of a stored object in the storage directory: its record and its bytes. */
export interface ObjectPaths {
  metaPath: string;
  binPath: string;
}

/** Where the record and the bytes of `key` live in `storageDir`. */
export function objectPathsFor(storageDir: string, key: string): ObjectPaths {
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  return {
    metaPath: path.join(storageDir, `${hash}.meta.json`),
    binPath: path.join(storageDir, `${hash}.bin`),
  };
}

function recordOf(value: ObjectRecord): ObjectRecord {
  const { key, filename, mimeType, size, etag, uploadedAt, expiresAt, metadata } = value;
  return { key, filename, mimeType, size, etag, uploadedAt, expiresAt, metadata };
}

/** Writes the record of an object whose bytes are in place; when it cannot be written, the bytes are removed and the error is thrown. */
function writeRecord(paths: ObjectPaths, record: ObjectRecord): void {
  try {
    writeFileAtomicSync(paths.metaPath, JSON.stringify(record));
  } catch (error) {
    fs.rmSync(paths.binPath, { force: true });
    throw error;
  }
}

/** Removes the record and the bytes a save of the key left before, except the file that is being stored. */
function dropPreviousSave(paths: ObjectPaths, keep?: string): void {
  fs.rmSync(paths.metaPath, { force: true });
  if (keep === undefined || path.resolve(keep) !== paths.binPath) fs.rmSync(paths.binPath, { force: true });
}

/**
 * Stores the regular file at `sourcePath` as the object `paths` names, in the order an object store server stores a part:
 * the bytes are brought beside the object and flushed, and the record is written to a flushed temporary file; then, with
 * no await between them, the earlier record is removed, the bytes are renamed into place and the record onto its name.
 * At every point a reader finds the earlier object, no object, or this one, and never these bytes under an earlier
 * record. A `signal` that aborts before the renames stores nothing and leaves an earlier save of the key as it was.
 */
export async function commitObjectFile(paths: ObjectPaths, sourcePath: string, record: ObjectRecord, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const inPlace = path.resolve(sourcePath) === paths.binPath;
  const staged = inPlace ? paths.binPath : await stageBeside(sourcePath, paths.binPath, signal);
  let recordTemp: string | undefined;
  // What to remove when the save fails: the staged bytes, then the bytes without a record once they are in place.
  let strayBytes = inPlace ? undefined : staged;
  try {
    recordTemp = await writeFlushedTemp(paths.metaPath, JSON.stringify(recordOf(record)));
    signal?.throwIfAborted();
    // No await from here to the record, so another save of the key in this process cannot slip in between.
    fs.rmSync(paths.metaPath, { force: true });
    fs.renameSync(staged, paths.binPath);
    strayBytes = paths.binPath;
    fs.renameSync(recordTemp, paths.metaPath);
  } catch (error) {
    await Promise.all([strayBytes, recordTemp].map((stray) => (stray === undefined ? undefined : fs.promises.rm(stray, { force: true }))));
    throw error;
  }
  await syncDirectory(path.dirname(paths.binPath));
}

/** Default byte budget for cached file-backed buffers held in memory per `SharedObjectStore` instance (128 MiB). */
export const DEFAULT_MAX_SHARED_CACHE_BYTES = 128 * 1024 * 1024;
const MAX_META_KEY_CACHE_ENTRIES = 32_768;
const ATTACH_BUFFER_CACHE = Symbol('SharedObjectStore.attachBufferCache');

interface BufferCacheHooks {
  get(key: string): Buffer | undefined;
  put(key: string, buffer: Buffer): void;
}

type CacheBindableStoredObject = StoredObject & {
  [ATTACH_BUFFER_CACHE]?: (hooks: BufferCacheHooks) => void;
};

/** The object of `record` whose bytes are the file `binPath`, read into memory only when asked and within the in-memory limit. */
export function fileBackedObject(record: ObjectRecord, binPath: string): StoredObject {
  let cachedBuffer: Buffer | null = null;
  let hooks: BufferCacheHooks | null = null;
  const obj: CacheBindableStoredObject = {
    ...recordOf(record),
    filePath: binPath,
    get buffer(): Buffer {
      if (record.size > getMaxInMemoryBytes()) {
        throw new PayloadTooLargeForMemoryError(undefined, { size: record.size, limit: getMaxInMemoryBytes() });
      }
      if (hooks) {
        const fromPool = hooks.get(record.key);
        if (fromPool) return fromPool;
      } else if (cachedBuffer) {
        return cachedBuffer;
      }
      if (fs.existsSync(binPath)) {
        const buf = fs.readFileSync(binPath);
        if (hooks) {
          hooks.put(record.key, buf);
        } else {
          cachedBuffer = buf;
        }
        return buf;
      }
      throw new StoredObjectMissingError(undefined, { key: record.key, filePath: binPath });
    },
    set buffer(b: Buffer) {
      if (hooks) {
        hooks.put(record.key, b);
      } else {
        cachedBuffer = b;
      }
    },
  };
  Object.defineProperty(obj, ATTACH_BUFFER_CACHE, {
    enumerable: false,
    configurable: false,
    writable: false,
    value: (nextHooks: BufferCacheHooks) => {
      hooks = nextHooks;
      if (cachedBuffer) {
        const existing = cachedBuffer;
        cachedBuffer = null;
        hooks.put(record.key, existing);
      }
    },
  });
  return obj;
}

export interface SharedObjectStoreOptions {
  storageDir?: string;
  maxCachedBytes?: number;
}

/**
 * The objects of the local driver, in the storage directory that the web process and the workers share: what one
 * process stores, every other reads. The map holds the objects this process saw, the disk is what every process
 * agrees on.
 */
export class SharedObjectStore extends Map<string, StoredObject> {
  private readonly storageDir: string;
  private readonly maxCachedBytes: number;
  private readonly bufferCache = new Map<string, Buffer>();
  private cachedBytes = 0;
  private readonly metaKeyCache = new Map<string, { mtimeMs: number; size: number; key: string }>();
  private readonly cacheHooks: BufferCacheHooks;

  constructor(options?: SharedObjectStoreOptions) {
    super();
    // The directory is created by the first write, so importing this module (which happens under
    // an object-store driver too) never touches the disk.
    this.storageDir = options?.storageDir || resolveLocalStorageDir();
    this.maxCachedBytes = Math.max(0, options?.maxCachedBytes ?? DEFAULT_MAX_SHARED_CACHE_BYTES);
    this.cacheHooks = {
      get: (key) => {
        const hit = this.bufferCache.get(key);
        if (!hit) return undefined;
        this.bufferCache.delete(key);
        this.bufferCache.set(key, hit);
        return hit;
      },
      put: (key, buffer) => {
        this.evictCachedBuffer(key);
        if (buffer.byteLength > this.maxCachedBytes) return;
        while (this.cachedBytes + buffer.byteLength > this.maxCachedBytes && this.bufferCache.size > 0) {
          const oldestKey = this.bufferCache.keys().next().value;
          if (oldestKey === undefined) break;
          this.evictCachedBuffer(oldestKey);
        }
        this.bufferCache.set(key, buffer);
        this.cachedBytes += buffer.byteLength;
      },
    };
  }

  public getCachedBufferBytes(): number {
    return this.cachedBytes;
  }

  private evictCachedBuffer(key: string): void {
    const prev = this.bufferCache.get(key);
    if (prev !== undefined) {
      this.bufferCache.delete(key);
      this.cachedBytes = Math.max(0, this.cachedBytes - prev.byteLength);
    }
  }

  private bindCacheHooks(value: StoredObject): void {
    (value as CacheBindableStoredObject)[ATTACH_BUFFER_CACHE]?.(this.cacheHooks);
  }

  private rememberMetaKey(metaPath: string, key: string): void {
    const name = path.basename(metaPath);
    try {
      const st = fs.statSync(metaPath);
      if (!this.metaKeyCache.has(name) && this.metaKeyCache.size >= MAX_META_KEY_CACHE_ENTRIES) {
        const oldest = this.metaKeyCache.keys().next().value;
        if (oldest !== undefined) this.metaKeyCache.delete(oldest);
      }
      this.metaKeyCache.set(name, { mtimeMs: st.mtimeMs, size: st.size, key });
    } catch {
      this.metaKeyCache.delete(name);
    }
  }

  /** Drops the in-process metadata and cached buffer for `key` without unlinking disk files (used when another driver sweeps disk). */
  public evictInMemory(key: string): void {
    super.delete(key);
    this.evictCachedBuffer(key);
    this.metaKeyCache.delete(path.basename(this.getPathsForKey(key).metaPath));
  }

  public getStorageDir(): string {
    return this.storageDir;
  }

  /** Where the bytes of `key` live, which every process sharing the storage directory reads. */
  public objectPath(key: string): string {
    return this.getPathsForKey(key).binPath;
  }

  private getPathsForKey(key: string): ObjectPaths {
    return objectPathsFor(this.storageDir, key);
  }

  /**
   * Stores `value`: its buffer, or, when it names a file, the file that is already at `objectPath(key)`. A file
   * anywhere else is out of the other processes' reach, so it is refused. Throws when the bytes or the record cannot be
   * written; the bytes of a record that could not be written are removed.
   */
  public override set(key: string, value: StoredObject): this {
    const paths = this.getPathsForKey(key);
    if (value.filePath !== undefined && path.resolve(value.filePath) !== paths.binPath) {
      throw new Error(
        `The bytes of "${key}" are at "${value.filePath}", which only this process reads; store them at objectPath(key) first`
      );
    }
    fs.mkdirSync(this.storageDir, { recursive: true });
    if (value.filePath === undefined) {
      dropPreviousSave(paths);
      writeFileAtomicSync(paths.binPath, value.buffer);
    }
    writeRecord(paths, recordOf(value));
    this.evictCachedBuffer(key);
    this.bindCacheHooks(value);
    this.rememberMetaKey(paths.metaPath, key);
    super.set(key, value);
    return this;
  }

  /** Stores the file at `sourcePath` as `key`, moving it into the storage directory (see `commitObjectFile`). */
  public async storeFile(key: string, sourcePath: string, record: ObjectRecord, signal?: AbortSignal): Promise<StoredObject> {
    const paths = this.getPathsForKey(key);
    await commitObjectFile(paths, sourcePath, record, signal);
    const stored = fileBackedObject(record, paths.binPath);
    this.evictCachedBuffer(key);
    this.bindCacheHooks(stored);
    this.rememberMetaKey(paths.metaPath, key);
    super.set(key, stored);
    return stored;
  }

  public override get(key: string): StoredObject | undefined {
    const { metaPath, binPath } = this.getPathsForKey(key);

    const inMem = super.get(key);
    if (inMem) {
      if (inMem.expiresAt && Date.now() > inMem.expiresAt && this.renewedExpiry(inMem) < Date.now()) {
        this.delete(key);
        return undefined;
      }
      // Another process may have deleted it.
      if (!fs.existsSync(metaPath)) {
        this.evictInMemory(key);
        return undefined;
      }
      return inMem;
    }

    let record: ObjectRecord;
    try {
      record = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as ObjectRecord;
    } catch {
      return undefined;
    }
    if (record.expiresAt && Date.now() > record.expiresAt) {
      this.delete(key);
      return undefined;
    }
    const reconstructed = fileBackedObject(record, binPath);
    this.bindCacheHooks(reconstructed);
    this.rememberMetaKey(metaPath, key);
    super.set(key, reconstructed);
    return reconstructed;
  }

  /** The expiry written next to the object on the shared disk, which is what every process agrees on; undefined without it. */
  private diskExpiry(key: string): number | undefined {
    try {
      const expiresAt = (JSON.parse(fs.readFileSync(this.getPathsForKey(key).metaPath, 'utf-8')) as { expiresAt?: unknown }).expiresAt;
      return typeof expiresAt === 'number' ? expiresAt : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The expiry of a copy this process holds in memory, brought up to the one on the shared disk when another process
   * extended it (see `extendExpiry`). A process only looks at the disk once its own copy says the object expired.
   */
  public renewedExpiry(cached: Pick<StoredObject, 'key' | 'expiresAt'>): number {
    const shared = this.diskExpiry(cached.key);
    if (shared !== undefined && shared > cached.expiresAt) cached.expiresAt = shared;
    return cached.expiresAt;
  }

  /**
   * Raises the expiry of the object under `key` to `expiresAt`, in this process and in the file every process reads;
   * an expiry that is later already stays. Returns false when there is no such object. Throws when the file could not
   * be written (a full disk, say): then only this process keeps the object longer, and the caller must be told.
   */
  public extendExpiry(key: string, expiresAt: number): boolean {
    const cached = super.get(key);
    if (cached && cached.expiresAt < expiresAt) cached.expiresAt = expiresAt;
    const { metaPath } = this.getPathsForKey(key);
    let meta: { expiresAt?: number };
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as { expiresAt?: number };
    } catch {
      return cached !== undefined;
    }
    if (typeof meta.expiresAt === 'number' && meta.expiresAt >= expiresAt) return true;
    writeFileAtomicSync(metaPath, JSON.stringify({ ...meta, expiresAt }));
    return true;
  }

  /**
   * Removes what an interrupted save, assembly, copy or record update left next to the objects once nothing was written
   * to it for LEFTOVER_AGE_MS: its temporary files, and bytes whose record was never written (a save stopped between its
   * two renames). A writer that is alive writes or touches its file more often, and bytes are renamed into place with the
   * time of their save, just before their record.
   */
  public async sweepStaleTempFiles(now: number = Date.now()): Promise<number> {
    let names: string[];
    try {
      names = await fs.promises.readdir(this.storageDir);
    } catch {
      return 0;
    }
    const present = new Set(names);
    let removed = 0;
    for (const name of names) {
      const objectBytes = OBJECT_BYTES_NAME.exec(name);
      const recordless = objectBytes !== null && !present.has(`${objectBytes[1]}.meta.json`);
      if (!isTempFileName(name) && !recordless) continue;
      const filePath = path.join(this.storageDir, name);
      let modifiedAt: number;
      try {
        modifiedAt = (await fs.promises.stat(filePath)).mtimeMs;
      } catch {
        continue;
      }
      if (now - modifiedAt >= LEFTOVER_AGE_MS && (await removeLeftover(filePath))) removed++;
    }
    return removed;
  }

  /**
   * Removes the object under `key` only while the record on disk is the save `written` describes, so a save that learns
   * afterwards that it was aborted never removes what a later save of the key stored; the copy this process holds of
   * another save is dropped, so the next read goes to the disk. No await between the read and the removal.
   */
  public deleteIfStoredBy(key: string, written: SavedVersion): boolean {
    let onDisk: ObjectRecord;
    try {
      onDisk = JSON.parse(fs.readFileSync(this.getPathsForKey(key).metaPath, 'utf-8')) as ObjectRecord;
    } catch {
      return false;
    }
    if (onDisk.etag === written.etag && onDisk.uploadedAt === written.uploadedAt) return this.delete(key);
    super.delete(key);
    return false;
  }

  public stat(key: string): ObjectStat | null {
    const obj = this.get(key);
    if (!obj) return null;
    return {
      size: obj.size,
      etag: obj.etag,
      mimeType: obj.mimeType,
      filename: obj.filename,
      filePath: obj.filePath,
    };
  }

  public openReadStream(key: string, range?: { start: number; end: number }): fs.ReadStream | null {
    return this.getStream(key, range);
  }

  public getStream(key: string, range?: { start: number; end: number }): fs.ReadStream | null {
    const { metaPath, binPath } = this.getPathsForKey(key);
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as ObjectRecord;
      if (meta.expiresAt && Date.now() > meta.expiresAt) {
        this.delete(key);
        return null;
      }
      if (!fs.existsSync(binPath)) return null;
      const streamOpts: { start?: number; end?: number; highWaterMark: number } = {
        highWaterMark: 64 * 1024,
      };
      if (range) {
        if (typeof range.start === 'number') streamOpts.start = range.start;
        if (typeof range.end === 'number') streamOpts.end = range.end;
      }
      return fs.createReadStream(binPath, streamOpts);
    } catch {
      return null;
    }
  }

  public override has(key: string): boolean {
    const { metaPath } = this.getPathsForKey(key);
    if (fs.existsSync(metaPath)) return true;
    super.delete(key);
    return false;
  }

  public override delete(key: string): boolean {
    const memDeleted = super.delete(key);
    this.evictCachedBuffer(key);
    const { metaPath, binPath } = this.getPathsForKey(key);
    this.metaKeyCache.delete(path.basename(metaPath));
    let diskDeleted = false;

    try {
      if (fs.existsSync(metaPath)) {
        fs.unlinkSync(metaPath);
        diskDeleted = true;
      }
      if (fs.existsSync(binPath)) {
        fs.unlinkSync(binPath);
        diskDeleted = true;
      }
    } catch {
      // ignore
    }

    return memDeleted || diskDeleted;
  }

  private readCachedMetaKey(name: string): string | undefined {
    const metaPath = path.join(this.storageDir, name);
    try {
      const st = fs.statSync(metaPath);
      const cached = this.metaKeyCache.get(name);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.key;
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Partial<ObjectRecord>;
      if (typeof meta.key !== 'string') return undefined;
      if (!this.metaKeyCache.has(name) && this.metaKeyCache.size >= MAX_META_KEY_CACHE_ENTRIES) {
        const oldest = this.metaKeyCache.keys().next().value;
        if (oldest !== undefined) this.metaKeyCache.delete(oldest);
      }
      this.metaKeyCache.set(name, { mtimeMs: st.mtimeMs, size: st.size, key: meta.key });
      return meta.key;
    } catch {
      this.metaKeyCache.delete(name);
      return undefined;
    }
  }

  /** Removes every object in memory or on disk under `storageDir` whose key begins with `prefix`. */
  public deleteByPrefix(prefix: string): number {
    if (!prefix) return 0;
    const matched = new Set<string>();
    for (const key of super.keys()) {
      if (key.startsWith(prefix)) matched.add(key);
    }
    try {
      if (fs.existsSync(this.storageDir)) {
        for (const name of fs.readdirSync(this.storageDir)) {
          if (!name.endsWith('.meta.json')) continue;
          const entryKey = this.readCachedMetaKey(name);
          if (entryKey && entryKey.startsWith(prefix)) matched.add(entryKey);
        }
      }
    } catch {
      // ignore storage directory read errors
    }
    let count = 0;
    for (const key of matched) {
      if (this.delete(key)) count++;
    }
    return count;
  }

  public override clear(): void {
    super.clear();
    this.bufferCache.clear();
    this.cachedBytes = 0;
    this.metaKeyCache.clear();
    try {
      if (fs.existsSync(this.storageDir)) {
        const files = fs.readdirSync(this.storageDir);
        for (const f of files) {
          if (f.endsWith('.meta.json') || f.endsWith('.bin')) {
            try {
              fs.unlinkSync(path.join(this.storageDir, f));
            } catch {
              // ignore
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }
}

export const globalSharedObjects = new SharedObjectStore();

/**
 * Raises the expiry of the object under `key` for a backend that keeps objects in its own map next to the shared
 * store: in that map, and through `SharedObjectStore.extendExpiry` for every other process. False when neither has it. Throws when the shared file could not be written.
 */
export function extendStoredExpiry(own: ReadonlyMap<string, StoredObject>, key: string, expiresAt: number): boolean {
  const cached = own.get(key);
  if (cached && cached.expiresAt < expiresAt) cached.expiresAt = expiresAt;
  return globalSharedObjects.extendExpiry(key, expiresAt) || cached !== undefined;
}
