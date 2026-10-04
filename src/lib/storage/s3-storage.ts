import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  MultipartUploadInit,
  UploadedPart,
  MultipartUploadComplete,
} from '../types';
import {
  IStorageBackend,
  StoredObject,
  PresignedUrlResult,
  ObjectStat,
  PayloadTooLargeForMemoryError,
  StoredObjectMissingError,
  getMaxInMemoryBytes,
} from './oci-storage';
import { presignSigV4QueryUrl, verifySigV4QueryUrl } from './sigv4-presigner';

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
  private readonly signingSecret: string;

  readonly DEFAULT_PART_SIZE = 5 * 1024 * 1024; // 5 MB S3 minimum part size
  private readonly baseUploadDir: string;

  constructor(options?: { signingSecret?: string; baseUploadDir?: string }) {
    const secret =
      options?.signingSecret ||
      process.env.S3_SIGNING_SECRET ||
      process.env.STORAGE_SIGNING_SECRET;

    if (!secret) {
      if (process.env.NODE_ENV === 'production' && process.env.NEXT_PHASE !== 'phase-production-build') {
        throw new Error('Missing required S3_SIGNING_SECRET or STORAGE_SIGNING_SECRET environment variable in production');
      }
      this.signingSecret = crypto.randomBytes(32).toString('hex');
    } else {
      this.signingSecret = secret;
    }

    this.baseUploadDir = options?.baseUploadDir || path.join(os.tmpdir(), 'easyconvert_s3_uploads');
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
    ownerUserId?: string,
    partSize?: number
  ): MultipartUploadInit {
    const timestamp = Date.now();
    const randomHex = crypto.randomBytes(8).toString('hex');
    const uploadId = `oci_mp_s3_${timestamp}_${randomHex}`;
    const sanitizedFilename = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = ownerUserId
      ? `conversions/${ownerUserId}/${timestamp}_${randomHex}_${sanitizedFilename}`
      : `uploads/${timestamp}_${randomHex}_${sanitizedFilename}`;

    const resolvedPartSize = partSize && partSize > 0 ? partSize : this.DEFAULT_PART_SIZE;
    const totalParts = Math.max(1, Math.ceil(totalSize / resolvedPartSize));

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
      partSize: resolvedPartSize,
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
      partSize: resolvedPartSize,
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

  async uploadPartStream(
    uploadId: string,
    partNumber: number,
    stream: NodeJS.ReadableStream | ReadableStream<Uint8Array>,
    maxPartBytes?: number,
    maxTotalBytes?: number,
    currentSessionBytes: number = 0
  ): Promise<UploadedPart> {
    const session = this.sessions.get(uploadId);
    if (!session) {
      throw new Error(`Invalid or expired multipart upload session: ${uploadId}`);
    }

    if (partNumber < 1 || partNumber > 10000) {
      throw new Error(`Invalid OCI partNumber: ${partNumber}. Must be between 1 and 10000.`);
    }

    const partFileName = `part-${partNumber}.bin`;
    const partFilePath = path.join(session.diskDir, partFileName);
    const tempPartFilePath = `${partFilePath}.tmp`;

    const nodeStream =
      'pipe' in (stream as any) && typeof (stream as any).pipe === 'function'
        ? (stream as NodeJS.ReadableStream)
        : Readable.fromWeb(stream as any);

    const outStream = fs.createWriteStream(tempPartFilePath);
    const hasher = crypto.createHash('sha256');
    let partSize = 0;
    let limitExceededMessage: string | null = null;

    const passThrough = new PassThrough();
    passThrough.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      partSize += buf.length;
      if (maxPartBytes !== undefined && partSize > maxPartBytes) {
        limitExceededMessage = `Part size exceeds maximum allowed part size of ${maxPartBytes} bytes (64 MiB).`;
        outStream.destroy(new Error(limitExceededMessage));
        return;
      }
      if (maxTotalBytes !== undefined && currentSessionBytes + partSize > maxTotalBytes) {
        limitExceededMessage = `Total upload size exceeds maximum allowed size of ${maxTotalBytes} bytes.`;
        outStream.destroy(new Error(limitExceededMessage));
        return;
      }
      hasher.update(buf);
    });

    try {
      await pipeline(nodeStream, passThrough, outStream);
    } catch (err: any) {
      try {
        if (fs.existsSync(tempPartFilePath)) fs.unlinkSync(tempPartFilePath);
      } catch {}
      if (limitExceededMessage) {
        const error = new Error(limitExceededMessage);
        (error as any).statusCode = 413;
        throw error;
      }
      throw err;
    }

    if (partSize === 0) {
      try {
        if (fs.existsSync(tempPartFilePath)) fs.unlinkSync(tempPartFilePath);
      } catch {}
      const error = new Error('Chunk payload is empty (0 bytes).');
      (error as any).statusCode = 400;
      throw error;
    }

    fs.renameSync(tempPartFilePath, partFilePath);

    const hashHex = hasher.digest('hex').slice(0, 32);
    const etag = `"${hashHex}"`;

    session.parts.set(partNumber, {
      filePath: partFilePath,
      etag,
      size: partSize,
    });

    return {
      partNumber,
      size: partSize,
      etag,
    };
  }

  completeMultipartUpload(
    uploadId: string,
    expectedParts?: { partNumber: number; etag?: string }[]
  ): MultipartUploadComplete {
    const session = this.sessions.get(uploadId);
    if (!session) {
      throw new Error(`Invalid or expired multipart upload session: ${uploadId}`);
    }

    if (session.parts.size === 0) {
      throw new Error(`Cannot complete empty multipart upload session: ${uploadId}`);
    }

    if (expectedParts !== undefined) {
      if (!Array.isArray(expectedParts) || expectedParts.length === 0) {
        throw new Error(`Cannot complete multipart upload with zero parts: ${uploadId}`);
      }
      for (const p of expectedParts) {
        if (!p || typeof p.partNumber !== 'number' || p.partNumber < 1 || p.partNumber > 10000) {
          throw new Error(`Invalid part number ${p?.partNumber} in expected parts list.`);
        }
        const sessionPart = session.parts.get(p.partNumber);
        if (!sessionPart) {
          throw new Error(`Missing part number ${p.partNumber} in multipart upload session: ${uploadId}`);
        }
        if (p.etag && p.etag !== sessionPart.etag) {
          throw new Error(`ETag mismatch for part number ${p.partNumber}: expected ${p.etag}, got ${sessionPart.etag}`);
        }
      }
    }

    const sortedPartNumbers = expectedParts
      ? expectedParts.map((p) => p.partNumber).sort((a, b) => a - b)
      : Array.from(session.parts.keys()).sort((a, b) => a - b);
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
          console.error(`Part file missing on disk: "${partInfo.filePath}"`);
          throw new Error(`Part file missing on disk for part ${partNum}`);
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
        throw new StoredObjectMissingError(undefined, { key, filePath });
      },
      set buffer(b: Buffer) {
        cachedBuffer = b;
      },
    };
    this.objects.set(key, obj);
    globalSharedObjects.set(key, obj);
    return obj;
  }

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

  openReadStream(key: string, range?: { start: number; end: number }): fs.ReadStream | null {
    return this.getObjectStream(key, range);
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

  deleteByPrefix(prefix: string): number {
    let count = 0;
    for (const key of Array.from(this.objects.keys())) {
      if (key.startsWith(prefix)) {
        if (this.deleteObject(key)) {
          count++;
        }
      }
    }
    for (const key of Array.from(globalSharedObjects.keys())) {
      if (key.startsWith(prefix)) {
        if (this.deleteObject(key)) {
          count++;
        }
      }
    }
    return count;
  }

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

  async saveObjectFromStream(
    key: string,
    stream: NodeJS.ReadableStream,
    meta: { filename: string; mimeType: string; size?: number },
    ttlMs: number = 24 * 60 * 60 * 1000
  ): Promise<StoredObject> {
    const objectsDir = path.join(this.baseUploadDir, 'objects');
    if (!fs.existsSync(objectsDir)) {
      try {
        fs.mkdirSync(objectsDir, { recursive: true });
      } catch {}
    }
    const tempFilePath = path.join(objectsDir, `stream-${crypto.randomUUID()}.tmp`);
    const finalFilePath = path.join(objectsDir, `s3-${crypto.randomUUID()}-${path.basename(meta.filename)}`);

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
    const now = Date.now();
    let cachedBuffer: Buffer | null = null;

    const stored: StoredObject = {
      key,
      filename: meta.filename,
      mimeType: meta.mimeType,
      size: totalBytes,
      etag,
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
        throw new StoredObjectMissingError(undefined, { key, filePath: finalFilePath });
      },
    };

    this.objects.set(key, stored);
    globalSharedObjects.set(key, stored);
    return stored;
  }

  getActiveSessionsCount(): number {
    return this.sessions.size;
  }

  getObjectsCount(): number {
    return this.objects.size;
  }

  getSigningSecret(): string {
    return this.signingSecret;
  }

  generatePresignedUploadUrl(
    key: string,
    partNumber: number,
    uploadId: string,
    expiresInSeconds: number = 900
  ): PresignedUrlResult {
    return this.generatePresignedUploadPartUrl(key, uploadId, partNumber, expiresInSeconds, false);
  }

  generatePresignedUploadPartUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds: number = 900,
    localEmulation: boolean = false
  ): PresignedUrlResult {
    const region = process.env.AWS_REGION || process.env.S3_REGION || 'us-east-1';
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY_ID;

    if (!accessKeyId && process.env.NODE_ENV === 'production') {
      throw new Error('Missing required AWS_ACCESS_KEY_ID or S3_ACCESS_KEY_ID environment variable in production');
    }
    const resolvedKeyId = accessKeyId || 'DEV_ACCESS_KEY_ID';

    const baseUrl = localEmulation
      ? (process.env.APP_URL || 'http://localhost:3000') + '/api/v1/uploads/direct/part'
      : (process.env.S3_ENDPOINT || 'https://storage.easyconvert.app') + `/${key}`;

    const queryParams: Record<string, string | number> = {
      uploadId,
      partNumber,
    };
    if (localEmulation) {
      queryParams.key = key;
    }

    const res = presignSigV4QueryUrl({
      method: 'PUT',
      url: baseUrl,
      queryParams,
      credentials: {
        accessKeyId: resolvedKeyId,
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
    const signature = crypto
      .createHmac('sha256', this.signingSecret)
      .update(stringToSign)
      .digest('hex');

    const baseUrl = (process.env.APP_URL || 'http://localhost:3000') + '/api/v1/uploads/direct/part';
    const url = `${baseUrl}?uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}&key=${encodeURIComponent(key)}&expiresAt=${expiresAt}&signature=${signature}`;

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
    const region = process.env.AWS_REGION || process.env.S3_REGION || 'us-east-1';
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY_ID;

    if (!accessKeyId && process.env.NODE_ENV === 'production') {
      throw new Error('Missing required AWS_ACCESS_KEY_ID or S3_ACCESS_KEY_ID environment variable in production');
    }
    const resolvedKeyId = accessKeyId || 'DEV_ACCESS_KEY_ID';
    const credential = `${resolvedKeyId}/${dateStamp}/${region}/s3/aws4_request`;

    const stringToSign = `GET\n${key}\n${expiresAt}`;
    const signature = crypto
      .createHmac('sha256', this.signingSecret)
      .update(stringToSign)
      .digest('hex');

    const endpoint = process.env.S3_ENDPOINT || 'https://storage.easyconvert.app';
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
      if (sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf)) {
        return true;
      }
    } catch {}

    return this.verifySigV4Fallback(method, key, expiresAt, signature, uploadId, partNumber);
  }

  private verifySigV4Fallback(
    method: 'GET' | 'PUT',
    key: string,
    expiresAt: number,
    signature: string,
    uploadId?: string,
    partNumber?: number
  ): boolean {
    try {
      const region = process.env.AWS_REGION || process.env.S3_REGION || 'us-east-1';
      const accessKeyId = process.env.AWS_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY_ID || 'DEV_ACCESS_KEY_ID';
      const endpoint = process.env.S3_ENDPOINT || 'https://storage.easyconvert.app';
      const fullUrl = `${endpoint}/${key}`;

      for (const expiresInSec of [900, 3600]) {
        const estimatedTimestamp = new Date(expiresAt - expiresInSec * 1000);
        const queryParams: Record<string, string | number> = {};
        if (uploadId) queryParams.uploadId = uploadId;
        if (partNumber !== undefined) queryParams.partNumber = partNumber;

        const res = presignSigV4QueryUrl({
          method,
          url: fullUrl,
          queryParams: Object.keys(queryParams).length > 0 ? queryParams : undefined,
          credentials: {
            accessKeyId,
            secretAccessKey: this.signingSecret,
            region,
            service: 's3',
          },
          expiresInSeconds: expiresInSec,
          timestamp: estimatedTimestamp,
        });

        const sigBuf = Buffer.from(signature.toLowerCase(), 'hex');
        const expectedBuf = Buffer.from(res.signature.toLowerCase(), 'hex');
        if (sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf)) {
          return true;
        }
      }
    } catch {}

    return false;
  }

  verifySigV4Url(urlStr: string, method: string = 'PUT'): ReturnType<typeof verifySigV4QueryUrl> {
    return verifySigV4QueryUrl(urlStr, {
      secretAccessKey: this.signingSecret,
      expectedMethod: method,
    });
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
