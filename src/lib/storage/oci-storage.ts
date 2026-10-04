import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MultipartUploadInit, UploadedPart, MultipartUploadComplete } from '../types';
import { presignSigV4QueryUrl } from './sigv4-presigner';
import { secureShredBuffer } from '../security/memory-shredder';
import {
  ObjectStat,
  PayloadTooLargeForMemoryError,
  StoredObjectMissingError,
  getMaxInMemoryBytes,
} from './errors';

export * from './errors';

export interface OciStorageConfig {
  namespace: string;
  bucketName: string;
  region: string;
  endpoint?: string;
}

interface OciMultipartSession {
  uploadId: string;
  key: string;
  filename: string;
  mimeType: string;
  totalSize: number;
  partSize: number;
  totalParts: number;
  createdAt: number;
  namespace: string;
  bucket: string;
  diskDir: string;
  parts: Map<number, { filePath: string; etag: string; size: number; readonly buffer: Buffer }>;
}

export interface StoredObject {
  key: string;
  filename: string;
  mimeType: string;
  buffer: Buffer;
  size: number;
  etag: string;
  namespace?: string;
  bucket?: string;
  uploadedAt: number;
  expiresAt: number;
  filePath?: string;
  metadata?: Record<string, string>;
}

export type OciStoredObject = StoredObject;

export interface PresignedUrlResult {
  url: string;
  expiresAt: number;
  signature: string;
}

export interface IStorageBackend {
  readonly providerName: string;
  initiateMultipartUpload(filename: string, mimeType: string, totalSize: number, ownerUserId?: string): MultipartUploadInit;
  uploadPart(uploadId: string, partNumber: number, buffer: Buffer): UploadedPart;
  completeMultipartUpload(uploadId: string, expectedParts?: { partNumber: number; etag?: string }[]): MultipartUploadComplete;
  abortMultipartUpload(uploadId: string): boolean;
  saveObject(key: string, buffer: Buffer, mimeType: string, filename: string, ttlMs?: number): StoredObject;
  saveObjectFromFile?(key: string, filePath: string, mimeType: string, filename: string, ttlMs?: number): StoredObject;
  saveObjectFromStream(
    key: string,
    stream: NodeJS.ReadableStream,
    meta: { filename: string; mimeType: string; size?: number },
    ttlMs?: number
  ): Promise<StoredObject>;
  getObject(key: string): StoredObject | undefined;
  stat(key: string): ObjectStat | null;
  openReadStream(key: string, range?: { start: number; end: number }): NodeJS.ReadableStream | null;
  getObjectStream?(key: string, range?: { start: number; end: number }): fs.ReadStream | null;
  deleteObject(key: string): boolean;
  getActiveSessionsCount(): number;
  getObjectsCount(): number;
  sweepExpiredObjects?(now?: number): number;
  stopGc?(): void;
  generatePresignedUploadUrl?(key: string, partNumber: number, uploadId: string, expiresInSeconds?: number): PresignedUrlResult;
  generatePresignedUploadPartUrl?(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds?: number,
    localEmulation?: boolean
  ): PresignedUrlResult;
  generatePresignedHmacPartUrl?(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds?: number
  ): PresignedUrlResult;
  generatePresignedDownloadUrl?(key: string, expiresInSeconds?: number): PresignedUrlResult;
  verifyPresignedSignature?(
    method: 'GET' | 'PUT',
    key: string,
    expiresAt: number,
    signature: string,
    uploadId?: string,
    partNumber?: number
  ): boolean;
  getSigningSecret?(): string;
}

import { globalSharedObjects } from './shared-store';

/**
 * Oracle Cloud Infrastructure (OCI) Object Storage Service
 * Implements OCI Native Object Storage Multipart & OCI S3-Compatibility API.
 */
export class OciObjectStorageService implements IStorageBackend {
  readonly providerName: string = 'oci';
  private sessions = new Map<string, OciMultipartSession>();
  private objects = new Map<string, OciStoredObject>();
  readonly config: OciStorageConfig;
  private readonly signingSecret: string;

  // OCI Object Storage recommended minimum part size: 5MB
  readonly DEFAULT_PART_SIZE = 5 * 1024 * 1024; // 5 MB

