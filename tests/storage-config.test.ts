import { describe, it, expect, beforeEach } from 'vitest';
import {
  StorageConfigError,
} from '../src/lib/storage/errors';
import {
  isRemoteStorageConfig,
  resetStorageConfigWarnings,
  resolveAppBaseUrl,
  resolveSigningSecret,
  resolveStorageConfig,
  resolveStorageDriver,
} from '../src/lib/storage/storage-config';

/**
 * The expected OCI endpoint shape comes from the Oracle documentation ("Amazon S3 Compatibility
 * API"): https://<namespace>.compat.objectstorage.<region>.oraclecloud.com. Every env below is an
 * explicit object, so nothing here depends on the process environment.
 */

const OCI_ENV = {
  STORAGE_DRIVER: 'oci',
  OCI_NAMESPACE: 'axyz123namespace',
  OCI_REGION: 'ap-seoul-1',
  OCI_BUCKET: 'easyconvert-internal',
  OCI_ACCESS_KEY_ID: 'ocikeyid0000000000001',
  OCI_SECRET_ACCESS_KEY: 'oci/secret+key/EXAMPLE000000000000',
} as const;

const S3_ENV = {
  STORAGE_DRIVER: 's3',
  S3_ENDPOINT: 'https://objects.example.test',
  S3_REGION: 'eu-west-1',
  S3_BUCKET: 'internal-bucket',
  S3_ACCESS_KEY_ID: 's3keyid00000000000001',
  S3_SECRET_ACCESS_KEY: 's3/secret+key/EXAMPLE0000000000000',
} as const;

function collectWarnings(): { warnings: string[]; warn: (message: string) => void } {
  const warnings: string[] = [];
  return { warnings, warn: (message) => void warnings.push(message) };
}

describe('storage driver selection', () => {
  beforeEach(() => {
    resetStorageConfigWarnings();
  });

  it('defaults to local outside production', () => {
    expect(resolveStorageDriver({ NODE_ENV: 'development' })).toBe('local');
    expect(resolveStorageDriver({ NODE_ENV: 'test' })).toBe('local');
    expect(resolveStorageDriver({})).toBe('local');
  });

  it('requires the driver to be chosen in production', () => {
    const error = (() => {
      try {
        resolveStorageDriver({ NODE_ENV: 'production' });
      } catch (err) {
        return err;
      }
    })();
    expect(error).toBeInstanceOf(StorageConfigError);
    expect((error as StorageConfigError).missing).toEqual(['STORAGE_DRIVER']);
  });

  it('does not enforce anything while Next.js builds', () => {
    const { warn, warnings } = collectWarnings();
    const config = resolveStorageConfig({ NODE_ENV: 'production', NEXT_PHASE: 'phase-production-build' }, { warn });
    expect(config).toEqual({ driver: 'local' });
    expect(warnings).toEqual([]);
  });

  it.each(['gcs', 'azure', 'memory', 'OCI2', 'true'])('rejects the unknown driver %s', (driver) => {
    expect(() => resolveStorageDriver({ STORAGE_DRIVER: driver })).toThrow(StorageConfigError);
  });

  it('accepts the three drivers case-insensitively', () => {
    expect(resolveStorageDriver({ STORAGE_DRIVER: 'OCI' })).toBe('oci');
    expect(resolveStorageDriver({ STORAGE_DRIVER: ' s3 ' })).toBe('s3');
    expect(resolveStorageDriver({ STORAGE_DRIVER: 'Local' })).toBe('local');
  });

  it('allows local in production explicitly and says so once', () => {
    const { warn, warnings } = collectWarnings();
    expect(resolveStorageConfig({ NODE_ENV: 'production', STORAGE_DRIVER: 'local' }, { warn })).toEqual({ driver: 'local' });
    resolveStorageConfig({ NODE_ENV: 'production', STORAGE_DRIVER: 'local' }, { warn });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('STORAGE_DRIVER=local');
  });
});

