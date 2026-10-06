import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import { Readable } from 'node:stream';
import {
  credentialsVault,
  GcsStorageAdapter,
  AzureBlobStorageAdapter,
  WebDavStorageAdapter,
  SftpStorageAdapter,
  createStorageAdapter,
  executeImportTask,
  executeExportTask,
  localFsStorage,
  globalSharedObjects,
} from '../src/lib/storage';
import {
  StorageSsrfError,
  StorageNotFoundError,
  StorageAuthenticationError,
} from '../src/lib/storage/adapters/adapter-interface';
import { userStore } from '../src/lib/auth/user-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import type { User } from '../src/lib/auth/types';
import { POST as credentialsPost, GET as credentialsGet } from '../src/app/api/v1/storage/credentials/route';
import { DELETE as credentialsDelete } from '../src/app/api/v1/storage/credentials/[id]/route';

describe('Phase 2-C: BYOS Credentials Vault & Storage Adapters', () => {
  let testUser: User;
  let authHeaders: Record<string, string>;

  beforeEach(async () => {
    credentialsVault.clear();
    const email = `vault_test_${Date.now()}_${Math.random().toString(36).slice(2)}@example.com`;
    testUser = userStore.sanitizeUser(await userStore.createUser({ email, name: 'Vault Tester', tier: 'pro' }));
    const key = await redisKeyStore.generateApiKey(testUser.id, 'Vault Key', {
      scopes: ['convert:write', 'convert:read', '*'],
    });
    authHeaders = { Authorization: `Bearer ${key.secretKey}` };
  });

  describe('1. Encrypted Credentials Vault (AES-256-GCM Envelope)', () => {
    it('encrypts and stores customer S3 credentials with opaque reference format', async () => {
      const credRef = await credentialsVault.store('user-alice', {
        type: 's3',
        bucket: 'customer-data-bucket',
        accessKeyId: 'AKIA_CUSTOMER_KEY',
        secretAccessKey: 'CUSTOMER_SUPER_SECRET_S3_KEY_XYZ123',
        region: 'eu-west-1',
      }, { name: 'Production AWS S3' });

      expect(credRef).toMatch(/^cred_[a-f0-9]{32}$/);

      // Verify decrypted credentials round-trip
      const decrypted = await credentialsVault.get(credRef, 'user-alice');
      expect(decrypted).not.toBeNull();
      expect(decrypted?.type).toBe('s3');
      if (decrypted?.type === 's3') {
        expect(decrypted.bucket).toBe('customer-data-bucket');
        expect(decrypted.accessKeyId).toBe('AKIA_CUSTOMER_KEY');
        expect(decrypted.secretAccessKey).toBe('CUSTOMER_SUPER_SECRET_S3_KEY_XYZ123');
        expect(decrypted.region).toBe('eu-west-1');
      }
    });

    it('enforces multi-tenant authorization boundaries fail-closed', async () => {
      const credRef = await credentialsVault.store('user-alice', {
        type: 'webdav',
        url: 'https://webdav.customer.example.com',
        username: 'alice',
        password: 'secure-password-123',
      });

      // User Bob cannot read Alice's credentials
      const bobAccess = await credentialsVault.get(credRef, 'user-bob');
      expect(bobAccess).toBeNull();

      // Alice can read her credentials
      const aliceAccess = await credentialsVault.get(credRef, 'user-alice');
      expect(aliceAccess).not.toBeNull();
    });

    it('lists non-sensitive metadata without exposing secrets', async () => {
      await credentialsVault.store('user-alice', {
        type: 's3',
        bucket: 'bucket-one',
        accessKeyId: 'KEY1',
        secretAccessKey: 'SECRET1',
      }, { name: 'S3 Primary' });

      await credentialsVault.store('user-alice', {
        type: 'gcs',
        bucket: 'gcs-bucket-two',
        clientEmail: 'service@project.iam.gserviceaccount.com',
        privateKey: 'SECRET_PRIVATE_KEY',
      }, { name: 'GCS Backup' });

      const list = await credentialsVault.list('user-alice');
      expect(list).toHaveLength(2);

      for (const item of list) {
        expect(item.id).toMatch(/^cred_[a-f0-9]{32}$/);
        expect(item.userId).toBe('user-alice');
        expect(['s3', 'gcs']).toContain(item.providerType);
        // Secrets must NOT be present in listing
        expect((item as any).secretAccessKey).toBeUndefined();
        expect((item as any).privateKey).toBeUndefined();
      }
    });

    it('deletes stored credentials and denies subsequent access', async () => {
      const credRef = await credentialsVault.store('user-alice', {
        type: 'azure-blob',
        storageAccount: 'customerblob',
        containerName: 'exports',
        accountKey: Buffer.from('mock-key').toString('base64'),
      });

      const deleted = await credentialsVault.delete(credRef, 'user-alice');
      expect(deleted).toBe(true);

      const fetchAfter = await credentialsVault.get(credRef, 'user-alice');
      expect(fetchAfter).toBeNull();
    });

    it('rejects tampered ciphertexts fail-closed via GCM authentication tag verification', async () => {
      const credRef = await credentialsVault.store('user-alice', {
        type: 'sftp',
        host: 'sftp.customer.example.com',
        username: 'sftpuser',
        password: 'vault-secret-password',
      });

      // Retrieve internal envelope and tamper with ciphertext
      const internalEnvelope = (credentialsVault as any).inMemoryStore.get(credRef);
      expect(internalEnvelope).toBeDefined();

      const rawCiphertext = Buffer.from(internalEnvelope.encryptedData, 'base64');
      // Flip single byte in ciphertext
      rawCiphertext[0] ^= 0xff;
      internalEnvelope.encryptedData = rawCiphertext.toString('base64');

      await expect(credentialsVault.get(credRef, 'user-alice')).rejects.toThrow(
        /Decryption failed or authentication tag mismatch/
      );
    });
  });

  describe('2. Anti-SSRF Enforcements Across Storage Adapters', () => {
    it('blocks SFTP adapter from connecting to private/restricted IP or localhost', async () => {
      const adapter = new SftpStorageAdapter({
        type: 'sftp',
        host: '127.0.0.1',
        username: 'sftpuser',
      });

      await expect(adapter.downloadStream('data.csv')).rejects.toThrow(StorageSsrfError);
      await expect(adapter.head('data.csv')).rejects.toThrow(StorageSsrfError);
      await expect(adapter.delete('data.csv')).rejects.toThrow(StorageSsrfError);
    });

    it('blocks SFTP adapter when DNS lookup returns no addresses', async () => {
      const lookupSpy = vi.spyOn(dns.promises, 'lookup').mockResolvedValueOnce([] as any);
      const adapter = new SftpStorageAdapter({
        type: 'sftp',
        host: 'sftp.external-customer.com',
        username: 'sftpuser',
      });

      await expect(adapter.downloadStream('data.csv')).rejects.toThrow(StorageSsrfError);
      lookupSpy.mockRestore();
    });

    it('blocks WebDAV adapter from connecting to cloud metadata hostname', async () => {
      const adapter = new WebDavStorageAdapter({
        type: 'webdav',
        url: 'http://metadata.google.internal/computeMetadata/v1',
      });

      await expect(adapter.downloadStream('secret.txt')).rejects.toThrow(StorageSsrfError);
    });
  });

  describe('3. Cloud Storage Adapters & Factory Dispatch', () => {
    it('instantiates matching storage adapter for each credential provider type', () => {
      // s3 is covered end-to-end in tests/byos-s3-roundtrip.test.ts.
      const s3Adapter = createStorageAdapter({ type: 's3', bucket: 'b-bucket', accessKeyId: 'k', secretAccessKey: 's' });
      expect(s3Adapter.providerName).toBe('s3');

      const gcsAdapter = createStorageAdapter({
        type: 'gcs',
        bucket: 'b',
      });
      expect(gcsAdapter.providerName).toBe('gcs');

      const azureAdapter = createStorageAdapter({
        type: 'azure-blob',
        storageAccount: 'acc',
        containerName: 'cont',
      });
      expect(azureAdapter.providerName).toBe('azure-blob');

      const webdavAdapter = createStorageAdapter({
        type: 'webdav',
        url: 'https://remote.example.com/files',
      });
      expect(webdavAdapter.providerName).toBe('webdav');

      const sftpAdapter = createStorageAdapter({
        type: 'sftp',
        host: 'remote.example.com',
        username: 'user',
      });
      expect(sftpAdapter.providerName).toBe('sftp');
    });

  });

  describe('4. Streaming BYOS Task Operations (Import & Export)', () => {
    it('fails closed when export sourceKey does not exist', async () => {
      const gcsCredRef = await credentialsVault.store('user-alice', {
        type: 'gcs',
        bucket: 'dest-bucket',
      });

      await expect(
        executeExportTask({
          operation: 'export/gcs',
          sourceKey: 'non-existent-key-999',
          remotePath: 'out.dat',
          credentialRef: gcsCredRef,
          userId: 'user-alice',
        })
      ).rejects.toThrow(StorageNotFoundError);
    });

    it('fails closed when credentialRef is unauthorized or missing', async () => {
      await expect(
        executeImportTask({
          operation: 'import/gcs',
          remotePath: 'file.txt',
          credentialRef: 'cred_invalid1234567890123456789012',
          userId: 'user-alice',
        })
      ).rejects.toThrow(StorageAuthenticationError);
    });
  });

  describe('5. Credentials API Endpoints (/api/v1/storage/credentials)', () => {
    it('returns 401 Unauthorized when no authentication is provided', async () => {
      const req = new NextRequest('http://localhost:3000/api/v1/storage/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerType: 'gcs',
          credentials: { type: 'gcs', bucket: 'b' },
        }),
      });

      const res = await credentialsPost(req);
      expect(res.status).toBe(401);
    });

    it('stores credentials and returns 201 Created with credential reference', async () => {
      const req = new NextRequest('http://localhost:3000/api/v1/storage/credentials', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify({
          providerType: 'gcs',
          credentials: {
            type: 'gcs',
            bucket: 'customer-data',
            clientEmail: 'svc@project.iam.gserviceaccount.com',
            privateKey: 'SECRET123',
          },
          name: 'Primary GCS Bucket',
        }),
      });

      const res = await credentialsPost(req);
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.credentialRef).toMatch(/^cred_[a-f0-9]{32}$/);
      expect(json.providerType).toBe('gcs');
      expect(json.name).toBe('Primary GCS Bucket');
    });

    it('lists registered credentials for the authenticated user', async () => {
      // Pre-seed credentials
      await credentialsVault.store(testUser.id, {
        type: 'gcs',
        bucket: 'my-gcs-bucket',
      }, { name: 'Google Cloud Backup' });

      const req = new NextRequest('http://localhost:3000/api/v1/storage/credentials', {
        method: 'GET',
        headers: {
          ...authHeaders,
        },
      });

      const res = await credentialsGet(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(Array.isArray(json.credentials)).toBe(true);
      expect(json.credentials.length).toBeGreaterThanOrEqual(1);
      expect(json.credentials[0].providerType).toBe('gcs');
    });

    it('deletes registered credentials via DELETE /api/v1/storage/credentials/[id]', async () => {
      const credRef = await credentialsVault.store(testUser.id, {
        type: 'webdav',
        url: 'https://dav.example.com',
      });

      const deleteReq = new NextRequest(`http://localhost:3000/api/v1/storage/credentials/${credRef}`, {
        method: 'DELETE',
        headers: {
          ...authHeaders,
        },
      });

      const delRes = await credentialsDelete(deleteReq, { params: Promise.resolve({ id: credRef }) });
      expect(delRes.status).toBe(204);

      // Verify it is gone
      const check = await credentialsVault.get(credRef, testUser.id);
      expect(check).toBeNull();
    });
  });
});
