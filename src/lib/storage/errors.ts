/**
 * Storage Streaming & Memory Boundary Errors and Constants.
 * Enforces zero-heap memory limits and fail-closed storage access.
 */

export const DEFAULT_MAX_IN_MEMORY_BYTES = 512 * 1024 * 1024; // 512 MiB

export function getMaxInMemoryBytes(): number {
  const envVal = process.env.MAX_IN_MEMORY_BYTES;
  if (envVal) {
    const parsed = Number.parseInt(envVal, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_MAX_IN_MEMORY_BYTES;
}

export class PayloadTooLargeForMemoryError extends Error {
  readonly code = 'PAYLOAD_TOO_LARGE_FOR_MEMORY';
  readonly size?: number;
  readonly limit?: number;

  constructor(message?: string, options?: { size?: number; limit?: number }) {
    super(
      message ||
        `Stored object size (${options?.size ?? 'unknown'} bytes) exceeds the in-memory buffer limit of ${
          options?.limit ?? DEFAULT_MAX_IN_MEMORY_BYTES
        } bytes. Stream storage or native worker required.`
    );
    this.name = 'PayloadTooLargeForMemoryError';
    this.size = options?.size;
    this.limit = options?.limit;
  }
}

export class StoredObjectMissingError extends Error {
  readonly code = 'STORED_OBJECT_MISSING';
  readonly key?: string;
  readonly filePath?: string;

  constructor(message?: string, options?: { key?: string; filePath?: string }) {
    super(
      message ||
        `Stored object backing file is missing on disk or expired: key="${options?.key ?? 'unknown'}" filePath="${
          options?.filePath ?? 'unknown'
        }"`
    );
    this.name = 'StoredObjectMissingError';
    this.key = options?.key;
    this.filePath = options?.filePath;
  }
}

export interface ObjectStat {
  size: number;
  etag: string;
  mimeType: string;
  filename: string;
  filePath?: string;
}

/**
 * The storage driver or its credentials are not configured. Thrown at startup so a deployment
 * never runs on a fallback it did not choose; `missing` names every variable that was absent.
 */
export class StorageConfigError extends Error {
  readonly code = 'STORAGE_CONFIG_INVALID';
  readonly missing: readonly string[];

  constructor(message: string, missing: readonly string[] = []) {
    super(message);
    this.name = 'StorageConfigError';
    this.missing = missing;
  }
}

/**
 * A signing secret is required to mint or check a signature but none is configured. Signing with
 * a per-process random secret would give every process its own, unverifiable signatures.
 */
export class StorageSigningSecretMissingError extends Error {
  readonly code = 'STORAGE_SIGNING_SECRET_MISSING';

  constructor(message?: string) {
    super(
      message ??
        'No storage signing secret is configured. Set STORAGE_SIGNING_SECRET (or S3_SIGNING_SECRET / OCI_SIGNING_SECRET).'
    );
    this.name = 'StorageSigningSecretMissingError';
  }
}

/** The configured storage backend cannot mint the requested kind of URL. */
export class StoragePresignUnavailableError extends Error {
  readonly code = 'STORAGE_PRESIGN_UNAVAILABLE';

  constructor(message: string) {
    super(message);
    this.name = 'StoragePresignUnavailableError';
  }
}
