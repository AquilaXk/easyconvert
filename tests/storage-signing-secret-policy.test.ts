import { describe, it, expect, afterEach, vi } from 'vitest';
import { StorageConfigError } from '../src/lib/storage/errors';
import {
  KNOWN_PUBLIC_SIGNING_SECRETS,
  MIN_PRODUCTION_SIGNING_SECRET_BYTES,
  assertSigningSecretConfigured,
  resolveSigningSecret,
  resolveStorageConfig,
} from '../src/lib/storage/storage-config';
import { createRemoteStorage } from '../src/lib/storage/remote-storage-factory';

/**
 * Production refuses a signing secret that anyone can read in the repository (the docker-compose
 * development default) and one too short to resist guessing. Outside production both are allowed,
 * so local development keeps its default.
 */

/** The development default in docker-compose.yml; it is public, so no production deployment may sign with it. */
const COMPOSE_DEV_SECRET = 'easyconvert-local-dev-signing-secret';
const STRONG_SECRET = 'a-production-signing-secret-of-sufficient-length-0001';
const SECRET_VARIABLES = ['STORAGE_SIGNING_SECRET', 'S3_SIGNING_SECRET', 'OCI_SIGNING_SECRET'] as const;
const PRODUCTION = { NODE_ENV: 'production' } as const;

