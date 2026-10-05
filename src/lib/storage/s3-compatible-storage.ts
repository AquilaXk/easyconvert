import type { Readable } from 'node:stream';
import { StorageAdapterError } from './adapters/adapter-interface';
import { PayloadTooLargeForMemoryError, getMaxInMemoryBytes } from './errors';
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
import {
  DEFAULT_OBJECT_TTL_SECONDS,
  buildPutOptions,
  isObjectExpired,
  toStoredObjectMetadata,
} from './object-attributes';
import { S3ObjectClient, type PutObjectOptions, type S3ObjectClientConfig } from './s3-object-client';
import type { RemoteStorageConfig } from './storage-config';

/**
 * Object storage on an S3-compatible service: OCI Object Storage through its S3 compatibility
 * endpoint in production, or any other S3-compatible server. Objects, multipart sessions and
 * presigned URLs all live on the service and are signed with its credentials; nothing is spooled
 * to local disk and no state is held in process memory. Per-object attributes (filename, expiry,
 * custom metadata) travel as `x-amz-meta-*` headers, see object-attributes.ts.
 */

const PROVIDER = 's3-compatible';
const MULTIPART_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MS_PER_SECOND = 1000;

export interface S3CompatibleStorageConfig extends Omit<S3ObjectClientConfig, 'bucket'> {
  bucketName: string;
  defaultTtlSeconds?: number;
}

export class S3CompatibleStorage implements IObjectStorage {
  readonly providerName: string;
  readonly endpoint: string;
  readonly region: string;
  readonly bucketName: string;
  readonly client: S3ObjectClient;
  private readonly defaultTtlSeconds: number;

  constructor(config: S3CompatibleStorageConfig) {
    this.providerName = config.providerName ?? PROVIDER;
    const { bucketName, defaultTtlSeconds, ...clientConfig } = config;
    this.client = new S3ObjectClient({ ...clientConfig, bucket: bucketName, providerName: this.providerName });
    this.endpoint = this.client.endpoint;
    this.region = this.client.region;
    this.bucketName = bucketName;
    this.defaultTtlSeconds = defaultTtlSeconds ?? DEFAULT_OBJECT_TTL_SECONDS;
  }

  /** Builds the provider from validated `STORAGE_DRIVER=oci|s3` configuration. */
  static fromConfig(config: RemoteStorageConfig, options: Partial<S3CompatibleStorageConfig> = {}): S3CompatibleStorage {
    return new S3CompatibleStorage({
      endpoint: config.endpoint,
      region: config.region,
      bucketName: config.bucket,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      forcePathStyle: config.forcePathStyle,
      providerName: config.driver,
      ...options,
    });
  }

  // ---------------------------------------------------------------------------------------------
  // IObjectStorage
  // ---------------------------------------------------------------------------------------------

  async putStream(
    key: string,
    stream: NodeJS.ReadableStream | ReadableStream<Uint8Array>,
    metadata?: ObjectMetadata
  ): Promise<StoredObjectMetadata> {
    const now = Date.now();
    const options = buildPutOptions(this.providerName, key, metadata, now, this.defaultTtlSeconds);
    const result = await this.client.putStream(key, stream, { ...options, size: metadata?.size });
    return this.storedFromPut(key, result.size, result.etag, options, now);
  }

  async putBuffer(key: string, buffer: Buffer, metadata?: ObjectMetadata): Promise<StoredObjectMetadata> {
    const now = Date.now();
    const options = buildPutOptions(this.providerName, key, metadata, now, this.defaultTtlSeconds);
    const result = await this.client.putBuffer(key, buffer, options);
    return this.storedFromPut(key, result.size, result.etag, options, now);
  }

  private storedFromPut(
    key: string,
    size: number,
    etag: string,
    options: PutObjectOptions,
    now: number
  ): StoredObjectMetadata {
    return toStoredObjectMetadata(
      {
        key,
        size,
        etag,
        contentType: options.contentType,
        lastModified: new Date(now),
        metadata: options.metadata ?? {},
      },
      now
    );
  }

