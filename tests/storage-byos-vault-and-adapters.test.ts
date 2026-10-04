import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import http from 'node:http';
import { Readable } from 'node:stream';
import {
  credentialsVault,
  S3StorageAdapter,
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
import { StorageSsrfError, StorageNotFoundError, StorageAuthenticationError } from '../src/lib/storage/adapters/adapter-interface';
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
    it('blocks S3 adapter connection to AWS/GCP cloud metadata IP (169.254.169.254)', async () => {
      expect(() => {
        new S3StorageAdapter({
          type: 's3',
          bucket: 'test-bucket',
          accessKeyId: 'MOCK_KEY',
          secretAccessKey: 'MOCK_SECRET',
          endpoint: 'http://169.254.169.254/latest/meta-data',
        });
      }).toThrow(StorageSsrfError);
    });

    it('blocks S3 adapter connection to loopback addresses (127.0.0.1, localhost)', async () => {
      expect(() => {
        new S3StorageAdapter({
          type: 's3',
          bucket: 'test-bucket',
          accessKeyId: 'MOCK_KEY',
          secretAccessKey: 'MOCK_SECRET',
          endpoint: 'http://localhost:9000',
        });
      }).toThrow(StorageSsrfError);
    });

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
      const s3Adapter = createStorageAdapter({
        type: 's3',
        bucket: 'b',
        accessKeyId: 'k',
        secretAccessKey: 's',
      });
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

    it('handles S3 compatible storage stream put, head, and download', async () => {
      const adapter = new S3StorageAdapter({
        type: 's3',
        bucket: 'test-bucket',
        accessKeyId: 'AKIA_TEST',
        secretAccessKey: 'SECRET_TEST',
      });

      const payload = Buffer.from('Hello S3 BYOS Streaming', 'utf-8');
      const uploadRes = await adapter.uploadStream('test-file.txt', Readable.from(payload), {
        contentType: 'text/plain',
        size: payload.length,
      });

      expect(uploadRes.size).toBe(payload.length);
      expect(uploadRes.contentType).toBe('text/plain');

      const headRes = await adapter.head('test-file.txt');
      expect(headRes).not.toBeNull();
      expect(headRes?.size).toBe(payload.length);

      const stream = await adapter.downloadStream('test-file.txt');
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const downloaded = Buffer.concat(chunks);
      expect(downloaded.toString('utf-8')).toBe('Hello S3 BYOS Streaming');

      const deleted = await adapter.delete('test-file.txt');
      expect(deleted).toBe(true);

      const headAfter = await adapter.head('test-file.txt');
      expect(headAfter).toBeNull();
    });
  });

  describe('4. Streaming BYOS Task Operations (Import & Export)', () => {
    it('executes import/s3 task directly into localFsStorage and globalSharedObjects', async () => {
      const s3CredRef = await credentialsVault.store('user-alice', {
        type: 's3',
        bucket: 'source-bucket',
        accessKeyId: 'AKIA_SRC',
        secretAccessKey: 'SECRET_SRC',
      });

      // Pre-seed an object in the S3 adapter's backing spool
      const testAdapter = new S3StorageAdapter({
        type: 's3',
        bucket: 'source-bucket',
        accessKeyId: 'AKIA_SRC',
        secretAccessKey: 'SECRET_SRC',
      });
      const rawContent = Buffer.from('CSV,Header,Value\n1,Alpha,100\n2,Beta,200', 'utf-8');
      await testAdapter.uploadStream('reports/financial.csv', Readable.from(rawContent), {
        contentType: 'text/csv',
        size: rawContent.length,
      });

      const importResult = await executeImportTask({
        operation: 'import/s3',
        remotePath: 'reports/financial.csv',
        credentialRef: s3CredRef,
        userId: 'user-alice',
        filename: 'financial.csv',
      });

      expect(importResult.size).toBe(rawContent.length);
      expect(importResult.filename).toBe('financial.csv');

      // Verify object exists in localFsStorage
      const downloaded = await localFsStorage.getBuffer(importResult.key);
      expect(downloaded?.toString('utf-8')).toBe('CSV,Header,Value\n1,Alpha,100\n2,Beta,200');

      // Verify object mirrored in globalSharedObjects for immediate worker consumption
      expect(globalSharedObjects.has(importResult.key)).toBe(true);
    });

    it('executes export/s3 task streaming from localFsStorage to customer bucket', async () => {
      const s3CredRef = await credentialsVault.store('user-alice', {
        type: 's3',
        bucket: 'dest-bucket',
        accessKeyId: 'AKIA_DST',
        secretAccessKey: 'SECRET_DST',
      });

      // Put an artifact into localFsStorage
      const artifactContent = Buffer.from('Converted Video Transcode Result 1080p', 'utf-8');
      const stored = await localFsStorage.putBuffer('output-task-123.mp4', artifactContent, {
        contentType: 'video/mp4',
      });

      const exportResult = await executeExportTask({
        operation: 'export/s3',
        sourceKey: stored.key,
        remotePath: 'transcodes/user-alice/video-1080p.mp4',
        credentialRef: s3CredRef,
        userId: 'user-alice',
      });

      expect(exportResult.success).toBe(true);
      expect(exportResult.size).toBe(artifactContent.length);
      expect(exportResult.destination).toBe('transcodes/user-alice/video-1080p.mp4');

      // Verify destination object in customer S3
      const s3Adapter = new S3StorageAdapter({
        type: 's3',
        bucket: 'dest-bucket',
        accessKeyId: 'AKIA_DST',
        secretAccessKey: 'SECRET_DST',
      });
      const head = await s3Adapter.head('transcodes/user-alice/video-1080p.mp4');
      expect(head).not.toBeNull();
      expect(head?.size).toBe(artifactContent.length);
    });

    it('fails closed when export sourceKey does not exist', async () => {
      const s3CredRef = await credentialsVault.store('user-alice', {
        type: 's3',
        bucket: 'dest-bucket',
        accessKeyId: 'AKIA_DST',
        secretAccessKey: 'SECRET_DST',
      });

      await expect(
        executeExportTask({
          operation: 'export/s3',
          sourceKey: 'non-existent-key-999',
          remotePath: 'out.dat',
          credentialRef: s3CredRef,
          userId: 'user-alice',
        })
      ).rejects.toThrow(StorageNotFoundError);
    });

    it('fails closed when credentialRef is unauthorized or missing', async () => {
      await expect(
        executeImportTask({
          operation: 'import/s3',
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
          providerType: 's3',
          credentials: { type: 's3', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' },
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
          providerType: 's3',
          credentials: {
            type: 's3',
            bucket: 'customer-data',
            accessKeyId: 'KEY123',
            secretAccessKey: 'SECRET123',
          },
          name: 'Primary S3 Bucket',
        }),
      });

      const res = await credentialsPost(req);
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.credentialRef).toMatch(/^cred_[a-f0-9]{32}$/);
      expect(json.providerType).toBe('s3');
      expect(json.name).toBe('Primary S3 Bucket');
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

      const delRes = await credentialsDelete(deleteReq, { params: { id: credRef } });
      expect(delRes.status).toBe(204);

      // Verify it is gone
      const check = await credentialsVault.get(credRef, testUser.id);
      expect(check).toBeNull();
    });
  });
});
