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
  S3ObjectClient,
  type ObjectHead,
  type PutObjectOptions,
  type S3ObjectClientConfig,
} from './s3-object-client';
import type { RemoteStorageConfig } from './storage-config';

/**
 * Object storage on an S3-compatible service: OCI Object Storage through its S3 compatibility
 * endpoint in production, or any other S3-compatible server. Objects, multipart sessions and
 * presigned URLs all live on the service and are signed with its credentials; nothing is spooled
 * to local disk and no state is held in process memory.
 *
 * Per-object attributes that S3 has no field for travel as `x-amz-meta-*` headers:
 *   filename    URL-encoded original filename
 *   expires-at  epoch milliseconds after which the object counts as gone
 *   uploaded-at epoch milliseconds of the upload
 *   custom      URL-encoded JSON of the caller's custom metadata
 * Expiry is enforced on read (an expired object reads as missing and is deleted); a bucket
 * lifecycle rule must still remove abandoned and expired objects and incomplete multipart uploads.
 */

const PROVIDER = 's3-compatible';
const DEFAULT_TTL_SECONDS = 3600;
const MULTIPART_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MS_PER_SECOND = 1000;
const META_FILENAME = 'filename';
const META_EXPIRES_AT = 'expires-at';
const META_UPLOADED_AT = 'uploaded-at';
const META_CUSTOM = 'custom';
/** Keeps the encoded custom metadata well inside S3's 2 KiB header budget. */
const MAX_CUSTOM_METADATA_BYTES = 1024;
const DEFAULT_MIME_TYPE = 'application/octet-stream';

export interface S3CompatibleStorageConfig extends Omit<S3ObjectClientConfig, 'bucket'> {
  bucketName: string;
  defaultTtlSeconds?: number;
}

function basename(key: string): string {
  const slash = key.lastIndexOf('/');
  return slash === -1 ? key : key.slice(slash + 1);
}

function parseEpochMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseCustomMetadata(raw: string | undefined): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(safeDecode(raw));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const result: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') result[name] = value;
    }
    return result;
  } catch {
    return undefined;
  }
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
    this.defaultTtlSeconds = defaultTtlSeconds ?? DEFAULT_TTL_SECONDS;
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
  // Metadata mapping
  // ---------------------------------------------------------------------------------------------

  private putOptions(key: string, metadata: ObjectMetadata | undefined, now: number): PutObjectOptions {
    const ttlSeconds = metadata?.ttlSeconds ?? this.defaultTtlSeconds;
    const headers: Record<string, string> = {
      [META_FILENAME]: encodeURIComponent(metadata?.filename || basename(key)),
      [META_UPLOADED_AT]: String(now),
      [META_EXPIRES_AT]: String(now + ttlSeconds * MS_PER_SECOND),
    };
    if (metadata?.customMetadata && Object.keys(metadata.customMetadata).length > 0) {
      const encoded = encodeURIComponent(JSON.stringify(metadata.customMetadata));
      if (encoded.length > MAX_CUSTOM_METADATA_BYTES) {
        throw new StorageAdapterError(
          `Custom metadata exceeds ${MAX_CUSTOM_METADATA_BYTES} encoded bytes`,
          this.providerName
        );
      }
      headers[META_CUSTOM] = encoded;
    }
    return { contentType: metadata?.contentType || DEFAULT_MIME_TYPE, metadata: headers };
  }

  private toStored(head: ObjectHead, now: number): StoredObjectMetadata {
    const uploadedAt = parseEpochMs(head.metadata[META_UPLOADED_AT]) ?? head.lastModified?.getTime() ?? now;
    const stored: StoredObjectMetadata = {
      key: head.key,
      size: head.size,
      etag: `"${head.etag}"`,
      mimeType: head.contentType || DEFAULT_MIME_TYPE,
      filename: safeDecode(head.metadata[META_FILENAME] ?? basename(head.key)),
      uploadedAt,
      expiresAt: parseEpochMs(head.metadata[META_EXPIRES_AT]) ?? 0,
    };
    const custom = parseCustomMetadata(head.metadata[META_CUSTOM]);
    if (custom) stored.metadata = custom;
    return stored;
  }

  /** Objects without an `expires-at` attribute were not written by this provider and never expire here. */
  private isExpired(head: ObjectHead, now: number): boolean {
    const expiresAt = parseEpochMs(head.metadata[META_EXPIRES_AT]);
    return expiresAt !== undefined && expiresAt <= now;
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
    const options = this.putOptions(key, metadata, now);
    const result = await this.client.putStream(key, stream, options);
    return this.storedFromPut(key, result.size, result.etag, options, now);
  }

  async putBuffer(key: string, buffer: Buffer, metadata?: ObjectMetadata): Promise<StoredObjectMetadata> {
    const now = Date.now();
    const options = this.putOptions(key, metadata, now);
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
    return this.toStored(
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
    if (this.isExpired(result, now)) {
      result.stream.destroy();
      await this.client.deleteObject(key).catch(() => undefined);
      return null;
    }
    return {
      stream: result.stream,
      metadata: this.toStored(result, now),
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
    if (this.isExpired(head, now)) {
      await this.client.deleteObject(key).catch(() => undefined);
      return null;
    }
    return this.toStored(head, now);
  }

  async delete(key: string): Promise<boolean> {
    return this.client.deleteObject(key);
  }

  async createMultipart(key: string, metadata?: ObjectMetadata): Promise<MultipartSession> {
    const now = Date.now();
    const uploadId = await this.client.createMultipartUpload(key, this.putOptions(key, metadata, now));
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
    expiresInSeconds: number = DEFAULT_TTL_SECONDS
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
    return this.toStored(head, Date.now());
  }

  async abortMultipart(key: string, uploadId: string): Promise<boolean> {
    await this.client.abortMultipartUpload(key, uploadId);
    return true;
  }

  async presignGet(key: string, expiresInSeconds: number = DEFAULT_TTL_SECONDS): Promise<StoragePresignedUrlResult> {
    const presigned = this.client.presignGetUrl(key, expiresInSeconds);
    return {
      url: presigned.url,
      expiresAt: presigned.expiresAt,
      signature: presigned.signature,
      method: presigned.method,
    };
  }
}
