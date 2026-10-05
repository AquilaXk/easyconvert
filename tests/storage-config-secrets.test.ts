import { describe, it, expect } from 'vitest';
import util from 'node:util';
import { resolveStorageConfig, isRemoteStorageConfig } from '../src/lib/storage/storage-config';

/**
 * The resolved storage configuration is a module-level export that logging, error reporting and
 * serializers can reach. The object store secret must not travel with it: it is readable only by
 * the code that asks for it by name.
 */

const OCI_SECRET = 'oci/secret+key/EXAMPLE000000000000';
const S3_SECRET = 's3/secret+key/EXAMPLE0000000000000';

const OCI_ENV = {
  STORAGE_DRIVER: 'oci',
  OCI_NAMESPACE: 'axyz123namespace',
  OCI_REGION: 'ap-seoul-1',
  OCI_BUCKET: 'easyconvert-internal',
  OCI_ACCESS_KEY_ID: 'ocikeyid0000000000001',
  OCI_SECRET_ACCESS_KEY: OCI_SECRET,
} as const;

const S3_ENV = {
  STORAGE_DRIVER: 's3',
  S3_ENDPOINT: 'https://objects.example.test',
  S3_REGION: 'eu-west-1',
  S3_BUCKET: 'internal-bucket',
  S3_ACCESS_KEY_ID: 's3keyid00000000000001',
  S3_SECRET_ACCESS_KEY: S3_SECRET,
} as const;

describe('the resolved storage configuration does not expose the secret key', () => {
  it.each([
    ['oci', OCI_ENV, OCI_SECRET],
    ['s3', S3_ENV, S3_SECRET],
  ])('keeps the %s secret out of serialization, enumeration, spreading and inspection', (_driver, env, secret) => {
    const config = resolveStorageConfig(env);
    expect(isRemoteStorageConfig(config)).toBe(true);
    if (!isRemoteStorageConfig(config)) return;

    expect(JSON.stringify(config)).not.toContain(secret);
    expect(Object.keys(config)).not.toContain('secretAccessKey');
    expect({ ...config }).not.toHaveProperty('secretAccessKey');
    expect(util.inspect(config, { depth: 4 })).not.toContain(secret);
    expect(String(JSON.stringify({ config }))).not.toContain(secret);

    // The code that builds the client still reads it by name.
    expect(config.secretAccessKey).toBe(secret);
    expect(config.accessKeyId).toBe(env.OCI_ACCESS_KEY_ID ?? env.S3_ACCESS_KEY_ID);
  });

  it('cannot be overwritten or redefined by a caller holding the config', () => {
    const config = resolveStorageConfig(OCI_ENV);
    if (!isRemoteStorageConfig(config)) throw new Error('expected a remote config');
    expect(() => {
      (config as { secretAccessKey: string }).secretAccessKey = 'replaced';
    }).toThrow(TypeError);
    expect(config.secretAccessKey).toBe(OCI_SECRET);
  });
});
