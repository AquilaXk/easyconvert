/**
 * Storage Streaming & Memory Boundary Errors and Constants.
 * Enforces zero-heap memory limits and fail-closed storage access.
 */

export const DEFAULT_MAX_IN_MEMORY_BYTES = 512 * 1024 * 1024; // 512 MiB

export function getMaxInMemoryBytes(): number {
  const envVal = process.env.MAX_IN_MEMORY_BYTES;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
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
