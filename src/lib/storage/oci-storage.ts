import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  generatePresignedUploadUrl?(key: string, partNumber: number, uploadId: string, expiresInSeconds?: number): PresignedUrlResult;
  generatePresignedDownloadUrl?(key: string, expiresInSeconds?: number): PresignedUrlResult;
  verifyPresignedSignature?(
    method: 'GET' | 'PUT',
    key: string,
    expiresAt: number,
    signature: string,
    uploadId?: string,
    partNumber?: number
  ): boolean;
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

  readonly config: OciStorageConfig = {
    namespace: process.env.OCI_NAMESPACE || 'axvym6vk8g7i',
    bucketName: process.env.OCI_BUCKET_NAME || 'easyconvert-transcode-bucket',
    region: process.env.OCI_REGION || 'ap-seoul-1',
    endpoint: process.env.OCI_ENDPOINT || 'https://axvym6vk8g7i.compat.objectstorage.ap-seoul-1.oraclecloud.com',
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
          throw new Error(`Part file missing on disk: ${part.filePath}`);
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
        if (cachedBuffer) return cachedBuffer;
        if (fs.existsSync(finalFilePath)) {
          cachedBuffer = fs.readFileSync(finalFilePath);
          return cachedBuffer;
        }
        return Buffer.alloc(0);
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
    globalSharedObjects.delete(key);
    const obj = this.objects.get(key);
    if (!obj) return false;

    if (obj.filePath && fs.existsSync(obj.filePath)) {
      try {
        fs.rmSync(obj.filePath, { force: true });
      } catch {}
    }

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
          if (obj.filePath && fs.existsSync(obj.filePath)) {
            try {
              fs.rmSync(obj.filePath, { force: true });
            } catch {}
          }
          this.shredBuffer(obj.buffer);
          shreddedObjects.add(obj);
          count++;
        }
        this.objects.delete(key);
      }
    }

    return count;
  }

  /**
   * Retrieves streaming reader for stored object with optional byte range support
   */
  getObjectStream(key: string, range?: { start: number; end: number }): fs.ReadStream | null {
    const obj = this.getObject(key);
    if (!obj) return null;
    if (obj.filePath && fs.existsSync(obj.filePath)) {
      return fs.createReadStream(obj.filePath, range ? { start: range.start, end: range.end } : undefined);
    }
    return null;
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
    const secret = process.env.STORAGE_SIGNING_SECRET || 'easyconvert-secure-storage-secret';
    const signature = crypto.createHmac('sha256', secret).update(stringToSign).digest('hex');
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
    const secret = process.env.STORAGE_SIGNING_SECRET || 'easyconvert-secure-storage-secret';
    const signature = crypto.createHmac('sha256', secret).update(stringToSign).digest('hex');
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
    const secret = process.env.STORAGE_SIGNING_SECRET || 'easyconvert-secure-storage-secret';
    const expectedSig = crypto.createHmac('sha256', secret).update(stringToSign).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expectedSig, 'hex'));
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
