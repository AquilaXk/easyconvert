import { StorageAdapterError } from './adapters/adapter-interface';
import type { ObjectMetadata, StoredObjectMetadata } from './object-storage';
import type { ObjectHead, PutObjectOptions } from './s3-object-client';

/**
 * How per-object attributes that S3 has no field for travel as `x-amz-meta-*` headers. Both
 * object-store backends (S3CompatibleStorage and RemoteStorageBackend) use this one mapping, so an
 * object written by either is read correctly by the other:
 *
 *   filename    URL-encoded original filename
 *   expires-at  epoch milliseconds after which the object counts as gone
 *   uploaded-at epoch milliseconds of the upload
 *   custom      URL-encoded JSON of the caller's custom metadata
 *
 * Expiry is enforced on read; a bucket lifecycle rule must still remove abandoned and expired
 * objects and incomplete multipart uploads.
 */

export const META_FILENAME = 'filename';
export const META_EXPIRES_AT = 'expires-at';
export const META_UPLOADED_AT = 'uploaded-at';
export const META_CUSTOM = 'custom';

export const DEFAULT_OBJECT_TTL_SECONDS = 3600;
export const DEFAULT_MIME_TYPE = 'application/octet-stream';
const MS_PER_SECOND = 1000;
/** Keeps the encoded custom metadata well inside S3's 2 KiB header budget. */
export const MAX_CUSTOM_METADATA_BYTES = 1024;

export function basename(key: string): string {
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

/** Content type and `x-amz-meta-*` attributes for a new object written at `now`. */
export function buildPutOptions(
  provider: string,
  key: string,
  metadata: ObjectMetadata | undefined,
  now: number,
  defaultTtlSeconds: number = DEFAULT_OBJECT_TTL_SECONDS
): PutObjectOptions {
  const ttlSeconds = metadata?.ttlSeconds ?? defaultTtlSeconds;
  const headers: Record<string, string> = {
    [META_FILENAME]: encodeURIComponent(metadata?.filename || basename(key)),
    [META_UPLOADED_AT]: String(now),
    [META_EXPIRES_AT]: String(now + ttlSeconds * MS_PER_SECOND),
  };
  if (metadata?.customMetadata && Object.keys(metadata.customMetadata).length > 0) {
    const encoded = encodeURIComponent(JSON.stringify(metadata.customMetadata));
    if (encoded.length > MAX_CUSTOM_METADATA_BYTES) {
      throw new StorageAdapterError(`Custom metadata exceeds ${MAX_CUSTOM_METADATA_BYTES} encoded bytes`, provider);
    }
    headers[META_CUSTOM] = encoded;
  }
  return { contentType: metadata?.contentType || DEFAULT_MIME_TYPE, metadata: headers };
}

/** Attributes of an object as read back from the store; `etag` keeps its HTTP quotes. */
export function toStoredObjectMetadata(head: ObjectHead, now: number): StoredObjectMetadata {
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

/** Objects without an `expires-at` attribute were not written by these backends and never expire here. */
export function isObjectExpired(head: Pick<ObjectHead, 'metadata'>, now: number): boolean {
  const expiresAt = parseEpochMs(head.metadata[META_EXPIRES_AT]);
  return expiresAt !== undefined && expiresAt <= now;
}
