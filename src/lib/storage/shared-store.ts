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
import { isTempFileName, LEFTOVER_AGE_MS, moveIntoPlace, removeLeftover, writeFileAtomicSync } from './temp-file';

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
 * Stores the file at `sourcePath` as the object `paths` names, in the order an object store server stores a part
 * (the files of an earlier save are removed, the bytes are renamed into place, then the record is written): at every
 * point a reader finds the earlier object, no object, or this one, and never these bytes under an earlier record.
 */
export async function commitObjectFile(paths: ObjectPaths, sourcePath: string, record: ObjectRecord): Promise<void> {
  dropPreviousSave(paths, sourcePath);
  await moveIntoPlace(sourcePath, paths.binPath);
  writeRecord(paths, recordOf(record));
}

/** The object of `record` whose bytes are the file `binPath`, read into memory only when asked and within the in-memory limit. */
export function fileBackedObject(record: ObjectRecord, binPath: string): StoredObject {
  let cachedBuffer: Buffer | null = null;
  return {
    ...recordOf(record),
    filePath: binPath,
    get buffer(): Buffer {
      if (record.size > getMaxInMemoryBytes()) {
        throw new PayloadTooLargeForMemoryError(undefined, { size: record.size, limit: getMaxInMemoryBytes() });
      }
      if (cachedBuffer) return cachedBuffer;
      if (fs.existsSync(binPath)) {
        cachedBuffer = fs.readFileSync(binPath);
        return cachedBuffer;
      }
      throw new StoredObjectMissingError(undefined, { key: record.key, filePath: binPath });
    },
    set buffer(b: Buffer) {
      cachedBuffer = b;
    },
  };
}

/**
 * The objects of the local driver, in the storage directory that the web process and the workers share: what one
 * process stores, every other reads. The map holds the objects this process saw, the disk is what every process
 * agrees on.
 */
export class SharedObjectStore extends Map<string, StoredObject> {
  private readonly storageDir: string;

  constructor() {
    super();
    // The directory is created by the first write, so importing this module (which happens under
    // an object-store driver too) never touches the disk.
    this.storageDir = resolveLocalStorageDir();
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
    super.set(key, value);
    return this;
  }

  /** Stores the file at `sourcePath` as `key`, moving it into the storage directory (see `commitObjectFile`). */
  public async storeFile(key: string, sourcePath: string, record: ObjectRecord): Promise<StoredObject> {
    const paths = this.getPathsForKey(key);
    await commitObjectFile(paths, sourcePath, record);
    const stored = fileBackedObject(record, paths.binPath);
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
        super.delete(key);
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
   * Removes the temporary files an interrupted save, assembly, copy or record update left next to the objects, once
   * nothing was written to them for LEFTOVER_AGE_MS. A writer that is alive writes or touches its file more often.
   */
  public sweepStaleTempFiles(now: number = Date.now()): number {
    let names: string[];
    try {
      names = fs.readdirSync(this.storageDir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      if (!isTempFileName(name)) continue;
      const filePath = path.join(this.storageDir, name);
      let modifiedAt: number;
      try {
        modifiedAt = fs.statSync(filePath).mtimeMs;
      } catch {
        continue;
      }
      if (now - modifiedAt >= LEFTOVER_AGE_MS && removeLeftover(filePath)) removed++;
    }
    return removed;
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
    const { metaPath, binPath } = this.getPathsForKey(key);
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

  public override clear(): void {
    super.clear();
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