  private gcTimer: NodeJS.Timeout | null = null;

  constructor(customConfig?: Partial<OciStorageConfig>, options?: { signingSecret?: string }) {
    const namespace = customConfig?.namespace || process.env.OCI_NAMESPACE;
    if (!namespace && process.env.NODE_ENV === 'production' && process.env.NEXT_PHASE !== 'phase-production-build') {
      throw new Error('Missing required OCI_NAMESPACE environment variable in production');
    }
    const resolvedNamespace = namespace || 'default';
    const region = customConfig?.region || process.env.OCI_REGION || 'ap-seoul-1';
    const bucketName = customConfig?.bucketName || process.env.OCI_BUCKET_NAME || 'easyconvert-transcode-bucket';
    const endpoint =
      customConfig?.endpoint ||
      process.env.OCI_ENDPOINT ||
      `https://${resolvedNamespace}.compat.objectstorage.${region}.oraclecloud.com`;

    this.config = {
      namespace: resolvedNamespace,
      bucketName,
      region,
      endpoint,
    };

    const secret =
      options?.signingSecret ||
      process.env.STORAGE_SIGNING_SECRET ||
      process.env.OCI_SIGNING_SECRET;

    if (!secret) {
      if (process.env.NODE_ENV === 'production' && process.env.NEXT_PHASE !== 'phase-production-build') {
        throw new Error('Missing required STORAGE_SIGNING_SECRET or OCI_SIGNING_SECRET environment variable in production');
      }
      this.signingSecret = crypto.randomBytes(32).toString('hex');
    } else {
      this.signingSecret = secret;
    }

    this.gcTimer = setInterval(() => {
      this.sweepExpiredObjects();
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

  /**
   * Cryptographically wipes in-memory buffer before releasing references.
   */
  private shredBuffer(buf?: Buffer): void {
    if (!buf) return;
    secureShredBuffer(buf, 2);
  }

  /**
   * Initiate OCI Multipart Upload (OCI API: CreateMultipartUpload)
   */
  initiateMultipartUpload(filename: string, mimeType: string, totalSize: number): MultipartUploadInit {
    const uploadId = `oci_mp_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = `n/${this.config.namespace}/b/${this.config.bucketName}/o/${Date.now()}_${safeName}`;

    const partSize =
      totalSize > 50 * 1024 * 1024
        ? this.DEFAULT_PART_SIZE
        : Math.max(1024 * 1024, Math.ceil(totalSize / 10));
    const totalParts = Math.max(1, Math.ceil(totalSize / partSize));

    const diskDir = path.join(os.tmpdir(), 'easyconvert_oci_chunks', uploadId);
    try {
      if (!fs.existsSync(diskDir)) {
        fs.mkdirSync(diskDir, { recursive: true });
      }
    } catch {}

    const session: OciMultipartSession = {
      uploadId,
      key,
      filename,
      mimeType,
      totalSize,
      partSize,
      totalParts,
      createdAt: Date.now(),
      namespace: this.config.namespace,
      bucket: this.config.bucketName,
      diskDir,
      parts: new Map(),
    };

    this.sessions.set(uploadId, session);

    return {
      uploadId,
      key,
      partSize,
      totalParts,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    };
  }

  /**
   * Upload an individual chunk part to OCI Object Storage (OCI API: UploadPart)
   */
  uploadPart(uploadId: string, partNumber: number, buffer: Buffer): UploadedPart {
    const session = this.sessions.get(uploadId);
    if (!session) {
      throw new Error(`Invalid or expired OCI Object Storage uploadId: "${uploadId}"`);
    }

    if (partNumber < 1 || partNumber > 10000) {
      throw new Error(`Invalid OCI partNumber: ${partNumber}. Must be between 1 and 10000.`);
    }

    // Disk-backed chunk streaming (Zero-Heap Ingestion)
    const partFileName = `part-${partNumber}.bin`;
    const partFilePath = path.join(session.diskDir, partFileName);
    fs.writeFileSync(partFilePath, buffer);

    // Compute standard MD5 ETag
    const md5 = crypto.createHash('md5').update(buffer).digest('hex');
    const etag = `"${md5}"`;

    session.parts.set(partNumber, {
      filePath: partFilePath,
      etag,
      size: buffer.length,
      get buffer(): Buffer {
        return fs.existsSync(partFilePath) ? fs.readFileSync(partFilePath) : Buffer.alloc(0);
      },
    });

    return {
      partNumber,
      etag,
      size: buffer.length,
    };
  }

  /**
   * Commit OCI Multipart Upload (OCI API: CommitMultipartUpload)
   */
  completeMultipartUpload(
    uploadId: string,
    expectedParts?: { partNumber: number; etag?: string }[]
  ): MultipartUploadComplete {
    const session = this.sessions.get(uploadId);
    if (!session) {
      throw new Error(`OCI upload session "${uploadId}" not found or already committed.`);
    }

    const partNumbers = expectedParts
      ? expectedParts.map((p) => p.partNumber).sort((a, b) => a - b)
      : Array.from(session.parts.keys()).sort((a, b) => a - b);

    if (partNumbers.length === 0) {
      throw new Error('Cannot commit OCI multipart upload with zero uploaded parts.');
    }

    const ociDir = path.join(os.tmpdir(), 'easyconvert_oci_objects');
    try {
      if (!fs.existsSync(ociDir)) {
        fs.mkdirSync(ociDir, { recursive: true });
      }
    } catch {}

    const finalFilePath = path.join(ociDir, `${session.uploadId}.bin`);
    const outFd = fs.openSync(finalFilePath, 'w');
    const etagHashes: Buffer[] = [];
    const chunkBuf = Buffer.alloc(64 * 1024);
    let totalSize = 0;

    try {
      for (const num of partNumbers) {
        const part = session.parts.get(num);
        if (!part) {
          throw new Error(`Missing part number ${num} in OCI upload session.`);
        }
        if (!fs.existsSync(part.filePath)) {
          console.error(`Part file missing on disk: "${part.filePath}"`);
          throw new Error(`Part file missing on disk for part ${num}`);
        }
        const inFd = fs.openSync(part.filePath, 'r');
        let bytesRead = 0;
        try {
          while ((bytesRead = fs.readSync(inFd, chunkBuf, 0, chunkBuf.length, null)) > 0) {
            fs.writeSync(outFd, chunkBuf, 0, bytesRead);
          }
        } finally {
          fs.closeSync(inFd);
        }
        totalSize += part.size;
        const rawMd5 = part.etag.replace(/"/g, '');
        etagHashes.push(Buffer.from(rawMd5, 'hex'));
      }
    } finally {
      fs.closeSync(outFd);
    }

    // OCI composite hash
    const compositeHash = crypto.createHash('md5').update(Buffer.concat(etagHashes)).digest('hex');
    const compositeEtag = `"${compositeHash}-${partNumbers.length}"`;

    const now = Date.now();
    let cachedBuffer: Buffer | null = null;
    const stored: OciStoredObject = {
      key: session.key,
      filename: session.filename,
      mimeType: session.mimeType,
      size: totalSize,
      etag: compositeEtag,
      namespace: session.namespace,
      bucket: session.bucket,
      uploadedAt: now,
      expiresAt: now + 60 * 60 * 1000, // 1-hour TTL
      filePath: finalFilePath,
      get buffer(): Buffer {
        if (totalSize > getMaxInMemoryBytes()) {
          throw new PayloadTooLargeForMemoryError(undefined, {
            size: totalSize,
            limit: getMaxInMemoryBytes(),
          });
        }
        if (cachedBuffer) return cachedBuffer;
        if (fs.existsSync(finalFilePath)) {
          cachedBuffer = fs.readFileSync(finalFilePath);
          return cachedBuffer;
        }
        throw new StoredObjectMissingError(undefined, { key: session.key, filePath: finalFilePath });
      },
    };

    // Clean up temporary disk chunk directory
    try {
      if (fs.existsSync(session.diskDir)) {
        fs.rmSync(session.diskDir, { recursive: true, force: true });
      }
    } catch {}
    session.parts.clear();

    this.objects.set(session.key, stored);
    globalSharedObjects.set(session.key, stored);
    this.sessions.delete(uploadId);

    return {
      location: `/api/storage/file/${encodeURIComponent(session.key)}`,
      key: session.key,
      size: totalSize,
      etag: compositeEtag,
    };
  }

  /**
   * Abort OCI Multipart Upload (OCI API: AbortMultipartUpload)
   */
  abortMultipartUpload(uploadId: string): boolean {
    const session = this.sessions.get(uploadId);
    if (!session) return false;
    try {
      if (fs.existsSync(session.diskDir)) {
        fs.rmSync(session.diskDir, { recursive: true, force: true });
      }
    } catch {}
    session.parts.clear();
    return this.sessions.delete(uploadId);
  }

  /**
   * Save complete object directly into OCI Object Storage with 1-hour default TTL
   */
  saveObject(
    key: string,
    buffer: Buffer,
    mimeType: string,
    filename: string,
    ttlMs: number = 60 * 60 * 1000
  ): OciStoredObject {
    const md5 = crypto.createHash('md5').update(buffer).digest('hex');
    const ociKey = key.startsWith('n/') ? key : `n/${this.config.namespace}/b/${this.config.bucketName}/o/${key}`;
    const now = Date.now();
    const stored: OciStoredObject = {
      key: ociKey,
      filename,
      mimeType,
      buffer,
      size: buffer.length,
      etag: `"${md5}"`,
      namespace: this.config.namespace,
      bucket: this.config.bucketName,
      uploadedAt: now,
      expiresAt: now + ttlMs,
    };
    this.objects.set(ociKey, stored);
    globalSharedObjects.set(ociKey, stored);
    // Also index by raw key for convenient lookup
    if (key !== ociKey) {
      this.objects.set(key, stored);
      globalSharedObjects.set(key, stored);
    }
    return stored;
  }

  /**
   * Save complete object from local disk file path into OCI Object Storage with 1-hour default TTL (Zero-Heap)
   */
  saveObjectFromFile(
    key: string,
    filePath: string,
    mimeType: string,
    filename: string,
    ttlMs: number = 60 * 60 * 1000
  ): OciStoredObject {
    const stat = fs.statSync(filePath);
    const ociKey = key.startsWith('n/') ? key : `n/${this.config.namespace}/b/${this.config.bucketName}/o/${key}`;
    const now = Date.now();
    let cachedBuffer: Buffer | null = null;
    const stored: OciStoredObject = {
      key: ociKey,
      filename,
      mimeType,
      size: stat.size,
      etag: `"${crypto.createHash('sha256').update(filePath + stat.mtimeMs).digest('hex').slice(0, 32)}"`,
      namespace: this.config.namespace,
      bucket: this.config.bucketName,
      uploadedAt: now,
      expiresAt: now + ttlMs,
      filePath,
      get buffer(): Buffer {
        if (stat.size > getMaxInMemoryBytes()) {
          throw new PayloadTooLargeForMemoryError(undefined, {
            size: stat.size,
            limit: getMaxInMemoryBytes(),
          });
        }
        if (cachedBuffer) return cachedBuffer;
        if (fs.existsSync(filePath)) {
          cachedBuffer = fs.readFileSync(filePath);
          return cachedBuffer;
        }
        throw new StoredObjectMissingError(undefined, { key: ociKey, filePath });
      },
      set buffer(b: Buffer) {
        cachedBuffer = b;
      },
    };
    this.objects.set(ociKey, stored);
    globalSharedObjects.set(ociKey, stored);
    if (key !== ociKey) {
      this.objects.set(key, stored);
      globalSharedObjects.set(key, stored);
    }
    return stored;
  }

  /**
   * Retrieve stored object by key with lazy expiration check
   */
  getObject(key: string): OciStoredObject | undefined {
    const obj = this.objects.get(key) || globalSharedObjects.get(key);
    if (!obj) return undefined;

    // Lazy expiration eviction
    if (Date.now() > obj.expiresAt) {
      this.deleteObject(key);
      return undefined;
    }

    return obj;
  }

  /**
   * Delete object from OCI Object Storage and cryptographically shred buffer
   */
  deleteObject(key: string): boolean {
    const obj = this.objects.get(key) || (globalSharedObjects.get(key) as OciStoredObject | undefined);
    const sharedDeleted = globalSharedObjects.delete(key);
    if (!obj && !sharedDeleted) return false;

    if (obj) {
      if (obj.filePath && fs.existsSync(obj.filePath)) {
        try {
          fs.rmSync(obj.filePath, { force: true });
        } catch {}
      }

      this.shredBuffer(obj.buffer);
      this.objects.delete(key);
      if (obj.key && obj.key !== key) {
        this.objects.delete(obj.key);
        globalSharedObjects.delete(obj.key);
      }
    }
    return true;
  }

  /**
   * Sweeps expired objects from memory and shreds their buffers in bulk
   */
  sweepExpiredObjects(now: number = Date.now()): number {
    let count = 0;
    const expiredKeys = new Set<string>();

    for (const [key, obj] of this.objects.entries()) {
      if (now > obj.expiresAt) {
        expiredKeys.add(key);
        if (obj.key) expiredKeys.add(obj.key);
      }
    }

    const shreddedObjects = new Set<OciStoredObject>();
    for (const key of expiredKeys) {
      const obj = this.objects.get(key);
      if (obj) {
        if (!shreddedObjects.has(obj)) {
          if (obj.filePath && fs.existsSync(obj.filePath)) {
            try {
              fs.rmSync(obj.filePath, { force: true });
            } catch {}
          }
          if (obj.size <= getMaxInMemoryBytes()) {
            try {
              this.shredBuffer(obj.buffer);
            } catch {}
          }
          shreddedObjects.add(obj);
          count++;
        }
        this.objects.delete(key);
      }
    }

    return count;
  }

  /**
   * Returns metadata and stats for stored object without loading it into heap
   */
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

  /**
   * Retrieves streaming reader for stored object (standard IStorageBackend interface)
   */
  openReadStream(key: string, range?: { start: number; end: number }): fs.ReadStream | null {
    return this.getObjectStream(key, range);
  }

  /**
   * Retrieves streaming reader for stored object with optional byte range support (alias)
   */
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

  /**
   * Streams data directly into a temporary file on disk, fsyncs, renames atomically, and indexes
   */
  async saveObjectFromStream(
    key: string,
    stream: NodeJS.ReadableStream,
    meta: { filename: string; mimeType: string; size?: number },
    ttlMs: number = 60 * 60 * 1000
  ): Promise<OciStoredObject> {
    const objectsDir = path.join(os.tmpdir(), 'easyconvert_oci_objects');
    if (!fs.existsSync(objectsDir)) {
      try {
        fs.mkdirSync(objectsDir, { recursive: true });
      } catch {}
    }
    const tempFilePath = path.join(objectsDir, `stream-${crypto.randomUUID()}.tmp`);
    const finalFilePath = path.join(objectsDir, `oci-${crypto.randomUUID()}-${path.basename(meta.filename)}`);

    const outFd = fs.openSync(tempFilePath, 'w');
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

    fs.renameSync(tempFilePath, finalFilePath);

    const etag = `"${hasher.digest('hex').slice(0, 32)}"`;
    const ociKey = key.startsWith('n/') ? key : `n/${this.config.namespace}/b/${this.config.bucketName}/o/${key}`;
    const now = Date.now();
    let cachedBuffer: Buffer | null = null;

    const stored: OciStoredObject = {
      key: ociKey,
      filename: meta.filename,
      mimeType: meta.mimeType,
      size: totalBytes,
      etag,
      namespace: this.config.namespace,
      bucket: this.config.bucketName,
      uploadedAt: now,
      expiresAt: now + ttlMs,
      filePath: finalFilePath,
      get buffer(): Buffer {
        if (totalBytes > getMaxInMemoryBytes()) {
          throw new PayloadTooLargeForMemoryError(undefined, {
            size: totalBytes,
            limit: getMaxInMemoryBytes(),
          });
        }
        if (cachedBuffer) return cachedBuffer;
        if (fs.existsSync(finalFilePath)) {
          cachedBuffer = fs.readFileSync(finalFilePath);
          return cachedBuffer;
        }
        throw new StoredObjectMissingError(undefined, { key: ociKey, filePath: finalFilePath });
      },
    };

    this.objects.set(ociKey, stored);
    globalSharedObjects.set(ociKey, stored);
    if (key !== ociKey) {
      this.objects.set(key, stored);
      globalSharedObjects.set(key, stored);
    }

    return stored;
  }

  getActiveSessionsCount(): number {
    return this.sessions.size;
  }

  getObjectsCount(): number {
    return new Set(this.objects.values()).size;
  }

  /**
   * Generates a signed Presigned Upload URL for direct client-to-storage multipart chunk PUT
   */
  generatePresignedUploadUrl(
    key: string,
    partNumber: number,
    uploadId: string,
    expiresInSeconds: number = 3600
  ): PresignedUrlResult {
    const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const stringToSign = `PUT\n${key}\n${uploadId}\n${partNumber}\n${expiresAt}`;
    const signature = crypto.createHmac('sha256', this.signingSecret).update(stringToSign).digest('hex');
    const endpoint = this.config.endpoint || 'https://storage.easyconvert.app';
    const url = `${endpoint}/${key}?uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}&expires=${expiresAt}&signature=${signature}`;
    return { url, expiresAt, signature };
  }

  /**
   * Generates a signed Presigned Download URL for secure time-limited direct object retrieval
   */
  generatePresignedDownloadUrl(
    key: string,
    expiresInSeconds: number = 3600
  ): PresignedUrlResult {
    const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const stringToSign = `GET\n${key}\n${expiresAt}`;
    const signature = crypto.createHmac('sha256', this.signingSecret).update(stringToSign).digest('hex');
    const endpoint = this.config.endpoint || 'https://storage.easyconvert.app';
    const url = `${endpoint}/${key}?expires=${expiresAt}&signature=${signature}`;
    return { url, expiresAt, signature };
  }

  /**
   * Verifies authenticity of a signed presigned request
   */
  verifyPresignedSignature(
    method: 'GET' | 'PUT',
    key: string,
    expiresAt: number,
    signature: string,
    uploadId?: string,
    partNumber?: number
  ): boolean {
    if (Math.floor(Date.now() / 1000) > expiresAt) return false;
    const stringToSign =
      method === 'PUT'
        ? `PUT\n${key}\n${uploadId || ''}\n${partNumber ?? ''}\n${expiresAt}`
        : `GET\n${key}\n${expiresAt}`;
    const expectedSig = crypto.createHmac('sha256', this.signingSecret).update(stringToSign).digest('hex');
    try {
      const sigBuf = Buffer.from(signature, 'hex');
      const expectedBuf = Buffer.from(expectedSig, 'hex');
      if (sigBuf.length !== expectedBuf.length) return false;
      return crypto.timingSafeEqual(sigBuf, expectedBuf);
    } catch {
      return false;
    }
  }

  getSigningSecret(): string {
    return this.signingSecret;
  }

  generatePresignedUploadPartUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds: number = 900,
    localEmulation: boolean = false
  ): PresignedUrlResult {
    const region = this.config.region || 'us-east-1';
    const accessKeyId = 'DEV_ACCESS_KEY_ID';
    const endpoint = localEmulation
      ? (process.env.APP_URL || 'http://localhost:3000') + '/api/v1/uploads/direct/part'
      : (this.config.endpoint || 'https://storage.easyconvert.app') + `/${key}`;

    const queryParams: Record<string, string | number> = {
      uploadId,
      partNumber,
    };
    if (localEmulation) {
      queryParams.key = key;
    }

    const res = presignSigV4QueryUrl({
      method: 'PUT',
      url: endpoint,
      queryParams,
      credentials: {
        accessKeyId,
        secretAccessKey: this.signingSecret,
        region,
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
    const signature = crypto.createHmac('sha256', this.signingSecret).update(stringToSign).digest('hex');
    const baseUrl = (process.env.APP_URL || 'http://localhost:3000') + '/api/v1/uploads/direct/part';
    const url = `${baseUrl}?uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}&key=${encodeURIComponent(key)}&expiresAt=${expiresAt}&signature=${signature}`;
    return { url, expiresAt, signature };
  }
}

/**
 * Standard S3-Compatible Cloud Storage Backend (AWS S3, MinIO, Cloudflare R2).
 */
export class S3CompatibleStorageBackend implements IStorageBackend {
  readonly providerName: string = 's3-compatible';
  private backend: OciObjectStorageService;

  constructor() {
    this.backend = new OciObjectStorageService();
  }

  initiateMultipartUpload(filename: string, mimeType: string, totalSize: number): MultipartUploadInit {
    return this.backend.initiateMultipartUpload(filename, mimeType, totalSize);
  }

  uploadPart(uploadId: string, partNumber: number, buffer: Buffer): UploadedPart {
    return this.backend.uploadPart(uploadId, partNumber, buffer);
  }

  completeMultipartUpload(
    uploadId: string,
    expectedParts?: { partNumber: number; etag?: string }[]
  ): MultipartUploadComplete {
    return this.backend.completeMultipartUpload(uploadId, expectedParts);
  }

  abortMultipartUpload(uploadId: string): boolean {
    return this.backend.abortMultipartUpload(uploadId);
  }

  saveObject(key: string, buffer: Buffer, mimeType: string, filename: string, ttlMs?: number): StoredObject {
    return this.backend.saveObject(key, buffer, mimeType, filename, ttlMs);
  }

  saveObjectFromStream(
    key: string,
    stream: NodeJS.ReadableStream,
    meta: { filename: string; mimeType: string; size?: number },
    ttlMs?: number
  ): Promise<StoredObject> {
    return this.backend.saveObjectFromStream(key, stream, meta, ttlMs);
  }

  getObject(key: string): StoredObject | undefined {
    return this.backend.getObject(key);
  }

  stat(key: string): ObjectStat | null {
    return this.backend.stat(key);
  }

  openReadStream(key: string, range?: { start: number; end: number }): fs.ReadStream | null {
    return this.backend.openReadStream(key, range);
  }

  getObjectStream(key: string, range?: { start: number; end: number }): fs.ReadStream | null {
    return this.backend.getObjectStream(key, range);
  }

  deleteObject(key: string): boolean {
    return this.backend.deleteObject(key);
  }

  sweepExpiredObjects(now?: number): number {
    return this.backend.sweepExpiredObjects(now);
  }

  stopGc(): void {
    this.backend.stopGc();
  }

  getActiveSessionsCount(): number {
    return this.backend.getActiveSessionsCount();
  }

  getObjectsCount(): number {
    return this.backend.getObjectsCount();
  }

  generatePresignedUploadUrl(
    key: string,
    partNumber: number,
    uploadId: string,
    expiresInSeconds?: number
  ): PresignedUrlResult {
    return this.backend.generatePresignedUploadUrl(key, partNumber, uploadId, expiresInSeconds);
  }

  generatePresignedDownloadUrl(key: string, expiresInSeconds?: number): PresignedUrlResult {
    return this.backend.generatePresignedDownloadUrl(key, expiresInSeconds);
  }

  verifyPresignedSignature(
    method: 'GET' | 'PUT',
    key: string,
    expiresAt: number,
    signature: string,
    uploadId?: string,
    partNumber?: number
  ): boolean {
    return this.backend.verifyPresignedSignature(method, key, expiresAt, signature, uploadId, partNumber);
  }

  getSigningSecret(): string {
    return this.backend.getSigningSecret();
  }

  generatePresignedUploadPartUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds?: number,
    localEmulation?: boolean
  ): PresignedUrlResult {
    return this.backend.generatePresignedUploadPartUrl(key, uploadId, partNumber, expiresInSeconds, localEmulation);
  }

  generatePresignedHmacPartUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds?: number
  ): PresignedUrlResult {
    return this.backend.generatePresignedHmacPartUrl(key, uploadId, partNumber, expiresInSeconds);
  }
}

export const ociStorage: IStorageBackend = new OciObjectStorageService();
// Backward-compatible alias
export const s3Storage: IStorageBackend = ociStorage;

/**
 * Factory for resolving storage backend provider.
 */
export function getStorageBackend(provider: 'oci' | 's3' | 'memory' = 'oci'): IStorageBackend {
  if (provider === 's3') {
    return new S3CompatibleStorageBackend();
  }
  return ociStorage;
}
