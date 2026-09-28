export * from './oci-storage';
export { S3ObjectStorageService, s3Storage } from './s3-storage';
export * from './shared-store';

import { s3Storage } from './s3-storage';
import type { IStorageBackend } from './oci-storage';

/**
 * SSOT Default Storage Provider Interface.
 * Used uniformly across API routes and backend workers to prevent tenancy/provider mismatch.
 */
export const storageProvider: IStorageBackend = s3Storage;
export const defaultStorage: IStorageBackend = s3Storage;
