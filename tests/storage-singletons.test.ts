import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveSigningSecret } from '../src/lib/storage/storage-config';

/**
 * One signing-secret rule for every backend, and no local-disk machinery for a remote driver:
 * importing the storage module under STORAGE_DRIVER=oci|s3 must not create the local storage
 * directories, start their sweepers, or demand a secret under a name the remote backend ignores.
 */

const PRODUCTION = 'production';

describe('signing secret resolution', () => {
  it('reads one precedence for every consumer', () => {
    expect(
      resolveSigningSecret({ STORAGE_SIGNING_SECRET: 'storage', S3_SIGNING_SECRET: 's3', OCI_SIGNING_SECRET: 'oci' })
    ).toBe('storage');
    expect(resolveSigningSecret({ S3_SIGNING_SECRET: 's3', OCI_SIGNING_SECRET: 'oci' })).toBe('s3');
    expect(resolveSigningSecret({ OCI_SIGNING_SECRET: 'oci' })).toBe('oci');
    expect(resolveSigningSecret({ STORAGE_SIGNING_SECRET: '   ', OCI_SIGNING_SECRET: 'oci' })).toBe('oci');
    expect(resolveSigningSecret({})).toBeUndefined();
  });
});

describe('storage selection does not set up local disk storage for a remote driver', () => {
  let scratch: string;
  let storageDir: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-singletons-'));
    storageDir = path.join(scratch, 'must-not-exist');
    vi.stubEnv('EASYCONVERT_STORAGE_DIR', storageDir);
    vi.stubEnv('OCI_NAMESPACE', 'axyz123namespace');
    vi.stubEnv('OCI_REGION', 'ap-seoul-1');
    vi.stubEnv('OCI_BUCKET', 'internal-objects');
    vi.stubEnv('OCI_ACCESS_KEY_ID', 'AKIAOCIEXAMPLE0000001');
    vi.stubEnv('OCI_SECRET_ACCESS_KEY', 'oci/Secret+Key/EXAMPLEKEY000000000000000');
    vi.stubEnv('STORAGE_SIGNING_SECRET', '');
    vi.stubEnv('S3_SIGNING_SECRET', '');
    vi.stubEnv('OCI_SIGNING_SECRET', 'only-the-oci-named-signing-secret');
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('starts in production on the OCI driver with a signing secret under any accepted name', async () => {
    vi.stubEnv('NODE_ENV', PRODUCTION);
    vi.stubEnv('STORAGE_DRIVER', 'oci');
    const storage = await import('../src/lib/storage');
    expect(storage.storageConfig.driver).toBe('oci');
    expect(storage.storageProvider.kind).toBe('remote');
  });

  it('leaves the local storage directory uncreated while the remote driver is in use', async () => {
    vi.stubEnv('STORAGE_DRIVER', 'oci');
    const storage = await import('../src/lib/storage');
    expect(storage.storageProvider.kind).toBe('remote');
    expect(fs.existsSync(storageDir)).toBe(false);
  });

  it('still builds the local backends on first use and serves them from the same instance', async () => {
    vi.stubEnv('STORAGE_DRIVER', 'local');
    vi.stubEnv('STORAGE_SIGNING_SECRET', 'local-driver-signing-secret-0001');
    const storage = await import('../src/lib/storage');
    expect(storage.storageProvider.kind).toBe('local');
    expect(storage.objectStorage).toBeInstanceOf(storage.LocalFsStorage);
    expect(storage.objectStorage).toBe(storage.localFsStorage);
    await storage.objectStorage.putBuffer('uploads/a.txt', Buffer.from('hello'), { contentType: 'text/plain' });
    expect(fs.existsSync(storageDir)).toBe(true);
    expect((await storage.objectStorage.getBuffer('uploads/a.txt'))?.toString()).toBe('hello');
    storage.localFsStorage.stopGc();
  });
});
