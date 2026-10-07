export * from './object-storage';
export * from './local-fs-storage';
export * from './s3-compatible-storage';
export * from './oci-storage';
export { S3ObjectStorageService, s3Storage } from './s3-storage';
export * from './shared-store';
export * from './errors';
export * from './credentials-vault';
export * from './adapters';
export * from './byos-operations';
export { RemoteStorageBackend } from './remote-storage-backend';
export {
  isRemoteStorageConfig,
  resolveStorageConfig,
  type StorageConfig,
  type StorageDriver,
} from './storage-config';
export { objectStorage, storageConfig, storageProvider } from './selected-storage';

import { storageProvider } from './selected-storage';
import type { IStorageBackend } from './oci-storage';

/**
 * SSOT Default Storage Provider Interface.
 * Used uniformly across API routes and backend workers to prevent tenancy/provider mismatch.
 */
export const defaultStorage: IStorageBackend = storageProvider;
