import { redactText } from '../../security/redact';

export interface StorageAdapterMetadata {
  size: number;
  etag?: string;
  contentType?: string;
  lastModified?: Date;
}

export class StorageAdapterError extends Error {
  constructor(message: string, public readonly provider: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'StorageAdapterError';
  }
}

/**
 * The caller supplied a value the store cannot accept (a bad size, part number, expiry, content type
 * or metadata). It is the caller's mistake, so an API maps it to HTTP 400.
 */
export class StorageInputError extends StorageAdapterError {
  constructor(message: string, provider: string, cause?: unknown) {
    super(message, provider, cause);
    this.name = 'StorageInputError';
  }
}

/** An object key the store cannot address safely (empty, or with "." / ".." path segments). */
export class StorageInvalidKeyError extends StorageInputError {
  constructor(message: string, provider: string, cause?: unknown) {
    super(message, provider, cause);
    this.name = 'StorageInvalidKeyError';
  }
}

export class StorageNotFoundError extends StorageAdapterError {
  constructor(path: string, provider: string) {
    super(`Remote object not found: "${path}"`, provider);
    this.name = 'StorageNotFoundError';
  }
}

export class StorageAuthenticationError extends StorageAdapterError {
  constructor(message: string, provider: string) {
    super(`Storage authentication failed: ${message}`, provider);
    this.name = 'StorageAuthenticationError';
  }
}

/** The provider has no working network client yet; refusing beats writing to a local stand-in. */
export class StorageProviderUnavailableError extends StorageAdapterError {
  constructor(provider: string) {
    super(`Storage provider "${provider}" is not available for customer storage.`, provider);
    this.name = 'StorageProviderUnavailableError';
  }
}

export class StorageSsrfError extends StorageAdapterError {
  constructor(hostOrUrl: string, provider: string) {
    // The target may be a caller-supplied signed URL, so userinfo and query are masked in the message.
    super(`Blocked outbound connection to restricted host or IP: "${redactText(hostOrUrl)}"`, provider);
    this.name = 'StorageSsrfError';
  }
}

export interface StorageServiceErrorDetails {
  statusCode?: number;
  /** Provider error code, e.g. "SlowDown" or "InternalError". */
  code?: string;
  requestId?: string;
  retryable: boolean;
}

/** The remote storage service rejected or failed a request for a reason other than auth or a missing object. */
export class StorageServiceError extends StorageAdapterError {
  readonly statusCode?: number;
  readonly code?: string;
  readonly requestId?: string;
  readonly retryable: boolean;

  constructor(message: string, provider: string, details: StorageServiceErrorDetails, cause?: unknown) {
    super(message, provider, cause);
    this.name = 'StorageServiceError';
    this.statusCode = details.statusCode;
    this.code = details.code;
    this.requestId = details.requestId;
    this.retryable = details.retryable;
  }
}

/** The remote storage service did not answer within the request timeout. */
export class StorageTimeoutError extends StorageAdapterError {
  constructor(timeoutMs: number, provider: string) {
    super(`Storage request timed out after ${timeoutMs} ms`, provider);
    this.name = 'StorageTimeoutError';
  }
}

export interface IStorageAdapter {
  readonly providerName: string;

  /**
   * Streams content from remote storage.
   */
  downloadStream(remotePath: string): Promise<NodeJS.ReadableStream>;

  /**
   * Uploads stream to remote storage without full memory buffering.
   */
  uploadStream(
    remotePath: string,
    stream: NodeJS.ReadableStream | ReadableStream<Uint8Array>,
    options?: { contentType?: string; size?: number }
  ): Promise<StorageAdapterMetadata>;

  /**
   * Checks existence and gets metadata for a remote object.
   */
  head(remotePath: string): Promise<StorageAdapterMetadata | null>;

  /**
   * Deletes a remote object.
   */
  delete(remotePath: string): Promise<boolean>;
}
