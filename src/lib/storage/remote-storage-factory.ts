import { StorageConfigError } from './errors';
import type { IObjectStorage } from './object-storage';
import type { IStorageBackend } from './oci-storage';
import { RemoteStorageBackend } from './remote-storage-backend';
import { S3CompatibleStorage } from './s3-compatible-storage';
import { resolveSigningSecret, type RemoteStorageConfig } from './storage-config';

export interface RemoteStorage {
  objectStorage: IObjectStorage;
  storageProvider: IStorageBackend;
}

/**
 * Builds both storage interfaces over one object-store client for STORAGE_DRIVER=oci|s3. The
 * signing secret that protects upload session tokens must be configured: without it a token
 * could not be verified by the next instance, and none is invented.
 */
export function createRemoteStorage(
  config: RemoteStorageConfig,
  env: Readonly<Record<string, string | undefined>> = process.env
): RemoteStorage {
  const signingSecret = resolveSigningSecret(env);
  if (!signingSecret) {
    throw new StorageConfigError(
      `Storage driver "${config.driver}" is missing required configuration: STORAGE_SIGNING_SECRET.`,
      ['STORAGE_SIGNING_SECRET']
    );
  }
  const objectStorage = S3CompatibleStorage.fromConfig(config);
  return {
    objectStorage,
    storageProvider: new RemoteStorageBackend(objectStorage.client, { signingSecret, providerName: config.driver }),
  };
}
