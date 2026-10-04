import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { S3ObjectStorageService } from '../src/lib/storage/s3-storage';
import { OciObjectStorageService } from '../src/lib/storage/oci-storage';

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
      process.env.NODE_ENV = 'production';
      delete process.env.S3_SIGNING_SECRET;
      delete process.env.STORAGE_SIGNING_SECRET;

      expect(() => new S3ObjectStorageService()).toThrow(
        /Missing required S3_SIGNING_SECRET or STORAGE_SIGNING_SECRET environment variable in production/
      );
    });

    it('generates an ephemeral random secret in non-production when secret is unconfigured', () => {
      delete process.env.S3_SIGNING_SECRET;
      delete process.env.STORAGE_SIGNING_SECRET;
      process.env.NODE_ENV = 'development';

      const service1 = new S3ObjectStorageService();
      const service2 = new S3ObjectStorageService();

      const presigned1 = service1.generatePresignedDownloadUrl('sample.pdf', 60);
      const presigned2 = service2.generatePresignedDownloadUrl('sample.pdf', 60);

      expect(presigned1.signature).not.toBe(presigned2.signature);
    });

    it('fails closed in production when AWS access key ID is missing during presigned URL generation', () => {
      process.env.NODE_ENV = 'production';
      process.env.S3_SIGNING_SECRET = 'prod-signing-secret-minimum-32-bytes-long';
      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.S3_ACCESS_KEY_ID;

      const service = new S3ObjectStorageService();

      expect(() => service.generatePresignedUploadUrl('test-key', 1, 'up_123', 900)).toThrow(
        /Missing required AWS_ACCESS_KEY_ID or S3_ACCESS_KEY_ID environment variable in production/
      );

      expect(() => service.generatePresignedDownloadUrl('test-key', 3600)).toThrow(
        /Missing required AWS_ACCESS_KEY_ID or S3_ACCESS_KEY_ID environment variable in production/
      );
    });

    it('resolves real access key ID and region from environment for SigV4 credential scope', () => {
      process.env.AWS_ACCESS_KEY_ID = 'AKIA_CUSTOM_REAL_TENANT_KEY';
      process.env.AWS_REGION = 'ap-northeast-2';
      process.env.S3_SIGNING_SECRET = 'tenant-custom-s3-signing-secret';

      const service = new S3ObjectStorageService();
      const presigned = service.generatePresignedUploadUrl('uploads/doc.pdf', 2, 'upload_abc999', 600);

      const parsedUrl = new URL(presigned.url);
      const credentialParam = parsedUrl.searchParams.get('X-Amz-Credential');
      expect(credentialParam).toMatch(/^AKIA_CUSTOM_REAL_TENANT_KEY\/\d{8}\/ap-northeast-2\/s3\/aws4_request$/);
      expect(parsedUrl.searchParams.get('partNumber')).toBe('2');
      expect(parsedUrl.searchParams.get('uploadId')).toBe('upload_abc999');
      expect(presigned.signature).toHaveLength(64);
    });

    it('safely rejects presigned signatures with length mismatch without throwing TypeError', () => {
      const service = new S3ObjectStorageService({ signingSecret: 'secure-shared-signing-secret-123' });
      const presigned = service.generatePresignedDownloadUrl('safe-key.png', 300);

      // Truncated signature (length mismatch)
      const truncatedSig = presigned.signature.slice(0, 10);
      expect(service.verifyPresignedSignature('GET', 'safe-key.png', presigned.expiresAt, truncatedSig)).toBe(false);

      // Extended signature (length mismatch)
      const extendedSig = presigned.signature + 'deadbeef';
      expect(service.verifyPresignedSignature('GET', 'safe-key.png', presigned.expiresAt, extendedSig)).toBe(false);

      // Malformed non-hex string
      expect(service.verifyPresignedSignature('GET', 'safe-key.png', presigned.expiresAt, 'invalid-non-hex!@#$%^')).toBe(false);

      // Valid signature
      expect(service.verifyPresignedSignature('GET', 'safe-key.png', presigned.expiresAt, presigned.signature)).toBe(true);

      // Expired timestamp
      expect(service.verifyPresignedSignature('GET', 'safe-key.png', presigned.expiresAt - 1000000, presigned.signature)).toBe(false);
    });
  });

  describe('OCI Storage Service Security Hardening', () => {
    it('fails closed in production when OCI namespace is missing', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.OCI_NAMESPACE;
      process.env.STORAGE_SIGNING_SECRET = 'valid-storage-secret-for-oci-prod';

      expect(() => new OciObjectStorageService()).toThrow(
        /Missing required OCI_NAMESPACE environment variable in production/
      );
    });

    it('fails closed in production when OCI signing secret is missing', () => {
      process.env.NODE_ENV = 'production';
      process.env.OCI_NAMESPACE = 'tenant-oci-namespace';
      delete process.env.STORAGE_SIGNING_SECRET;
      delete process.env.OCI_SIGNING_SECRET;

      expect(() => new OciObjectStorageService()).toThrow(
        /Missing required STORAGE_SIGNING_SECRET or OCI_SIGNING_SECRET environment variable in production/
      );
    });

    it('derives authentic tenancy endpoint dynamically when OCI_NAMESPACE is configured', () => {
      const service = new OciObjectStorageService({
        namespace: 'enterprise-client-namespace',
        region: 'us-ashburn-1',
      }, {
        signingSecret: 'custom-oci-signing-key-99',
      });

      expect(service.config.namespace).toBe('enterprise-client-namespace');
      expect(service.config.region).toBe('us-ashburn-1');
      expect(service.config.endpoint).toBe(
        'https://enterprise-client-namespace.compat.objectstorage.us-ashburn-1.oraclecloud.com'
      );
    });

    it('verifies OCI presigned signatures with timingSafeEqual length guarding', () => {
      const service = new OciObjectStorageService({
        namespace: 'secure-test-namespace',
      }, {
        signingSecret: 'secure-oci-signing-key-hex-42',
      });

      const uploadUrl = service.generatePresignedUploadUrl('parts/file.zip', 1, 'up_session_42', 300);
      const parsedOciUrl = new URL(uploadUrl.url);
      expect(parsedOciUrl.searchParams.get('uploadId')).toBe('up_session_42');
      expect(parsedOciUrl.searchParams.get('partNumber')).toBe('1');
      expect(uploadUrl.signature).toHaveLength(64);

      // Valid signature
      const isValid = service.verifyPresignedSignature(
        'PUT',
        'parts/file.zip',
        uploadUrl.expiresAt,
        uploadUrl.signature,
        'up_session_42',
        1
      );
      expect(isValid).toBe(true);

      // Length mismatch: should return false cleanly without throwing
      const isMismatched = service.verifyPresignedSignature(
        'PUT',
        'parts/file.zip',
        uploadUrl.expiresAt,
        'abc',
        'up_session_42',
        1
      );
      expect(isMismatched).toBe(false);

      // Tampered signature
      const tampered = crypto.randomBytes(32).toString('hex');
      const isTampered = service.verifyPresignedSignature(
        'PUT',
        'parts/file.zip',
        uploadUrl.expiresAt,
        tampered,
        'up_session_42',
        1
      );
      expect(isTampered).toBe(false);

      // Expired signature
      const isExpired = service.verifyPresignedSignature(
        'PUT',
        'parts/file.zip',
        Math.floor(Date.now() / 1000) - 100,
        uploadUrl.signature,
        'up_session_42',
        1
      );
      expect(isExpired).toBe(false);
    });
  });
});
