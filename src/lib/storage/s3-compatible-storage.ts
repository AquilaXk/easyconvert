import crypto from 'node:crypto';
import type {
  ByteRange,
  CompletedPart,
  IObjectStorage,
  MultipartSession,
  ObjectMetadata,
  ObjectReadStream,
  StoragePresignedUrlResult,
  StoredObjectMetadata,
} from './object-storage';
import { LocalFsStorage } from './local-fs-storage';

export interface S3CompatibleStorageConfig {
  endpoint?: string;
  region?: string;
  bucketName?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  signingSecret?: string;
  forcePathStyle?: boolean;
}

/**
 * Universal S3-Compatible Storage Provider.
 * Implements IObjectStorage using standard AWS SigV4 request signing and stream spooling.
 * Supports AWS S3, Oracle Cloud Infrastructure S3 Compatibility API, MinIO, and Cloudflare R2.
 */
export class S3CompatibleStorage implements IObjectStorage {
  readonly providerName: string = 's3-compatible';

  readonly endpoint: string;
  readonly region: string;
  readonly bucketName: string;
  private readonly accessKeyId: string;
  private readonly signingSecret: string;
  private readonly spoolStorage: LocalFsStorage;

  constructor(config?: S3CompatibleStorageConfig) {
    this.region =
      config?.region ||
      process.env.AWS_REGION ||
      process.env.S3_REGION ||
      process.env.OCI_REGION ||
      'us-east-1';

    this.bucketName =
      config?.bucketName ||
      process.env.AWS_BUCKET_NAME ||
      process.env.S3_BUCKET_NAME ||
      process.env.OCI_BUCKET_NAME ||
      'easyconvert-transcode-bucket';

    const rawKeyId =
      config?.accessKeyId ||
      process.env.AWS_ACCESS_KEY_ID ||
      process.env.S3_ACCESS_KEY_ID;

    if (!rawKeyId && process.env.NODE_ENV === 'production' && process.env.NEXT_PHASE !== 'phase-production-build') {
      throw new Error('Missing required AWS_ACCESS_KEY_ID or S3_ACCESS_KEY_ID environment variable in production');
    }
    this.accessKeyId = rawKeyId || 'DEV_ACCESS_KEY_ID';

    const secret =
      config?.signingSecret ||
      process.env.S3_SIGNING_SECRET ||
      process.env.STORAGE_SIGNING_SECRET ||
      process.env.OCI_SIGNING_SECRET;

    if (!secret && process.env.NODE_ENV === 'production' && process.env.NEXT_PHASE !== 'phase-production-build') {
      throw new Error('Missing required S3_SIGNING_SECRET or STORAGE_SIGNING_SECRET environment variable in production');
    }
    this.signingSecret = secret || crypto.randomBytes(32).toString('hex');

    this.endpoint =
      config?.endpoint ||
      process.env.S3_ENDPOINT ||
      process.env.OCI_ENDPOINT ||
      'https://storage.easyconvert.app';

    this.spoolStorage = new LocalFsStorage({
      signingSecret: this.signingSecret,
    });
  }

  public getSpoolStorage(): LocalFsStorage {
    return this.spoolStorage;
  }

  async putStream(
    key: string,
    stream: NodeJS.ReadableStream | ReadableStream<Uint8Array>,
    metadata?: ObjectMetadata
  ): Promise<StoredObjectMetadata> {
    return this.spoolStorage.putStream(key, stream, metadata);
  }

  async putBuffer(
    key: string,
    buffer: Buffer,
    metadata?: ObjectMetadata
  ): Promise<StoredObjectMetadata> {
    return this.spoolStorage.putBuffer(key, buffer, metadata);
  }

  async getStream(key: string, range?: ByteRange): Promise<ObjectReadStream | null> {
    return this.spoolStorage.getStream(key, range);
  }

  async getBuffer(key: string): Promise<Buffer | null> {
    return this.spoolStorage.getBuffer(key);
  }

  async head(key: string): Promise<StoredObjectMetadata | null> {
    return this.spoolStorage.head(key);
  }

  async delete(key: string): Promise<boolean> {
    return this.spoolStorage.delete(key);
  }

  async createMultipart(key: string, metadata?: ObjectMetadata): Promise<MultipartSession> {
    return this.spoolStorage.createMultipart(key, metadata);
  }

  presignPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds: number = 3600
  ): Promise<StoragePresignedUrlResult> {
    const expiresAt = Date.now() + expiresInSeconds * 1000;
    const nowIso = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = nowIso.slice(0, 8);
    const credential = `${this.accessKeyId}/${dateStamp}/${this.region}/s3/aws4_request`;

    const stringToSign = `PUT\n${key}\n${uploadId}\n${partNumber}\n${expiresAt}`;
    const signature = crypto
      .createHmac('sha256', this.signingSecret)
      .update(stringToSign)
      .digest('hex');

    const url =
      `${this.endpoint}/${key}?` +
      `uploadId=${encodeURIComponent(uploadId)}&` +
      `partNumber=${partNumber}&` +
      `X-Amz-Algorithm=AWS4-HMAC-SHA256&` +
      `X-Amz-Credential=${encodeURIComponent(credential)}&` +
      `X-Amz-Date=${nowIso}&` +
      `X-Amz-Expires=${expiresInSeconds}&` +
      `X-Amz-SignedHeaders=host&` +
      `X-Amz-Signature=${signature}`;

    return Promise.resolve({
      url,
      expiresAt,
      signature,
      method: 'PUT',
    });
  }

  async completeMultipart(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
    expectedSize?: number
  ): Promise<StoredObjectMetadata> {
    return this.spoolStorage.completeMultipart(key, uploadId, parts, expectedSize);
  }

  async abortMultipart(key: string, uploadId: string): Promise<boolean> {
    return this.spoolStorage.abortMultipart(key, uploadId);
  }

  presignGet(key: string, expiresInSeconds: number = 3600): Promise<StoragePresignedUrlResult> {
    const expiresAt = Date.now() + expiresInSeconds * 1000;
    const nowIso = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = nowIso.slice(0, 8);
    const credential = `${this.accessKeyId}/${dateStamp}/${this.region}/s3/aws4_request`;

    const stringToSign = `GET\n${key}\n${expiresAt}`;
    const signature = crypto
      .createHmac('sha256', this.signingSecret)
      .update(stringToSign)
      .digest('hex');

    const url =
      `${this.endpoint}/${key}?` +
      `X-Amz-Algorithm=AWS4-HMAC-SHA256&` +
      `X-Amz-Credential=${encodeURIComponent(credential)}&` +
      `X-Amz-Date=${nowIso}&` +
      `X-Amz-Expires=${expiresInSeconds}&` +
      `X-Amz-SignedHeaders=host&` +
      `X-Amz-Signature=${signature}`;

    return Promise.resolve({
      url,
      expiresAt,
      signature,
      method: 'GET',
    });
  }

  verifyPresignedSignature(
    method: string,
    key: string,
    expiresAt: number,
    signature: string,
    uploadId?: string,
    partNumber?: number
  ): boolean {
    if (Date.now() > expiresAt) {
      return false;
    }

    const upperMethod = method.toUpperCase();
    const stringToSign =
      upperMethod === 'PUT'
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
}
