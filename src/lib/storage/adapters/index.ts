export * from './adapter-interface';
export * from './s3';
export * from './gcs';
export * from './azure-blob';
export * from './webdav';
export * from './sftp';

import type { CustomerStorageCredentials } from '../credentials-vault';
import type { IStorageAdapter } from './adapter-interface';
import { S3StorageAdapter } from './s3';
import { GcsStorageAdapter } from './gcs';
import { AzureBlobStorageAdapter } from './azure-blob';
import { WebDavStorageAdapter } from './webdav';
import { SftpStorageAdapter } from './sftp';

/**
 * Instantiates the appropriate storage adapter for given customer BYOS credentials.
 */
export function createStorageAdapter(credentials: CustomerStorageCredentials): IStorageAdapter {
  switch (credentials.type) {
    case 's3':
      return new S3StorageAdapter(credentials);
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
