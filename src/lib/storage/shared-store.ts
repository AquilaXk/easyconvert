import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { StoredObject } from './oci-storage';
import {
  ObjectStat,
  PayloadTooLargeForMemoryError,
  StoredObjectMissingError,
  getMaxInMemoryBytes,
} from './errors';

/**
 * Enterprise Shared Object Store with Disk Spool Persistence.
 * Shared across S3, OCI, and unified storage adapters.
 * Guarantees zero split-brain between asynchronous job submission (Web API container)
 * and background container workers (easyconvert-oci-worker) by syncing to a shared disk volume.
 */
export class SharedObjectStore extends Map<string, StoredObject> {
  private readonly storageDir: string;

  constructor() {
    super();
    this.storageDir =
      process.env.EASYCONVERT_STORAGE_DIR || path.resolve(process.cwd(), '.easyconvert/storage');
    this.ensureDirectory();
  }

  private ensureDirectory(): void {
    try {
      if (!fs.existsSync(this.storageDir)) {
        fs.mkdirSync(this.storageDir, { recursive: true });
      }
    } catch {
      // In read-only or restricted environments, gracefully proceed
    }
  }

  public getStorageDir(): string {
    return this.storageDir;
  }

  private getPathsForKey(key: string): { metaPath: string; binPath: string } {
    const hash = crypto.createHash('sha256').update(key).digest('hex');
    return {
      metaPath: path.join(this.storageDir, `${hash}.meta.json`),
      binPath: path.join(this.storageDir, `${hash}.bin`),
    };
  }

  public override set(key: string, value: StoredObject): this {
    super.set(key, value);
    this.ensureDirectory();

    const { metaPath, binPath } = this.getPathsForKey(key);
    try {
      const meta = {
        key: value.key,
        filename: value.filename,
        mimeType: value.mimeType,
        size: value.size,
        etag: value.etag,
        uploadedAt: value.uploadedAt,
        expiresAt: value.expiresAt,
        filePath: value.filePath,
        metadata: value.metadata,
      };
      fs.writeFileSync(metaPath, JSON.stringify(meta), 'utf-8');

      if (value.filePath && fs.existsSync(value.filePath)) {
        if (value.filePath !== binPath && value.size <= 64 * 1024 * 1024) {
          try {
            fs.copyFileSync(value.filePath, binPath);
          } catch {}
        }
      } else {
        try {
          if (value.size <= getMaxInMemoryBytes() && value.buffer && Buffer.isBuffer(value.buffer)) {
            fs.writeFileSync(binPath, value.buffer);
          }
        } catch {
          // ignore
        }
      }
    } catch {
      // Disk write failure must not crash in-memory fallback
    }

    return this;
  }

