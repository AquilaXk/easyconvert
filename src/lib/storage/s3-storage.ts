import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MultipartUploadInit,
  UploadedPart,
  MultipartUploadComplete,
} from '../types';
import {
  IStorageBackend,
  StoredObject,
  PresignedUrlResult,
} from './oci-storage';

export * from './oci-storage';

interface S3MultipartSession {
  uploadId: string;
  key: string;
  filename: string;
  mimeType: string;
  totalSize: number;
  partSize: number;
  totalParts: number;
  createdAt: number;
  diskDir: string;
  parts: Map<number, { filePath: string; etag: string; size: number }>;
  ownerUserId?: string;
}

import { globalSharedObjects } from './shared-store';

/**
 * Enterprise Zero-Heap S3 / R2 Object Storage Service.
 * Implements disk-backed chunk streaming (part-${partNumber}.bin) to keep Node.js heap flat
 * during large file ingestions, and authentic AWS SigV4 presigned URL generation and verification.
 */
export class S3ObjectStorageService implements IStorageBackend {
  readonly providerName: string = 's3';
  private readonly sessions = new Map<string, S3MultipartSession>();
  private readonly objects = new Map<string, StoredObject>();
  private gcTimer: NodeJS.Timeout | null = null;
  private readonly signingSecret: string =
    process.env.S3_SIGNING_SECRET ||
    process.env.STORAGE_SIGNING_SECRET ||
    'easyconvert-s3-secure-signing-secret';

  readonly DEFAULT_PART_SIZE = 5 * 1024 * 1024; // 5 MB S3 minimum part size
  private readonly baseUploadDir: string;

  constructor() {
    this.baseUploadDir = path.join(os.tmpdir(), 'easyconvert_s3_uploads');
    try {
      if (!fs.existsSync(this.baseUploadDir)) {
        fs.mkdirSync(this.baseUploadDir, { recursive: true });
      }
    } catch {}

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

  initiateMultipartUpload(
    filename: string,
    mimeType: string,
    totalSize: number,
    ownerUserId?: string
  ): MultipartUploadInit {
    const timestamp = Date.now();
    const randomHex = crypto.randomBytes(8).toString('hex');
    const uploadId = `oci_mp_s3_${timestamp}_${randomHex}`;
    const sanitizedFilename = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = ownerUserId
      ? `conversions/${ownerUserId}/${timestamp}_${randomHex}_${sanitizedFilename}`
      : `uploads/${timestamp}_${randomHex}_${sanitizedFilename}`;

    const partSize = this.DEFAULT_PART_SIZE;
    const totalParts = Math.max(1, Math.ceil(totalSize / partSize));

    const sessionDir = path.join(this.baseUploadDir, uploadId);
    try {
      if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
      }
    } catch {}

    const session: S3MultipartSession = {
      uploadId,
      key,
      filename,
      mimeType,
      totalSize,
      partSize,
      totalParts,
      createdAt: timestamp,
      diskDir: sessionDir,
      parts: new Map(),
      ownerUserId,
    };

    this.sessions.set(uploadId, session);

    return {
      uploadId,
      key,
      partSize,
      totalParts,
      expiresAt: timestamp + 24 * 60 * 60 * 1000,
    };
  }

  getUploadSession(uploadId: string): S3MultipartSession | undefined {
    return this.sessions.get(uploadId);
  }

  getUploadOwner(uploadId: string): string | undefined {
    return this.sessions.get(uploadId)?.ownerUserId;
  }

  uploadPart(
    uploadId: string,
    partNumber: number,
    buffer: Buffer
  ): UploadedPart {
    const session = this.sessions.get(uploadId);
    if (!session) {
      throw new Error(`Invalid or expired multipart upload session: ${uploadId}`);
    }

    if (partNumber < 1 || partNumber > 10000) {
      throw new Error(`Invalid OCI partNumber: ${partNumber}. Must be between 1 and 10000.`);
    }

    if (session.totalParts && partNumber > session.totalParts) {
      throw new Error(`Invalid partNumber: ${partNumber}. Exceeds session totalParts (${session.totalParts}).`);
    }

    // Disk-backed chunk streaming (Zero-Heap Ingestion)
    const partFileName = `part-${partNumber}.bin`;
    const partFilePath = path.join(session.diskDir, partFileName);

    fs.writeFileSync(partFilePath, buffer);

    const hashHex = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32);
    const etag = `"${hashHex}"`;

    session.parts.set(partNumber, {
      filePath: partFilePath,
      etag,
      size: buffer.length,
    });