  async getStream(key: string, range?: ByteRange): Promise<ObjectReadStream | null> {
    const result = await this.client.getObject(key, range);
    if (!result) return null;
    const now = Date.now();
    if (isObjectExpired(result, now)) {
      result.stream.destroy();
      await this.client.deleteObject(key).catch(() => undefined);
      return null;
    }
    return {
      stream: result.stream,
      metadata: toStoredObjectMetadata(result, now),
      range: result.range ? { start: result.range.start, end: result.range.end } : undefined,
    };
  }

  /** Reads a whole object into memory; objects over the in-memory limit are refused, never truncated. */
  async getBuffer(key: string): Promise<Buffer | null> {
    const result = await this.getStream(key);
    if (!result) return null;
    const limit = getMaxInMemoryBytes();
    if (result.metadata.size > limit) {
      (result.stream as Readable).destroy();
      throw new PayloadTooLargeForMemoryError(undefined, { size: result.metadata.size, limit });
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of result.stream) {
      const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += piece.length;
      if (total > limit) {
        throw new PayloadTooLargeForMemoryError(undefined, { size: total, limit });
      }
      chunks.push(piece);
    }
    return Buffer.concat(chunks, total);
  }

  async head(key: string): Promise<StoredObjectMetadata | null> {
    const head = await this.client.headObject(key);
    if (!head) return null;
    const now = Date.now();
    if (isObjectExpired(head, now)) {
      await this.client.deleteObject(key).catch(() => undefined);
      return null;
    }
    return toStoredObjectMetadata(head, now);
  }

  async delete(key: string): Promise<boolean> {
    return this.client.deleteObject(key);
  }

  async createMultipart(key: string, metadata?: ObjectMetadata): Promise<MultipartSession> {
    const now = Date.now();
    // The object's expiry is fixed when the upload opens, so it must cover the longest open
    // session plus the time the finished object is meant to live.
    const ttlSeconds = (metadata?.ttlSeconds ?? this.defaultTtlSeconds) + MULTIPART_SESSION_TTL_MS / MS_PER_SECOND;
    const uploadId = await this.client.createMultipartUpload(
      key,
      buildPutOptions(this.providerName, key, { ...metadata, ttlSeconds }, now, this.defaultTtlSeconds)
    );
    return {
      uploadId,
      key,
      partSize: this.client.partSizeBytes,
      createdAt: now,
      expiresAt: now + MULTIPART_SESSION_TTL_MS,
      metadata,
    };
  }

  /** URL a client PUTs one part to directly on the object store; the part's ETag is in the response. */
  async presignPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds: number = DEFAULT_OBJECT_TTL_SECONDS
  ): Promise<StoragePresignedUrlResult> {
    const presigned = this.client.presignUploadPartUrl(key, uploadId, partNumber, expiresInSeconds);
    return {
      url: presigned.url,
      expiresAt: presigned.expiresAt,
      signature: presigned.signature,
      method: presigned.method,
    };
  }

  async completeMultipart(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
    expectedSize?: number
  ): Promise<StoredObjectMetadata> {
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    await this.client.completeMultipartUpload(
      key,
      uploadId,
      ordered.map((part) => ({ partNumber: part.partNumber, etag: part.etag }))
    );
    const head = await this.client.headObject(key);
    if (!head) {
      throw new StorageAdapterError(`Completed object "${key}" is not readable`, this.providerName);
    }
    if (expectedSize !== undefined && head.size !== expectedSize) {
      await this.client.deleteObject(key).catch(() => undefined);
      throw new StorageAdapterError(
        `Completed object is ${head.size} bytes but ${expectedSize} bytes were expected`,
        this.providerName
      );
    }
    return toStoredObjectMetadata(head, Date.now());
  }

  async abortMultipart(key: string, uploadId: string): Promise<boolean> {
    await this.client.abortMultipartUpload(key, uploadId);
    return true;
  }

  async presignGet(key: string, expiresInSeconds: number = DEFAULT_OBJECT_TTL_SECONDS): Promise<StoragePresignedUrlResult> {
    const presigned = this.client.presignGetUrl(key, expiresInSeconds);
    return {
      url: presigned.url,
      expiresAt: presigned.expiresAt,
      signature: presigned.signature,
      method: presigned.method,
    };
  }
}
