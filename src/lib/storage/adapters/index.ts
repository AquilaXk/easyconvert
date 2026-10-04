export * from './adapter-interface';
export * from './gcs';
export * from './azure-blob';
export * from './webdav';
export * from './sftp';

import type { CustomerStorageCredentials } from '../credentials-vault';
import { StorageProviderUnavailableError, type IStorageAdapter } from './adapter-interface';
import { GcsStorageAdapter } from './gcs';
import { AzureBlobStorageAdapter } from './azure-blob';
import { WebDavStorageAdapter } from './webdav';
import { SftpStorageAdapter } from './sftp';

/**
 * Providers whose adapter has no network client yet. Registration and every import/export
 * through them fail closed until a real client exists.
 */
export const UNAVAILABLE_STORAGE_PROVIDERS: ReadonlySet<string> = new Set(['s3']);

/**
 * Instantiates the appropriate storage adapter for given customer BYOS credentials.
 */
export function createStorageAdapter(credentials: CustomerStorageCredentials): IStorageAdapter {
  switch (credentials.type) {
    case 's3':
      throw new StorageProviderUnavailableError(credentials.type);
    case 'gcs':
      return new GcsStorageAdapter(credentials);
    case 'azure-blob':
      return new AzureBlobStorageAdapter(credentials);
    case 'webdav':
      return new WebDavStorageAdapter(credentials);
    case 'sftp':
      return new SftpStorageAdapter(credentials);
    default:
      throw new Error(`Unsupported storage adapter provider type: "${(credentials as { type: string }).type}"`);
  }
}