function failureOf(work: () => unknown): unknown {
  try {
    work();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('signing secret policy', () => {
  it('lists the compose development default as a known public secret', () => {
    expect(KNOWN_PUBLIC_SIGNING_SECRETS.has(COMPOSE_DEV_SECRET)).toBe(true);
    expect(MIN_PRODUCTION_SIGNING_SECRET_BYTES).toBe(32);
  });

  describe('in production', () => {
    it.each(SECRET_VARIABLES)('refuses the public development secret in %s and names the variable, not the value', (variable) => {
      const err = failureOf(() => resolveSigningSecret({ ...PRODUCTION, [variable]: COMPOSE_DEV_SECRET }));
      expect(err).toBeInstanceOf(StorageConfigError);
      expect((err as StorageConfigError).message).toBe(`${variable} is a publicly known development secret and cannot be used in production.`);
      expect((err as StorageConfigError).message).not.toContain(COMPOSE_DEV_SECRET);
      expect((err as StorageConfigError).missing).toEqual([variable]);
    });

    it('refuses the public secret even when a stronger one is set under a lower-precedence name', () => {
      const env = { ...PRODUCTION, STORAGE_SIGNING_SECRET: COMPOSE_DEV_SECRET, OCI_SIGNING_SECRET: STRONG_SECRET };
      expect((failureOf(() => resolveSigningSecret(env)) as StorageConfigError).message).toBe(
        'STORAGE_SIGNING_SECRET is a publicly known development secret and cannot be used in production.'
      );
    });

    it('refuses a secret shorter than 32 bytes, counting bytes and not characters', () => {
      const short = failureOf(() => resolveSigningSecret({ ...PRODUCTION, STORAGE_SIGNING_SECRET: 'x'.repeat(31) }));
      expect(short).toBeInstanceOf(StorageConfigError);
      expect((short as StorageConfigError).message).toBe(
        'STORAGE_SIGNING_SECRET must be at least 32 bytes long in production.'
      );
      const multibyte = failureOf(() => resolveSigningSecret({ ...PRODUCTION, S3_SIGNING_SECRET: 'é'.repeat(15) }));
      expect(multibyte).toBeInstanceOf(StorageConfigError);
    });

    it('accepts a secret of exactly 32 bytes and a longer one', () => {
      expect(resolveSigningSecret({ ...PRODUCTION, STORAGE_SIGNING_SECRET: 'k'.repeat(32) })).toBe('k'.repeat(32));
      expect(resolveSigningSecret({ ...PRODUCTION, OCI_SIGNING_SECRET: 'é'.repeat(16) })).toBe('é'.repeat(16));
      expect(resolveSigningSecret({ ...PRODUCTION, STORAGE_SIGNING_SECRET: STRONG_SECRET })).toBe(STRONG_SECRET);
    });

    it('requires a secret for every driver at startup', () => {
      const err = failureOf(() => assertSigningSecretConfigured(PRODUCTION));
      expect(err).toBeInstanceOf(StorageConfigError);
      expect((err as StorageConfigError).missing).toEqual(['STORAGE_SIGNING_SECRET']);
      expect(failureOf(() => assertSigningSecretConfigured({ ...PRODUCTION, S3_SIGNING_SECRET: COMPOSE_DEV_SECRET }))).toBeInstanceOf(
        StorageConfigError
      );
      expect(assertSigningSecretConfigured({ ...PRODUCTION, OCI_SIGNING_SECRET: STRONG_SECRET })).toBeUndefined();
    });

    it('stops the remote storage factory from signing upload tokens with the public secret', () => {
      const env = {
        ...PRODUCTION,
        STORAGE_DRIVER: 'oci',
        OCI_NAMESPACE: 'axyz123namespace',
        OCI_REGION: 'ap-seoul-1',
        OCI_BUCKET: 'internal-objects',
        OCI_ACCESS_KEY_ID: 'ocikeyid0000000000001',
        OCI_SECRET_ACCESS_KEY: 'oci/secret+key/EXAMPLE000000000000',
        STORAGE_SIGNING_SECRET: COMPOSE_DEV_SECRET,
      };
      const config = resolveStorageConfig(env);
      if (config.driver === 'local') throw new Error('expected a remote config');
      expect(failureOf(() => createRemoteStorage(config, env))).toBeInstanceOf(StorageConfigError);
      expect(createRemoteStorage(config, { ...env, STORAGE_SIGNING_SECRET: STRONG_SECRET }).storageProvider.kind).toBe('remote');
    });
  });

  describe('outside production', () => {
    it.each([{}, { NODE_ENV: 'development' }, { NODE_ENV: 'test' }, { NODE_ENV: 'production', NEXT_PHASE: 'phase-production-build' }])(
      'keeps the development default and short secrets usable (%j)',
      (base) => {
        expect(resolveSigningSecret({ ...base, STORAGE_SIGNING_SECRET: COMPOSE_DEV_SECRET })).toBe(COMPOSE_DEV_SECRET);
        expect(resolveSigningSecret({ ...base, S3_SIGNING_SECRET: 'short' })).toBe('short');
        expect(assertSigningSecretConfigured({ ...base, OCI_SIGNING_SECRET: 'short' })).toBeUndefined();
      }
    );
  });
});

describe('the backends read the same policy', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  function stubProduction(secret: string): void {
    vi.stubEnv('NODE_ENV', 'production');
    for (const variable of SECRET_VARIABLES) vi.stubEnv(variable, '');
    vi.stubEnv('STORAGE_SIGNING_SECRET', secret);
    vi.stubEnv('APP_URL', 'https://app.example.com');
    vi.resetModules();
  }

  it('refuses to construct the local, S3-shaped and OCI-shaped backends with the public secret', async () => {
    stubProduction(COMPOSE_DEV_SECRET);
    const { LocalFsStorage } = await import('../src/lib/storage/local-fs-storage');
    const { S3ObjectStorageService } = await import('../src/lib/storage/s3-storage');
    const { OciObjectStorageService } = await import('../src/lib/storage/oci-storage');
    vi.stubEnv('OCI_NAMESPACE', 'tenant-oci-namespace');
    // The modules are reloaded here, so the error class is matched by its name and code.
    for (const construct of [() => new LocalFsStorage(), () => new S3ObjectStorageService(), () => new OciObjectStorageService()]) {
      expect(failureOf(construct)).toMatchObject({
        name: 'StorageConfigError',
        code: 'STORAGE_CONFIG_INVALID',
        message: 'STORAGE_SIGNING_SECRET is a publicly known development secret and cannot be used in production.',
      });
    }
  });

  it('stops the application at startup on the local driver, which has no remote credentials to fail on', async () => {
    stubProduction(COMPOSE_DEV_SECRET);
    vi.stubEnv('STORAGE_DRIVER', 'local');
    await expect(import('../src/lib/storage/selected-storage')).rejects.toMatchObject({
      name: 'StorageConfigError',
      code: 'STORAGE_CONFIG_INVALID',
    });
  });

  it('starts on the local driver with a strong secret', async () => {
    stubProduction(STRONG_SECRET);
    vi.stubEnv('STORAGE_DRIVER', 'local');
    const selected = await import('../src/lib/storage/selected-storage');
    expect(selected.storageConfig).toEqual({ driver: 'local' });
  });
});