describe('oci driver configuration', () => {
  beforeEach(() => {
    resetStorageConfigWarnings();
  });

  it('derives the namespace compat endpoint with path-style addressing', () => {
    const config = resolveStorageConfig(OCI_ENV);
    expect(config).toEqual({
      driver: 'oci',
      endpoint: 'https://axyz123namespace.compat.objectstorage.ap-seoul-1.oraclecloud.com',
      region: 'ap-seoul-1',
      bucket: 'easyconvert-internal',
      accessKeyId: OCI_ENV.OCI_ACCESS_KEY_ID,
      secretAccessKey: OCI_ENV.OCI_SECRET_ACCESS_KEY,
      forcePathStyle: true,
      namespace: 'axyz123namespace',
    });
    expect(isRemoteStorageConfig(config)).toBe(true);
  });

  it('accepts the previous bucket variable name', () => {
    const { OCI_BUCKET: _omit, ...rest } = OCI_ENV;
    const config = resolveStorageConfig({ ...rest, OCI_BUCKET_NAME: 'legacy-named-bucket' });
    expect(config).toMatchObject({ bucket: 'legacy-named-bucket' });
  });

  it('lets OCI_ENDPOINT override the derived host', () => {
    const config = resolveStorageConfig({ ...OCI_ENV, OCI_ENDPOINT: 'https://private.objects.internal:8443/ignored/path' });
    expect(config).toMatchObject({ endpoint: 'https://private.objects.internal:8443' });
  });

  it.each([
    ['OCI_NAMESPACE', ['OCI_NAMESPACE']],
    ['OCI_REGION', ['OCI_REGION']],
    ['OCI_BUCKET', ['OCI_BUCKET']],
    ['OCI_ACCESS_KEY_ID', ['OCI_ACCESS_KEY_ID']],
    ['OCI_SECRET_ACCESS_KEY', ['OCI_SECRET_ACCESS_KEY']],
  ])('throws naming %s when it is missing', (name, expectedMissing) => {
    const env: Record<string, string | undefined> = { ...OCI_ENV };
    delete env[name];
    const error = (() => {
      try {
        resolveStorageConfig(env);
      } catch (err) {
        return err;
      }
    })() as StorageConfigError;
    expect(error).toBeInstanceOf(StorageConfigError);
    expect(error.missing).toEqual(expectedMissing);
    expect(error.message).toContain(name);
  });

  it('throws in production without any credential and lists everything that is missing', () => {
    const error = (() => {
      try {
        resolveStorageConfig({ NODE_ENV: 'production', STORAGE_DRIVER: 'oci' });
      } catch (err) {
        return err;
      }
    })() as StorageConfigError;
    expect(error).toBeInstanceOf(StorageConfigError);
    expect(error.missing).toEqual([
      'OCI_NAMESPACE',
      'OCI_REGION',
      'OCI_BUCKET',
      'OCI_ACCESS_KEY_ID',
      'OCI_SECRET_ACCESS_KEY',
    ]);
  });

  it('treats empty and blank values as missing', () => {
    expect(() => resolveStorageConfig({ ...OCI_ENV, OCI_ACCESS_KEY_ID: '' })).toThrow(/OCI_ACCESS_KEY_ID/);
    expect(() => resolveStorageConfig({ ...OCI_ENV, OCI_SECRET_ACCESS_KEY: '   ' })).toThrow(/OCI_SECRET_ACCESS_KEY/);
  });

  it('refuses to start the oci driver outside production when configuration is missing, with no fallback to disk', () => {
    expect(() => resolveStorageConfig({ NODE_ENV: 'development', STORAGE_DRIVER: 'oci' })).toThrow(StorageConfigError);
  });

  it.each([
    ['a namespace that smuggles in another host', { OCI_NAMESPACE: 'evil.example/x' }],
    ['a namespace with a path separator', { OCI_NAMESPACE: 'ns/../x' }],
    ['a namespace with a port', { OCI_NAMESPACE: 'ns:8080' }],
    ['a region with uppercase or dots', { OCI_REGION: 'AP.Seoul' }],
    ['an endpoint override that is not a URL', { OCI_ENDPOINT: 'not a url' }],
    ['an endpoint override with user info', { OCI_ENDPOINT: 'https://u:p@host.example' }],
    ['a plain-http endpoint override in production', { NODE_ENV: 'production', OCI_ENDPOINT: 'http://127.0.0.1:9000' }],
  ])('rejects %s', (_name, override) => {
    expect(() => resolveStorageConfig({ ...OCI_ENV, ...override })).toThrow(StorageConfigError);
  });

  it('allows a plain-http endpoint override outside production for a local test server', () => {
    expect(resolveStorageConfig({ ...OCI_ENV, OCI_ENDPOINT: 'http://127.0.0.1:9000' })).toMatchObject({
      endpoint: 'http://127.0.0.1:9000',
    });
  });

  it('never puts a secret into an error message or a warning', () => {
    const { warn, warnings } = collectWarnings();
    const env = { ...OCI_ENV, OCI_REGION: undefined, AWS_SECRET_ACCESS_KEY: 'aws-secret-value-must-not-leak' };
    try {
      resolveStorageConfig(env, { warn });
    } catch (err) {
      expect((err as Error).message).not.toContain(OCI_ENV.OCI_SECRET_ACCESS_KEY);
      expect((err as Error).message).not.toContain('aws-secret-value-must-not-leak');
    }
    expect(warnings.join('\n')).not.toContain(OCI_ENV.OCI_SECRET_ACCESS_KEY);
  });
});

