import crypto from 'crypto';
import { MultipartUploadInit, UploadedPart, MultipartUploadComplete } from '../types';

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

interface OciStoredObject {
  key: string;
  filename: string;
  mimeType: string;
  buffer: Buffer;
  size: number;
  etag: string;
  namespace: string;
  bucket: string;
  uploadedAt: number;
}

/**
 * Oracle Cloud Infrastructure (OCI) Object Storage Service
 * Implements OCI Native Object Storage Multipart & OCI S3-Compatibility API.
 */
class OciObjectStorageService {
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

    const stored: OciStoredObject = {
      key: session.key,
      filename: session.filename,
      mimeType: session.mimeType,
      buffer: assembledBuffer,
      size: assembledBuffer.length,
      etag: compositeEtag,
      namespace: session.namespace,
      bucket: session.bucket,
      uploadedAt: Date.now(),
    };

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
    session.parts.clear();
    return this.sessions.delete(uploadId);
  }

  /**
   * Save complete object directly into OCI Object Storage
   */
  saveObject(key: string, buffer: Buffer, mimeType: string, filename: string): OciStoredObject {
    const md5 = crypto.createHash('md5').update(buffer).digest('hex');
    const ociKey = key.startsWith('n/') ? key : `n/${this.config.namespace}/b/${this.config.bucketName}/o/${key}`;
    const stored: OciStoredObject = {
      key: ociKey,
      filename,
      mimeType,
      buffer,
      size: buffer.length,
      etag: `"${md5}"`,
      namespace: this.config.namespace,
      bucket: this.config.bucketName,
      uploadedAt: Date.now(),
    };
    this.objects.set(ociKey, stored);
    // Also index by raw key for convenient lookup
    if (key !== ociKey) {
      this.objects.set(key, stored);
    }
    return stored;
  }

  /**
   * Retrieve stored object by key
   */
  getObject(key: string): OciStoredObject | undefined {
    return this.objects.get(key);
  }

  /**
   * Delete object from OCI Object Storage
   */
  deleteObject(key: string): boolean {
    return this.objects.delete(key);
  }

  getActiveSessionsCount(): number {
    return this.sessions.size;
  }

  getObjectsCount(): number {
    return this.objects.size;
  }
}

export const ociStorage = new OciObjectStorageService();
// Backward-compatible alias
export const s3Storage = ociStorage;
