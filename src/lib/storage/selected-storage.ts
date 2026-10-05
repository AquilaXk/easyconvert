import { localFsStorage } from './local-fs-storage';
import type { IObjectStorage } from './object-storage';
import type { IStorageBackend } from './oci-storage';
import { createRemoteStorage } from './remote-storage-factory';
import { s3Storage } from './s3-storage';
import { isRemoteStorageConfig, resolveStorageConfig, type StorageConfig } from './storage-config';

/**
 * Storage selection, made once at startup from STORAGE_DRIVER (see storage-config.ts). An
 * unconfigured production deployment, or a remote driver with any credential missing, throws when
 * this module loads rather than falling back to local disk.
 */
export const storageConfig: StorageConfig = resolveStorageConfig();

const remote = isRemoteStorageConfig(storageConfig) ? createRemoteStorage(storageConfig) : undefined;

/**
 * Stream-first object storage used by uploads and BYOS transfers: the object store for
 * STORAGE_DRIVER=oci|s3, local disk for STORAGE_DRIVER=local.
 */
export const objectStorage: IObjectStorage = remote ? remote.objectStorage : localFsStorage;

/**
 * Job storage used by the API routes, the queue and the worker: the object store for
 * STORAGE_DRIVER=oci|s3, local disk for STORAGE_DRIVER=local.
 */
export const storageProvider: IStorageBackend = remote ? remote.storageProvider : s3Storage;
