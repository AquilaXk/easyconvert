export * from './object-storage';
export * from './local-fs-storage';
export * from './s3-compatible-storage';
export * from './oci-storage';
export { S3ObjectStorageService, s3Storage } from './s3-storage';
export * from './shared-store';

import { s3Storage } from './s3-storage';
import { LocalFsStorage } from './local-fs-storage';
import { S3CompatibleStorage } from './s3-compatible-storage';
import type { IStorageBackend } from './oci-storage';

/**
 * Modern Stream-First Object Storage Singletons.
 */
export const localFsStorage = new LocalFsStorage();
export const s3CompatibleStorage = new S3CompatibleStorage();

/**
 * SSOT Default Storage Provider Interface.
 * Used uniformly across API routes and backend workers to prevent tenancy/provider mismatch.
 */
export const storageProvider: IStorageBackend = s3Storage;
export const defaultStorage: IStorageBackend = s3Storage;
