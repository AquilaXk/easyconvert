import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { S3ObjectStorageService } from '../src/lib/storage/s3-storage';
import { resolveStorageConfig } from '../src/lib/storage/storage-config';
import { createRemoteStorage } from '../src/lib/storage/remote-storage-factory';
import { StorageConfigError, StorageSigningSecretMissingError } from '../src/lib/storage/errors';

describe('Phase 1-D: Storage Secrets Hardening & Namespace Cleanup', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('S3 Storage Service Security Hardening', () => {
    it('fails closed in production when signing secret is missing', () => {
      (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
      delete process.env.S3_SIGNING_SECRET;
      delete process.env.STORAGE_SIGNING_SECRET;
      delete process.env.OCI_SIGNING_SECRET;

      expect(() => new S3ObjectStorageService()).toThrow(
        /Missing required STORAGE_SIGNING_SECRET environment variable in production/
      );
    });

    it('refuses to sign in non-production when no secret is configured instead of generating a per-process one', () => {
      delete process.env.S3_SIGNING_SECRET;
      delete process.env.STORAGE_SIGNING_SECRET;
      (process.env as Record<string, string | undefined>).NODE_ENV = 'development';

      const service = new S3ObjectStorageService();
      try {
        expect(() => service.generatePresignedUploadUrl('sample.pdf', 1, 'up_1', 60)).toThrow(
          StorageSigningSecretMissingError
        );
      } finally {
        service.stopGc();
      }
    });

    it('fails closed in production when APP_URL is missing during local presigned URL generation', () => {
      (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
      process.env.S3_SIGNING_SECRET = 'prod-signing-secret-minimum-32-bytes-long';
      delete process.env.APP_URL;

      const service = new S3ObjectStorageService();
      try {
        expect(() => service.generatePresignedUploadUrl('test-key', 1, 'up_123', 900)).toThrow(StorageConfigError);
        expect(() => service.generatePresignedUploadUrl('test-key', 1, 'up_123', 900)).toThrow(
          /APP_URL is required in production/
        );
      } finally {
        service.stopGc();
      }
    });

    it('signs local presigned URLs with the application signing secret under a credential label, not an object store key', () => {
      process.env.AWS_ACCESS_KEY_ID = 'AKIA_CUSTOM_REAL_TENANT_KEY';
      process.env.AWS_REGION = 'ap-northeast-2';
      process.env.S3_SIGNING_SECRET = 'tenant-custom-s3-signing-secret';
      process.env.APP_URL = 'https://app.example.test';

      const service = new S3ObjectStorageService();
      try {
        const presigned = service.generatePresignedUploadUrl('uploads/doc.pdf', 2, 'upload_abc999', 600);

        const parsedUrl = new URL(presigned.url);
        expect(parsedUrl.origin).toBe('https://app.example.test');
        const credentialParam = parsedUrl.searchParams.get('X-Amz-Credential');
        expect(credentialParam).toMatch(/^local-emulation\/\d{8}\/local\/s3\/aws4_request$/);
        expect(presigned.url).not.toContain('AKIA_CUSTOM_REAL_TENANT_KEY');
        expect(parsedUrl.searchParams.get('partNumber')).toBe('2');
        expect(parsedUrl.searchParams.get('uploadId')).toBe('upload_abc999');
        expect(presigned.signature).toHaveLength(64);

        const verified = service.verifySigV4Url(presigned.url, 'PUT');
        expect(verified.valid).toBe(true);
        expect(verified.accessKeyId).toBe('local-emulation');
      } finally {
        service.stopGc();
      }
    });

    it('safely rejects presigned signatures with length mismatch without throwing TypeError', () => {
      const secret = 'secure-shared-signing-secret-123';
      const service = new S3ObjectStorageService({ signingSecret: secret });
      try {
        // Independent oracle: the GET capability signature is HMAC-SHA256(secret, "GET\n<key>\n<expiresAt>").
        const expiresAt = Date.now() + 300_000;
        const signature = crypto.createHmac('sha256', secret).update(`GET\nsafe-key.png\n${expiresAt}`).digest('hex');

        // Truncated signature (length mismatch)
        expect(service.verifyPresignedSignature('GET', 'safe-key.png', expiresAt, signature.slice(0, 10))).toBe(false);

        // Extended signature (length mismatch)
        expect(service.verifyPresignedSignature('GET', 'safe-key.png', expiresAt, signature + 'deadbeef')).toBe(false);

        // Malformed non-hex string
        expect(service.verifyPresignedSignature('GET', 'safe-key.png', expiresAt, 'invalid-non-hex!@#$%^')).toBe(false);

        // Valid signature
        expect(service.verifyPresignedSignature('GET', 'safe-key.png', expiresAt, signature)).toBe(true);

        // Signature for another key
        expect(service.verifyPresignedSignature('GET', 'other-key.png', expiresAt, signature)).toBe(false);

        // Expired timestamp
        const past = Date.now() - 1_000_000;
        const expiredSignature = crypto.createHmac('sha256', secret).update(`GET\nsafe-key.png\n${past}`).digest('hex');
        expect(service.verifyPresignedSignature('GET', 'safe-key.png', past, expiredSignature)).toBe(false);
      } finally {
        service.stopGc();
      }
    });
  });

  describe('OCI Driver Security Hardening', () => {
    it('fails closed in production when OCI namespace is missing', () => {
      expect(() =>
        resolveStorageConfig({
          NODE_ENV: 'production',
          STORAGE_DRIVER: 'oci',
          OCI_REGION: 'ap-seoul-1',
          OCI_BUCKET: 'easyconvert-internal',
          OCI_ACCESS_KEY_ID: 'ocikeyid0000000000001',
          OCI_SECRET_ACCESS_KEY: 'oci/secret+key/EXAMPLE000000000000',
        })
      ).toThrow(/OCI_NAMESPACE/);
    });

    it('fails closed in production when signing secret is missing for OCI remote storage', () => {
      const config = resolveStorageConfig({
        NODE_ENV: 'production',
        STORAGE_DRIVER: 'oci',
        OCI_NAMESPACE: 'tenant-oci-namespace',
        OCI_REGION: 'ap-seoul-1',
        OCI_BUCKET: 'easyconvert-internal',
        OCI_ACCESS_KEY_ID: 'ocikeyid0000000000001',
        OCI_SECRET_ACCESS_KEY: 'oci/secret+key/EXAMPLE000000000000',
      });
      if (config.driver !== 'oci') throw new Error('expected oci driver');
      expect(() => createRemoteStorage(config, { NODE_ENV: 'production' })).toThrow(/STORAGE_SIGNING_SECRET/);
    });

    it('derives authentic tenancy endpoint dynamically when OCI_NAMESPACE is configured', () => {
      const config = resolveStorageConfig({
        STORAGE_DRIVER: 'oci',
        OCI_NAMESPACE: 'enterprise-client-namespace',
        OCI_REGION: 'us-ashburn-1',
        OCI_BUCKET: 'easyconvert-internal',
        OCI_ACCESS_KEY_ID: 'ocikeyid0000000000001',
        OCI_SECRET_ACCESS_KEY: 'oci/secret+key/EXAMPLE000000000000',
      });
      if (config.driver !== 'oci') throw new Error('expected oci driver');
      expect(config.namespace).toBe('enterprise-client-namespace');
      expect(config.region).toBe('us-ashburn-1');
      expect(config.endpoint).toBe(
        'https://enterprise-client-namespace.compat.objectstorage.us-ashburn-1.oraclecloud.com'
      );
    });
  });
});