  public override get(key: string): StoredObject | undefined {
    const { metaPath, binPath } = this.getPathsForKey(key);

    // 1. Check in-memory map
    const inMem = super.get(key);
    if (inMem) {
      if (inMem.expiresAt && Date.now() > inMem.expiresAt) {
        this.delete(key);
        return undefined;
      }
      // Invalidate in-memory cache if file was deleted on disk by another container/worker
      if (!fs.existsSync(metaPath)) {
        super.delete(key);
        return undefined;
      }
      return inMem;
    }

    // 2. Check shared disk storage (cross-process / multi-container sync)
    if (!fs.existsSync(metaPath)) {
      return undefined;
    }

    try {
      const rawMeta = fs.readFileSync(metaPath, 'utf-8');
      const meta = JSON.parse(rawMeta);

      if (meta.expiresAt && Date.now() > meta.expiresAt) {
        this.delete(key);
        return undefined;
      }

      let resolvedPath: string | undefined;
      if (fs.existsSync(binPath)) {
        resolvedPath = binPath;
      } else if (meta.filePath && fs.existsSync(meta.filePath)) {
        resolvedPath = meta.filePath;
      }

      const reconstructed: StoredObject = {
        key: meta.key,
        filename: meta.filename,
        mimeType: meta.mimeType,
        size: meta.size,
        etag: meta.etag,
        uploadedAt: meta.uploadedAt,
        expiresAt: meta.expiresAt,
        filePath: resolvedPath,
        metadata: meta.metadata,
        get buffer(): Buffer {
          if (meta.size > getMaxInMemoryBytes()) {
            throw new PayloadTooLargeForMemoryError(undefined, {
              size: meta.size,
              limit: getMaxInMemoryBytes(),
            });
          }
          if (resolvedPath && fs.existsSync(resolvedPath)) {
            return fs.readFileSync(resolvedPath);
          }
          throw new StoredObjectMissingError(undefined, { key: meta.key, filePath: resolvedPath || binPath });
        },
        set buffer(b: Buffer) {
          try {
            fs.writeFileSync(binPath, b);
          } catch {}
        },
      };

      super.set(key, reconstructed);
      return reconstructed;
    } catch {
      return undefined;
    }
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

  public async saveStream(
    key: string,
    stream: NodeJS.ReadableStream,
    meta: { filename: string; mimeType: string; size?: number },
    ttlMs: number = 24 * 60 * 60 * 1000
  ): Promise<StoredObject> {
    this.ensureDirectory();
    const { metaPath, binPath } = this.getPathsForKey(key);
    const tempPath = `${binPath}.tmp.${crypto.randomUUID()}`;
    const outFd = fs.openSync(tempPath, 'w');
    const hasher = crypto.createHash('sha256');
    let totalBytes = 0;

    try {
      await new Promise<void>((resolve, reject) => {
        stream.on('data', (chunk: Buffer | string) => {
          try {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            fs.writeSync(outFd, buf, 0, buf.length, null);
            hasher.update(buf);
            totalBytes += buf.length;
          } catch (err) {
            reject(err);
          }
        });
        stream.on('end', () => resolve());
        stream.on('error', (err) => reject(err));
      });
      fs.fsyncSync(outFd);
    } finally {
      fs.closeSync(outFd);
    }

    fs.renameSync(tempPath, binPath);

    const etag = `"${hasher.digest('hex').slice(0, 32)}"`;
    const now = Date.now();
    const storedMeta = {
      key,
      filename: meta.filename,
      mimeType: meta.mimeType,
      size: totalBytes,
      etag,
      uploadedAt: now,
      expiresAt: now + ttlMs,
    };
    fs.writeFileSync(metaPath, JSON.stringify(storedMeta), 'utf-8');

    let cachedBuffer: Buffer | null = null;
    const stored: StoredObject = {
      ...storedMeta,
      filePath: binPath,
      get buffer(): Buffer {
        if (totalBytes > getMaxInMemoryBytes()) {
          throw new PayloadTooLargeForMemoryError(undefined, {
            size: totalBytes,
            limit: getMaxInMemoryBytes(),
          });
        }
        if (cachedBuffer) return cachedBuffer;
        if (fs.existsSync(binPath)) {
          cachedBuffer = fs.readFileSync(binPath);
          return cachedBuffer;
        }
        throw new StoredObjectMissingError(undefined, { key, filePath: binPath });
      },
    };

    super.set(key, stored);
    return stored;
  }

  public getStream(key: string, range?: { start: number; end: number }): fs.ReadStream | null {
    const { metaPath, binPath } = this.getPathsForKey(key);
    if (!fs.existsSync(metaPath)) {
      return null;
    }
    try {
      const rawMeta = fs.readFileSync(metaPath, 'utf-8');
      const meta = JSON.parse(rawMeta);
      if (meta.expiresAt && Date.now() > meta.expiresAt) {
        this.delete(key);
        return null;
      }
      let targetPath: string | undefined;
      if (fs.existsSync(binPath)) {
        targetPath = binPath;
      } else if (meta.filePath && fs.existsSync(meta.filePath)) {
        targetPath = meta.filePath;
      }

      if (!targetPath) return null;

      const streamOpts: { start?: number; end?: number; highWaterMark: number } = {
        highWaterMark: 64 * 1024,
      };
      if (range) {
        if (typeof range.start === 'number') streamOpts.start = range.start;
        if (typeof range.end === 'number') streamOpts.end = range.end;
      }
      return fs.createReadStream(targetPath, streamOpts);
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