describe('deprecated AWS_* fallback', () => {
  beforeEach(() => {
    resetStorageConfigWarnings();
  });

  it('is used only for values the driver variables do not provide, and warns exactly once', () => {
    const { warn, warnings } = collectWarnings();
    const env = {
      STORAGE_DRIVER: 'oci',
      OCI_NAMESPACE: 'axyz123namespace',
      OCI_BUCKET: 'easyconvert-internal',
      AWS_ACCESS_KEY_ID: 'AKIAFALLBACKKEYID0001',
      AWS_SECRET_ACCESS_KEY: 'aws/fallback/secret/EXAMPLE000000000',
      AWS_REGION: 'us-ashburn-1',
    };
    const first = resolveStorageConfig(env, { warn });
    const second = resolveStorageConfig(env, { warn });
    expect(first).toMatchObject({
      accessKeyId: 'AKIAFALLBACKKEYID0001',
      secretAccessKey: 'aws/fallback/secret/EXAMPLE000000000',
      region: 'us-ashburn-1',
      endpoint: 'https://axyz123namespace.compat.objectstorage.us-ashburn-1.oraclecloud.com',
    });
    expect(second).toEqual(first);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('AWS_ACCESS_KEY_ID');
    expect(warnings[0]).toContain('AWS_SECRET_ACCESS_KEY');
    expect(warnings[0]).toContain('AWS_REGION');
    expect(warnings[0]).toContain('OCI_ACCESS_KEY_ID');
    expect(warnings[0]).not.toContain('AKIAFALLBACKKEYID0001');
    expect(warnings[0]).not.toContain('aws/fallback/secret');
  });

  it('is ignored, without a warning, when the driver variables are present', () => {
    const { warn, warnings } = collectWarnings();
    const config = resolveStorageConfig(
      { ...OCI_ENV, AWS_ACCESS_KEY_ID: 'AKIAIGNORED000000001', AWS_SECRET_ACCESS_KEY: 'ignored', AWS_REGION: 'us-phoenix-1' },
      { warn }
    );
    expect(config).toMatchObject({ accessKeyId: OCI_ENV.OCI_ACCESS_KEY_ID, region: 'ap-seoul-1' });
    expect(warnings).toEqual([]);
  });

  it('does not stand in for the missing endpoint or namespace', () => {
    const { warn } = collectWarnings();
    expect(() =>
      resolveStorageConfig(
        { STORAGE_DRIVER: 's3', AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b', AWS_REGION: 'c', AWS_BUCKET_NAME: 'dd' },
        { warn }
      )
    ).toThrow(/S3_ENDPOINT/);
  });

  it('serves the s3 driver as well', () => {
    const { warn, warnings } = collectWarnings();
    const config = resolveStorageConfig(
      {
        STORAGE_DRIVER: 's3',
        S3_ENDPOINT: 'https://objects.example.test',
        AWS_ACCESS_KEY_ID: 'AKIAFALLBACKKEYID0001',
        AWS_SECRET_ACCESS_KEY: 'aws/fallback/secret/EXAMPLE000000000',
        AWS_REGION: 'eu-west-1',
        AWS_BUCKET_NAME: 'legacy-bucket',
      },
      { warn }
    );
    expect(config).toMatchObject({ driver: 's3', bucket: 'legacy-bucket', region: 'eu-west-1' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('S3_ACCESS_KEY_ID');
  });
});

describe('s3 driver configuration', () => {
  it('reads the S3_* variables, defaults to path-style, and honours S3_FORCE_PATH_STYLE=false', () => {
    expect(resolveStorageConfig(S3_ENV)).toEqual({
      driver: 's3',
      endpoint: 'https://objects.example.test',
      region: 'eu-west-1',
      bucket: 'internal-bucket',
      accessKeyId: S3_ENV.S3_ACCESS_KEY_ID,
      secretAccessKey: S3_ENV.S3_SECRET_ACCESS_KEY,
      forcePathStyle: true,
    });
    expect(resolveStorageConfig({ ...S3_ENV, S3_FORCE_PATH_STYLE: 'false' })).toMatchObject({ forcePathStyle: false });
  });

  it.each(['S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'])(
    'throws naming %s when it is missing in production',
    (name) => {
      const env: Record<string, string | undefined> = { ...S3_ENV, NODE_ENV: 'production' };
      delete env[name];
      expect(() => resolveStorageConfig(env)).toThrow(new RegExp(name));
    }
  );

  it('requires https for the endpoint in production', () => {
    expect(() => resolveStorageConfig({ ...S3_ENV, NODE_ENV: 'production', S3_ENDPOINT: 'http://objects.example.test' })).toThrow(
      /https in production/
    );
  });
});

describe('signing secret and application origin', () => {
  it('returns the first configured signing secret and never invents one', () => {
    expect(resolveSigningSecret({})).toBeUndefined();
    expect(resolveSigningSecret({ OCI_SIGNING_SECRET: 'c' })).toBe('c');
    expect(resolveSigningSecret({ S3_SIGNING_SECRET: 'b', OCI_SIGNING_SECRET: 'c' })).toBe('b');
    expect(resolveSigningSecret({ STORAGE_SIGNING_SECRET: 'a', S3_SIGNING_SECRET: 'b' })).toBe('a');
    expect(resolveSigningSecret({ STORAGE_SIGNING_SECRET: '  ' })).toBeUndefined();
  });

  it('requires APP_URL in production and normalises it to an origin', () => {
    expect(() => resolveAppBaseUrl({ NODE_ENV: 'production' })).toThrow(StorageConfigError);
    expect(resolveAppBaseUrl({ NODE_ENV: 'production', APP_URL: 'https://app.example.test/some/path/' })).toBe(
      'https://app.example.test'
    );
    expect(resolveAppBaseUrl({ NODE_ENV: 'development' })).toBe('http://localhost:3000');
    expect(() => resolveAppBaseUrl({ APP_URL: 'ftp://app.example.test' })).toThrow(StorageConfigError);
    expect(() => resolveAppBaseUrl({ APP_URL: '::not a url::' })).toThrow(StorageConfigError);
  });
});
