import { describe, it, expect } from 'vitest';
import { StorageConfigError } from '../src/lib/storage/errors';
import { resolveStorageConfig } from '../src/lib/storage/storage-config';
import { assertValidBucketName, resolveS3Address, SigV4SigningError } from '../src/lib/storage/s3-sigv4';

/**
 * Bucket names follow the rules of the selected driver. OCI Object Storage accepts letters of both
 * cases, digits, hyphens, underscores and periods (1 to 256 characters, case-sensitive); a generic
 * S3 service keeps the stricter DNS-style rules, since its names may become host names.
 */

const OCI_BUCKET_MAX_LENGTH = 256;

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

describe('configured bucket names', () => {
  it('accepts what OCI allows: letters of both cases, digits, dashes, underscores and periods, up to 256 characters', () => {
    expect(resolveStorageConfig({ ...OCI_ENV, OCI_BUCKET: 'Prod_Objects.v2-EU' })).toMatchObject({
      driver: 'oci',
      bucket: 'Prod_Objects.v2-EU',
    });
    const longest = 'B'.repeat(OCI_BUCKET_MAX_LENGTH);
    expect(resolveStorageConfig({ ...OCI_ENV, OCI_BUCKET: longest })).toMatchObject({ bucket: longest });
  });

  it.each([
    ['a character outside the allowed set', 'bad bucket'],
    ['a slash', 'a/b'],
    ['a name that is only two dots', '..'],
    ['a single dot', '.'],
    ['a name over 256 characters', 'b'.repeat(OCI_BUCKET_MAX_LENGTH + 1)],
  ])('refuses an OCI bucket name with %s', (_label, bucket) => {
    let thrown: unknown;
    try {
      resolveStorageConfig({ ...OCI_ENV, OCI_BUCKET: bucket });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(StorageConfigError);
    expect((thrown as Error).message).toBe('OCI_BUCKET is not a valid OCI bucket name.');
  });

  it('keeps the DNS-style rules for a generic S3 service', () => {
    expect(resolveStorageConfig({ ...S3_ENV, S3_BUCKET: 'my.bucket-01' })).toMatchObject({ bucket: 'my.bucket-01' });
    for (const bucket of ['Prod_Objects', 'UPPER', 'a_b', 'ab', '192.168.0.1', 'a..b']) {
      let thrown: unknown;
      try {
        resolveStorageConfig({ ...S3_ENV, S3_BUCKET: bucket });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(StorageConfigError);
      expect((thrown as Error).message).toBe('S3_BUCKET is not a valid S3 bucket name.');
    }
  });
});

describe('bucket names in request addresses', () => {
  const address = (bucket: string, rules?: 'dns' | 'oci') =>
    resolveS3Address({ bucket, key: 'k', region: 'ap-seoul-1', endpoint: 'https://objects.example.com', forcePathStyle: true, bucketNameRules: rules });

  it('addresses a mixed-case OCI bucket path-style and refuses it under the DNS rules', () => {
    expect(address('Prod_Objects.v2', 'oci')).toEqual({
      origin: 'https://objects.example.com',
      path: '/Prod_Objects.v2/k',
      style: 'path',
    });
    expect(() => address('Prod_Objects.v2')).toThrow(SigV4SigningError);
    expect(() => assertValidBucketName('Prod_Objects.v2', 'dns')).toThrow(/Invalid bucket name/);
  });

  it('never lets a bucket name act as a path segment of another bucket', () => {
    for (const bucket of ['.', '..', 'a/b', '']) {
      expect(() => assertValidBucketName(bucket, 'oci')).toThrow(SigV4SigningError);
    }
  });

  it('refuses virtual-hosted addressing for a name that is not a DNS label', () => {
    const virtual = resolveS3Address({
      bucket: 'Prod_Objects',
      key: 'k',
      region: 'ap-seoul-1',
      endpoint: 'https://objects.example.com',
      forcePathStyle: false,
      bucketNameRules: 'oci',
    });
    expect(virtual.style).toBe('path');
  });
});
