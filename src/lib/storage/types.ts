import type { MultipartUploadComplete, MultipartUploadInit, UploadedPart } from '../types';
import type { ObjectStat } from './errors';

export type { ObjectStat } from './errors';

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
  /**
   * Frees resources held for this read, such as a scratch file a remote backend staged for it. The
   * object itself stays in storage. Absent when there is nothing to free (local backends).
   */
  release?: () => Promise<void>;
}

export interface PresignedUrlResult {
  url: string;
  expiresAt: number;
  signature: string;
}

/** A result that a local backend returns directly and a remote backend returns after a network call. */
export type MaybePromise<T> = T | Promise<T>;

/** What callers may know about an open multipart upload session. */
export interface UploadSessionInfo {
  uploadId: string;
  key: string;
  filename: string;
  mimeType: string;
  totalSize: number;
  partSize: number;
  totalParts: number;
  createdAt: number;
  ownerUserId?: string;
}

/**
 * Job-oriented storage used by the API routes, the queue, and the worker. `kind` says where the
 * bytes live: `local` backends keep them on this host's disk and answer synchronously; `remote`
 * backends keep them in the S3-compatible object store and answer asynchronously. Every caller
 * must `await` the results, which is a no-op for a local backend.
 */
export interface IStorageBackend {
  readonly providerName: string;
  readonly kind: 'local' | 'remote';
  initiateMultipartUpload(
    filename: string,
    mimeType: string,
    totalSize: number,
    ownerUserId?: string,
    partSize?: number
  ): MaybePromise<MultipartUploadInit>;
  uploadPart(uploadId: string, partNumber: number, buffer: Buffer): MaybePromise<UploadedPart>;
  /** Receives one part from a request body; the limits throw an error with `statusCode` 413. */
  uploadPartStream?(
    uploadId: string,
    partNumber: number,
    stream: NodeJS.ReadableStream | ReadableStream<Uint8Array>,
    maxPartBytes?: number,
    maxTotalBytes?: number,
    currentSessionBytes?: number
  ): Promise<UploadedPart>;
  completeMultipartUpload(
    uploadId: string,
    expectedParts?: { partNumber: number; etag?: string }[]
  ): MaybePromise<MultipartUploadComplete>;
  abortMultipartUpload(uploadId: string): MaybePromise<boolean>;
  getUploadSession?(uploadId: string): MaybePromise<UploadSessionInfo | undefined>;
  getUploadOwner?(uploadId: string): MaybePromise<string | undefined>;
  /** The ids of the open multipart uploads `ownerUserId` started, for the erasure of an account; rejects when they cannot be listed. */
  uploadSessionsOfOwner?(ownerUserId: string): MaybePromise<string[]>;
  /** Aborts every open multipart upload `ownerUserId` started with the parts it holds, and answers their ids; rejects when one cannot be aborted. */
  abortUploadSessionsOfOwner?(ownerUserId: string): MaybePromise<string[]>;
  /** Parts received so far for an open session, in any order; undefined when the session is unknown. */
  getUploadedParts?(
    uploadId: string
  ): MaybePromise<Array<{ partNumber: number; etag: string; size: number }> | undefined>;
  saveObject(key: string, buffer: Buffer, mimeType: string, filename: string, ttlMs?: number): MaybePromise<StoredObject>;
  /** Stores the regular file at `filePath`; a `signal` that aborts before the object is in place stores nothing. */
  saveObjectFromFile?(
    key: string,
    filePath: string,
    mimeType: string,
    filename: string,
    ttlMs?: number,
    signal?: AbortSignal
  ): MaybePromise<StoredObject>;
  saveObjectFromStream(
    key: string,
    stream: NodeJS.ReadableStream,
    meta: { filename: string; mimeType: string; size?: number },
    ttlMs?: number
  ): Promise<StoredObject>;
  getObject(key: string): MaybePromise<StoredObject | undefined>;
  /** Size, ETag, type and name of an object without reading it. */
  stat(key: string): MaybePromise<ObjectStat | null>;
  openReadStream(key: string, range?: { start: number; end: number }): MaybePromise<NodeJS.ReadableStream | null>;
  getObjectStream?(key: string, range?: { start: number; end: number }): MaybePromise<NodeJS.ReadableStream | null>;
  deleteObject(key: string): MaybePromise<boolean>;
  /** Deletes the object under `key` only while it is still the save `written` describes, by its ETag and the time it was stored. */
  deleteObjectIfUnchanged?(key: string, written: Pick<StoredObject, 'etag' | 'uploadedAt'>): MaybePromise<boolean>;
  deleteByPrefix?(prefix: string): MaybePromise<number>;
  /** Open upload sessions, or null when the backend cannot count them (sessions live on the object store). */
  getActiveSessionsCount(): MaybePromise<number | null>;
  /** Stored objects, or null when the backend cannot count them cheaply. */
  getObjectsCount(): MaybePromise<number | null>;
  /**
   * Raises the expiry of an object so that it outlives the lifetime it was stored with, for every process that reads
   * it; an expiry that is later already stays. False when there is no such object; rejects when the new expiry could not be written. Absent on a backend whose objects
   * carry their expiry in the store.
   */
  extendExpiry?(key: string, expiresAt: number): MaybePromise<boolean>;
  sweepExpiredObjects?(now?: number): number;
  stopGc?(): void;
  generatePresignedUploadUrl?(
    key: string,
    partNumber: number,
    uploadId: string,
    expiresInSeconds?: number
  ): MaybePromise<PresignedUrlResult>;
  generatePresignedUploadPartUrl?(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds?: number
  ): MaybePromise<PresignedUrlResult>;
  generatePresignedHmacPartUrl?(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds?: number
  ): PresignedUrlResult;
  generatePresignedDownloadUrl?(key: string, expiresInSeconds?: number): MaybePromise<PresignedUrlResult>;
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