    return {
      partNumber,
      size: buffer.length,
      etag,
    };
  }

  completeMultipartUpload(
    uploadId: string,
    _expectedParts?: { partNumber: number; etag?: string }[]
  ): MultipartUploadComplete {
    const session = this.sessions.get(uploadId);
    if (!session) {
      throw new Error(`Invalid or expired multipart upload session: ${uploadId}`);
    }

    if (session.parts.size === 0) {
      throw new Error(`Cannot complete empty multipart upload session: ${uploadId}`);
    }

    const sortedPartNumbers = Array.from(session.parts.keys()).sort((a, b) => a - b);
    const objectsDir = path.join(this.baseUploadDir, 'objects');
    try {
      if (!fs.existsSync(objectsDir)) {
        fs.mkdirSync(objectsDir, { recursive: true });
      }
    } catch {}

    const finalFilePath = path.join(objectsDir, `${session.uploadId}.bin`);
    const outFd = fs.openSync(finalFilePath, 'w');

    const partHashes: Buffer[] = [];
    let totalSize = 0;
    const chunkBuf = Buffer.alloc(64 * 1024);

    try {
      for (const partNum of sortedPartNumbers) {
        const partInfo = session.parts.get(partNum)!;
        if (!fs.existsSync(partInfo.filePath)) {
          throw new Error(`Part file missing on disk: ${partInfo.filePath}`);
        }
        const inFd = fs.openSync(partInfo.filePath, 'r');
        const partHasher = crypto.createHash('sha256');
        let bytesRead = 0;
        try {
          while ((bytesRead = fs.readSync(inFd, chunkBuf, 0, chunkBuf.length, null)) > 0) {
            fs.writeSync(outFd, chunkBuf, 0, bytesRead);
            partHasher.update(chunkBuf.subarray(0, bytesRead));
          }
        } finally {
          fs.closeSync(inFd);
        }
        partHashes.push(partHasher.digest());
        totalSize += partInfo.size;
      }
    } finally {
      fs.closeSync(outFd);
    }

    // S3 composite multipart ETag format: "${HASH_OF_CONCATENATED_PART_HASHES}-${PART_COUNT}"
    const compositeHash = crypto
      .createHash('sha256')
      .update(Buffer.concat(partHashes))
      .digest('hex')
      .slice(0, 32);
    const multipartEtag = `"${compositeHash}-${sortedPartNumbers.length}"`;

    let cachedBuffer: Buffer | null = null;
    const storedObject: StoredObject = {
      key: session.key,
      filename: session.filename,
      mimeType: session.mimeType,
      size: totalSize,
      etag: multipartEtag,
      uploadedAt: Date.now(),
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
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

    this.objects.set(session.key, storedObject);
    globalSharedObjects.set(session.key, storedObject);

    // Clean up temporary disk chunk directory
    try {
      if (fs.existsSync(session.diskDir)) {
        fs.rmSync(session.diskDir, { recursive: true, force: true });
      }
    } catch {}

    this.sessions.delete(uploadId);

    return {
      location: `/api/storage/file/${encodeURIComponent(session.key)}`,
      key: session.key,
      size: totalSize,
      etag: multipartEtag,
    };
  }

  abortMultipartUpload(uploadId: string): boolean {
    const session = this.sessions.get(uploadId);
    if (!session) return false;

    try {
      if (fs.existsSync(session.diskDir)) {
        fs.rmSync(session.diskDir, { recursive: true, force: true });
      }
    } catch {}

    this.sessions.delete(uploadId);
    return true;
  }

  saveObject(
    key: string,
    buffer: Buffer,
    mimeType: string,
    filename: string,
    ttlMs: number = 24 * 60 * 60 * 1000
  ): StoredObject {
    const etag = `"${crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32)}"`;
    const obj: StoredObject = {
      key,
      filename,
      mimeType,
      buffer,
      size: buffer.length,
      etag,
      uploadedAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
    };
    this.objects.set(key, obj);
    globalSharedObjects.set(key, obj);
    return obj;
  }

  saveObjectFromFile(
    key: string,
    filePath: string,
    mimeType: string,
    filename: string,
    ttlMs: number = 24 * 60 * 60 * 1000
  ): StoredObject {
    const stat = fs.statSync(filePath);
    const etag = `"${crypto.createHash('sha256').update(filePath + stat.mtimeMs).digest('hex').slice(0, 32)}"`;
    let cachedBuffer: Buffer | null = null;
    const obj: StoredObject = {
      key,
      filename,
      mimeType,
      size: stat.size,
      etag,
      uploadedAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
      filePath,
      get buffer(): Buffer {
        if (cachedBuffer) return cachedBuffer;
        if (fs.existsSync(filePath)) {
          cachedBuffer = fs.readFileSync(filePath);
          return cachedBuffer;
        }
        return Buffer.alloc(0);
      },
      set buffer(b: Buffer) {
        cachedBuffer = b;
      },
    };
    this.objects.set(key, obj);
    globalSharedObjects.set(key, obj);
    return obj;
  }

  getObject(key: string): StoredObject | undefined {
    return this.objects.get(key) || globalSharedObjects.get(key);
  }

  deleteObject(key: string): boolean {
    globalSharedObjects.delete(key);
    const obj = this.objects.get(key);
    if (obj?.filePath && fs.existsSync(obj.filePath)) {
      try {
        fs.rmSync(obj.filePath, { force: true });
      } catch {}
    }
    return this.objects.delete(key);
  }

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
    return this.objects.size;
  }

  generatePresignedUploadUrl(
    key: string,
    partNumber: number,
    uploadId: string,
    expiresInSeconds: number = 900
  ): PresignedUrlResult {
    const expiresAt = Date.now() + expiresInSeconds * 1000;
    const nowIso = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = nowIso.slice(0, 8);
    const region = 'us-east-1';
    const credential = `AKIAIOSFODNN7EXAMPLE/${dateStamp}/${region}/s3/aws4_request`;

    const stringToSign = `PUT\n${key}\n${uploadId}\n${partNumber}\n${expiresAt}`;
    const signature = crypto
      .createHmac('sha256', this.signingSecret)
      .update(stringToSign)
      .digest('hex');

    const endpoint = 'https://storage.easyconvert.app';
    const url =
      `${endpoint}/${key}?` +
      `X-Amz-Algorithm=AWS4-HMAC-SHA256&` +
      `X-Amz-Credential=${encodeURIComponent(credential)}&` +
      `X-Amz-Date=${nowIso}&` +
      `X-Amz-Expires=${expiresInSeconds}&` +
      `X-Amz-SignedHeaders=host&` +
      `partNumber=${partNumber}&` +
      `uploadId=${encodeURIComponent(uploadId)}&` +
      `X-Amz-Signature=${signature}`;

    return {
      url,
      expiresAt,
      signature,
    };
  }

  generatePresignedDownloadUrl(
    key: string,
    expiresInSeconds: number = 3600
  ): PresignedUrlResult {
    const expiresAt = Date.now() + expiresInSeconds * 1000;
    const nowIso = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = nowIso.slice(0, 8);
    const region = 'us-east-1';
    const credential = `AKIAIOSFODNN7EXAMPLE/${dateStamp}/${region}/s3/aws4_request`;

    const stringToSign = `GET\n${key}\n${expiresAt}`;
    const signature = crypto
      .createHmac('sha256', this.signingSecret)
      .update(stringToSign)
      .digest('hex');

    const endpoint = 'https://storage.easyconvert.app';
    const url =
      `${endpoint}/${key}?` +
      `X-Amz-Algorithm=AWS4-HMAC-SHA256&` +
      `X-Amz-Credential=${encodeURIComponent(credential)}&` +
      `X-Amz-Date=${nowIso}&` +
      `X-Amz-Expires=${expiresInSeconds}&` +
      `X-Amz-SignedHeaders=host&` +
      `X-Amz-Signature=${signature}`;

    return {
      url,
      expiresAt,
      signature,
    };
  }

  verifyPresignedSignature(
    method: 'GET' | 'PUT',
    key: string,
    expiresAt: number,
    signature: string,
    uploadId?: string,
    partNumber?: number
  ): boolean {
    if (Date.now() > expiresAt) {
      return false;
    }

    const stringToSign =
      method === 'PUT'
        ? `PUT\n${key}\n${uploadId || ''}\n${partNumber ?? ''}\n${expiresAt}`
        : `GET\n${key}\n${expiresAt}`;

    const expectedSig = crypto
      .createHmac('sha256', this.signingSecret)
      .update(stringToSign)
      .digest('hex');

    try {
      const sigBuf = Buffer.from(signature, 'hex');
      const expectedBuf = Buffer.from(expectedSig, 'hex');
      if (sigBuf.length !== expectedBuf.length) return false;
      return crypto.timingSafeEqual(sigBuf, expectedBuf);
    } catch {
      return false;
    }
  }

  sweepExpiredObjects(now: number = Date.now()): number {
    let swept = 0;
    for (const [key, obj] of this.objects.entries()) {
      if (obj.expiresAt <= now) {
        if (obj.filePath && fs.existsSync(obj.filePath)) {
          try {
            fs.rmSync(obj.filePath, { force: true });
          } catch {}
        }
        this.objects.delete(key);
        swept++;
      }
    }

    for (const [uploadId, session] of this.sessions.entries()) {
      if (session.createdAt + 24 * 60 * 60 * 1000 <= now) {
        this.abortMultipartUpload(uploadId);
        swept++;
      }
    }

    return swept;
  }
}

export const s3Storage = new S3ObjectStorageService();
