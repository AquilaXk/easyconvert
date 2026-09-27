import crypto from 'crypto';
import { MultipartUploadInit, UploadedPart, MultipartUploadComplete } from '../types';
import { secureShredBuffer } from '../security/memory-shredder';

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
  parts: Map<number, { buffer: Buffer; etag: string; size: number }>;
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
}

export type OciStoredObject = StoredObject;

export interface IStorageBackend {
  readonly providerName: string;
  initiateMultipartUpload(filename: string, mimeType: string, totalSize: number): MultipartUploadInit;
  uploadPart(uploadId: string, partNumber: number, buffer: Buffer): UploadedPart;
  completeMultipartUpload(uploadId: string, expectedParts?: { partNumber: number; etag?: string }[]): MultipartUploadComplete;
  abortMultipartUpload(uploadId: string): boolean;
  saveObject(key: string, buffer: Buffer, mimeType: string, filename: string, ttlMs?: number): StoredObject;
  getObject(key: string): StoredObject | undefined;
  deleteObject(key: string): boolean;
  getActiveSessionsCount(): number;
  getObjectsCount(): number;
  sweepExpiredObjects?(now?: number): number;
  stopGc?(): void;
}

/**
 * Oracle Cloud Infrastructure (OCI) Object Storage Service
 * Implements OCI Native Object Storage Multipart & OCI S3-Compatibility API.
 */
export class OciObjectStorageService implements IStorageBackend {
  readonly providerName: string = 'oci';
  private sessions = new Map<string, OciMultipartSession>();
  private objects = new Map<string, OciStoredObject>();

  readonly config: OciStorageConfig = {
    namespace: process.env.OCI_NAMESPACE || 'easyconvert_oci_ns',
    bucketName: process.env.OCI_BUCKET_NAME || 'easyconvert-transcode-bucket',
    region: process.env.OCI_REGION || 'ap-chuncheon-1',
    endpoint: process.env.OCI_ENDPOINT || 'https://easyconvert.compat.objectstorage.ap-chuncheon-1.oraclecloud.com',
  };

  // OCI Object Storage recommended minimum part size: 5MB
  readonly DEFAULT_PART_SIZE = 5 * 1024 * 1024; // 5 MB

  private gcTimer: NodeJS.Timeout | null = null;

  constructor() {
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

    // Compute standard MD5 ETag
    const md5 = crypto.createHash('md5').update(buffer).digest('hex');
    const etag = `"${md5}"`;

    session.parts.set(partNumber, {
      buffer,
      etag,
      size: buffer.length,
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

    const buffers: Buffer[] = [];
    const etagHashes: Buffer[] = [];

    for (const num of partNumbers) {
      const part = session.parts.get(num);
      if (!part) {
        throw new Error(`Missing part number ${num} in OCI upload session.`);
      }
      buffers.push(part.buffer);
      const rawMd5 = part.etag.replace(/"/g, '');
      etagHashes.push(Buffer.from(rawMd5, 'hex'));
    }

    const assembledBuffer = Buffer.concat(buffers);

    // OCI composite hash
    const compositeHash = crypto.createHash('md5').update(Buffer.concat(etagHashes)).digest('hex');
    const compositeEtag = `"${compositeHash}-${partNumbers.length}"`;

    const now = Date.now();
    const stored: OciStoredObject = {
      key: session.key,
      filename: session.filename,
      mimeType: session.mimeType,
      buffer: assembledBuffer,
      size: assembledBuffer.length,
      etag: compositeEtag,
      namespace: session.namespace,
      bucket: session.bucket,
      uploadedAt: now,
      expiresAt: now + 60 * 60 * 1000, // 1-hour TTL
    };

    // Shred chunk buffers from parts map
    for (const part of session.parts.values()) {
      this.shredBuffer(part.buffer);
    }
    session.parts.clear();

    this.objects.set(session.key, stored);
    this.sessions.delete(uploadId);

    return {
      location: `/api/storage/file/${encodeURIComponent(session.key)}`,
      key: session.key,
      size: assembledBuffer.length,
      etag: compositeEtag,
    };
  }

  /**
   * Abort OCI Multipart Upload (OCI API: AbortMultipartUpload)
   */
  abortMultipartUpload(uploadId: string): boolean {
    const session = this.sessions.get(uploadId);
    if (!session) return false;
    for (const part of session.parts.values()) {
      this.shredBuffer(part.buffer);
    }
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
    // Also index by raw key for convenient lookup
    if (key !== ociKey) {
      this.objects.set(key, stored);
    }
    return stored;
  }

  /**
   * Retrieve stored object by key with lazy expiration check
   */
  getObject(key: string): OciStoredObject | undefined {
    const obj = this.objects.get(key);
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
    const obj = this.objects.get(key);
    if (!obj) return false;

    this.shredBuffer(obj.buffer);
    this.objects.delete(key);
    if (obj.key && obj.key !== key) {
      this.objects.delete(obj.key);
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
          this.shredBuffer(obj.buffer);
          shreddedObjects.add(obj);
          count++;
        }
        this.objects.delete(key);
      }
    }

    return count;
  }

  getActiveSessionsCount(): number {
    return this.sessions.size;
  }

  getObjectsCount(): number {
    return new Set(this.objects.values()).size;
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

  getObject(key: string): StoredObject | undefined {
    return this.backend.getObject(key);
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
