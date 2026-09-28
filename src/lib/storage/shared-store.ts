import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { StoredObject } from './oci-storage';

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
        metadata: value.metadata,
      };
      fs.writeFileSync(metaPath, JSON.stringify(meta), 'utf-8');

      if (value.buffer && Buffer.isBuffer(value.buffer)) {
        fs.writeFileSync(binPath, value.buffer);
      } else if (value.filePath && fs.existsSync(value.filePath) && value.filePath !== binPath) {
        fs.copyFileSync(value.filePath, binPath);
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

      let cachedBuffer: Buffer | null = null;
      const reconstructed: StoredObject = {
        key: meta.key,
        filename: meta.filename,
        mimeType: meta.mimeType,
        size: meta.size,
        etag: meta.etag,
        uploadedAt: meta.uploadedAt,
        expiresAt: meta.expiresAt,
        filePath: fs.existsSync(binPath) ? binPath : undefined,
        metadata: meta.metadata,
        get buffer(): Buffer {
          if (cachedBuffer) return cachedBuffer;
          if (fs.existsSync(binPath)) {
            cachedBuffer = fs.readFileSync(binPath);
            return cachedBuffer;
          }
          return Buffer.alloc(0);
        },
        set buffer(b: Buffer) {
          cachedBuffer = b;
        },
      };

      super.set(key, reconstructed);
      return reconstructed;
    } catch {
      return undefined;
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

