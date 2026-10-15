import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalFsStorage } from '../src/lib/storage/local-fs-storage';
import { OciObjectStorageService } from '../src/lib/storage/oci-storage';
import { S3ObjectStorageService } from '../src/lib/storage/s3-storage';
import { StorageSigningSecretMissingError } from '../src/lib/storage/errors';

/**
 * Regression tests for issue #483. Each one fails on the code that wrote presign URLs with a
 * made-up access key and host, and signed them with a random per-process secret.
 */

const SRC_ROOT = path.join(__dirname, '..', 'src');
const SIGNING_SECRET_ENV_NAMES = ['STORAGE_SIGNING_SECRET', 'S3_SIGNING_SECRET', 'OCI_SIGNING_SECRET'] as const;
const CREDENTIAL_ENV_NAMES = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'OCI_ACCESS_KEY_ID',
  'OCI_SECRET_ACCESS_KEY',
] as const;
const APP_ORIGIN = 'https://app.regression.test';
const FORBIDDEN_ACCESS_KEY = 'DEV_ACCESS_KEY_ID';
const FORBIDDEN_HOST = 'storage.easyconvert.app';

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listSourceFiles(full, out);
    } else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function clearEnv(names: readonly string[]): void {
  for (const name of names) {
    vi.stubEnv(name, undefined as unknown as string);
    delete process.env[name];
  }
}

describe('Storage presign never invents credentials, hosts or secrets (#483)', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('APP_URL', APP_ORIGIN);
    clearEnv([...SIGNING_SECRET_ENV_NAMES, ...CREDENTIAL_ENV_NAMES, 'S3_ENDPOINT', 'OCI_ENDPOINT']);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('no made-up credentials or host', () => {
    it('keeps DEV_ACCESS_KEY_ID and the made-up storage host out of every source file', () => {
      const offenders: string[] = [];
      for (const file of listSourceFiles(SRC_ROOT)) {
        const text = fs.readFileSync(file, 'utf-8');
        if (text.includes(FORBIDDEN_ACCESS_KEY) || text.includes(FORBIDDEN_HOST)) {
          offenders.push(path.relative(SRC_ROOT, file));
        }
      }
      expect(offenders).toEqual([]);
    });

    it('presigns S3ObjectStorageService part URLs on the application origin without the made-up key', () => {
      const service = new S3ObjectStorageService({ signingSecret: 'regression-signing-secret-32-bytes!!' });
      try {
        const presigned = service.generatePresignedUploadPartUrl('uploads/a.bin', 'up_1', 1, 900);
        const parsed = new URL(presigned.url);
        expect(parsed.origin).toBe(APP_ORIGIN);
        expect(presigned.url).not.toContain(FORBIDDEN_ACCESS_KEY);
        expect(presigned.url).not.toContain(FORBIDDEN_HOST);
      } finally {
        service.stopGc();
      }
    });

    it('presigns OciObjectStorageService part URLs on the application origin without the made-up key', () => {
      const oci = new OciObjectStorageService(
        { namespace: 'regression-ns', region: 'ap-seoul-1' },
        { signingSecret: 'regression-signing-secret-32-bytes!!' }
      );
      try {
        const presigned = oci.generatePresignedUploadPartUrl('uploads/a.bin', 'up_1', 1, 900);
        const parsed = new URL(presigned.url);
        expect(parsed.origin).toBe(APP_ORIGIN);
        expect(presigned.url).not.toContain(FORBIDDEN_ACCESS_KEY);
        expect(presigned.url).not.toContain(FORBIDDEN_HOST);
      } finally {
        oci.stopGc();
      }
    });

    it('does not offer a download URL signed by a local backend for a host that cannot verify it', () => {
      const service = new S3ObjectStorageService({ signingSecret: 'regression-signing-secret-32-bytes!!' });
      const oci = new OciObjectStorageService(
        { namespace: 'regression-ns', region: 'ap-seoul-1' },
        { signingSecret: 'regression-signing-secret-32-bytes!!' }
      );
      try {
        expect((service as { generatePresignedDownloadUrl?: unknown }).generatePresignedDownloadUrl).toBeUndefined();
        expect((oci as { generatePresignedDownloadUrl?: unknown }).generatePresignedDownloadUrl).toBeUndefined();
      } finally {
        service.stopGc();
        oci.stopGc();
      }
    });
  });

  describe('no random per-process signing secret', () => {
    it('refuses to sign with S3ObjectStorageService when no signing secret is configured', () => {
      const service = new S3ObjectStorageService();
      try {
        expect(() => service.getSigningSecret()).toThrow(StorageSigningSecretMissingError);
        expect(() => service.generatePresignedUploadUrl('k', 1, 'up_1', 60)).toThrow(StorageSigningSecretMissingError);
        expect(() => service.verifyPresignedSignature('GET', 'k', Date.now() + 60_000, 'ab'.repeat(32))).toThrow(
          StorageSigningSecretMissingError
        );
      } finally {
        service.stopGc();
      }
    });

    it('refuses to sign with OciObjectStorageService when no signing secret is configured', () => {
      const oci = new OciObjectStorageService({ namespace: 'regression-ns', region: 'ap-seoul-1' });
      try {
        expect(() => oci.getSigningSecret()).toThrow(StorageSigningSecretMissingError);
        expect(() => oci.generatePresignedUploadUrl('k', 1, 'up_1', 60)).toThrow(StorageSigningSecretMissingError);
      } finally {
        oci.stopGc();
      }
    });

    it('refuses to presign with LocalFsStorage when no signing secret is configured', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-regress-localfs-'));
      const local = new LocalFsStorage({ storageDir: dir });
      try {
        await expect(local.presignGet('k', 60)).rejects.toThrow(StorageSigningSecretMissingError);
        await expect(local.presignPart('k', 'up_1', 1, 60)).rejects.toThrow(StorageSigningSecretMissingError);
      } finally {
        local.stopGc();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
