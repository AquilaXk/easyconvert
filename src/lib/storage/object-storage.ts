import type { Readable } from 'node:stream';

export interface ByteRange {
  start: number;
  end: number;
}

export interface ObjectMetadata {
  contentType?: string;
  filename?: string;
  customMetadata?: Record<string, string>;
  ttlSeconds?: number;
}

export interface StoredObjectMetadata {
  key: string;
  size: number;
  etag: string;
  mimeType: string;
  filename: string;
  uploadedAt: number;
  expiresAt: number;
  metadata?: Record<string, string>;
}

export interface ObjectReadStream {
  stream: NodeJS.ReadableStream;
  metadata: StoredObjectMetadata;
  range?: ByteRange;
}

export interface MultipartSession {
  uploadId: string;
  key: string;
  partSize: number;
  createdAt: number;
  expiresAt: number;
  metadata?: ObjectMetadata;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
  size?: number;
}

export interface StoragePresignedUrlResult {
  url: string;
  expiresAt: number;
  signature: string;
  method?: string;
}

/**
 * Universal Async Stream-First Object Storage Interface.
 * Standardizes storage abstraction across the local filesystem and S3-compatible object stores
 * (OCI Object Storage S3 Compatibility API, MinIO, and other S3-compatible services).
 */
export interface IObjectStorage {
  readonly providerName: string;

  /**
   * Stores an object from a readable stream without holding the full payload in RAM.
   */
  putStream(
    key: string,
    stream: NodeJS.ReadableStream | ReadableStream<Uint8Array>,
    metadata?: ObjectMetadata
  ): Promise<StoredObjectMetadata>;

  /**
   * Stores an object directly from a Buffer in memory.
   */
  putBuffer(
    key: string,
    buffer: Buffer,
    metadata?: ObjectMetadata
  ): Promise<StoredObjectMetadata>;

  /**
   * Retrieves a streaming reader for an object with optional byte range slicing.
   */
  getStream(key: string, range?: ByteRange): Promise<ObjectReadStream | null>;

  /**
   * Retrieves an entire object into a Buffer.
   */
  getBuffer(key: string): Promise<Buffer | null>;

  /**
   * Checks existence and retrieves metadata for an object without reading content.
   */
  head(key: string): Promise<StoredObjectMetadata | null>;

  /**
   * Deletes an object.
   */
  delete(key: string): Promise<boolean>;

  /**
   * Initiates a multipart upload session.
   */
  createMultipart(key: string, metadata?: ObjectMetadata): Promise<MultipartSession>;

  /**
   * Generates a signed presigned URL for uploading a specific part.
   */
  presignPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds?: number
  ): Promise<StoragePresignedUrlResult>;

  /**
   * Assembles and finalizes uploaded parts into a single stored object.
   */
  completeMultipart(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
    expectedSize?: number
  ): Promise<StoredObjectMetadata>;

  /**
   * Aborts an active multipart upload and purges any buffered part artifacts.
   */
  abortMultipart(key: string, uploadId: string): Promise<boolean>;

  /**
   * Generates a signed presigned GET URL for direct download.
   */
  presignGet(key: string, expiresInSeconds?: number): Promise<StoragePresignedUrlResult>;

  /**
   * Validates authenticity and expiration of a signature this provider minted itself. Only a
   * provider that serves its own URLs implements it; a remote object store verifies its own
   * presigned URLs, so an S3-compatible provider has nothing to check here.
   */
  verifyPresignedSignature?(
    method: string,
    key: string,
    expiresAt: number,
    signature: string,
    uploadId?: string,
    partNumber?: number
  ): boolean;
}
