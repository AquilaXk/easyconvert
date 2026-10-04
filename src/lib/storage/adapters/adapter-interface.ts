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

export class StorageSsrfError extends StorageAdapterError {
  constructor(hostOrUrl: string, provider: string) {
    super(`Blocked outbound connection to restricted host or IP: "${hostOrUrl}"`, provider);
    this.name = 'StorageSsrfError';
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
