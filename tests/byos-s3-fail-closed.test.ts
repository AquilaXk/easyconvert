import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as credentialsPost } from '../src/app/api/v1/storage/credentials/route';
import { credentialsVault, createStorageAdapter, executeExportTask, executeImportTask, localFsStorage } from '../src/lib/storage';
import { StorageProviderUnavailableError } from '../src/lib/storage/adapters/adapter-interface';
import { userStore } from '../src/lib/auth/user-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';

/**
 * The s3 BYOS provider has no network client yet: it wrote "customer bucket" objects to a local
 * spool. Until a real client exists, every s3 entry point must refuse instead of pretending.
 */

const S3_CREDENTIALS = {
  type: 's3' as const,
  bucket: 'customer-bucket',
  accessKeyId: 'AKIA_CUSTOMER',
  secretAccessKey: 'CUSTOMER_SECRET',
};

describe('s3 BYOS provider fails closed', () => {
  let userId: string;
  let authHeaders: Record<string, string>;

  beforeEach(async () => {
    const email = `byos_${Date.now()}_${Math.random().toString(36).slice(2)}@byos.test`;
    const user = await userStore.createUser({ email, name: 'byos', tier: 'pro' });
    userId = user.id;
    const { secretKey } = await redisKeyStore.generateApiKey(userId, 'byos', {
      scopes: ['convert:read', 'convert:write'],
    });
    authHeaders = { Authorization: `Bearer ${secretKey}` };
  });

  it('rejects registering s3 credentials with a problem response and stores nothing', async () => {
    const res = await credentialsPost(
      new NextRequest('http://localhost:3000/api/v1/storage/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ providerType: 's3', credentials: S3_CREDENTIALS }),
      })
    );

    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const body = await res.json();
    expect(body.type).toBe('https://api.easyconvert.io/problems/byos-provider-unavailable');
    expect(await credentialsVault.list(userId)).toEqual([]);
  });

  it('refuses to create an s3 storage adapter', () => {
    expect(() => createStorageAdapter(S3_CREDENTIALS)).toThrow(StorageProviderUnavailableError);
  });

  it('fails import/s3 for previously stored credentials', async () => {
    const credentialRef = await credentialsVault.store(userId, S3_CREDENTIALS);

    await expect(
      executeImportTask({
        operation: 'import/s3',
        remotePath: 'reports/q3.csv',
        credentialRef,
        userId,
        filename: 'q3.csv',
      })
    ).rejects.toThrow(StorageProviderUnavailableError);
  });

  it('fails export/s3 instead of reporting a successful upload', async () => {
    const credentialRef = await credentialsVault.store(userId, S3_CREDENTIALS);
    const source = await localFsStorage.putBuffer(`byos-export-${Date.now()}.txt`, Buffer.from('payload'), {
      contentType: 'text/plain',
    });

    await expect(
      executeExportTask({
        operation: 'export/s3',
        sourceKey: source.key,
        remotePath: 'out/payload.txt',
        credentialRef,
        userId,
      })
    ).rejects.toThrow(StorageProviderUnavailableError);
  });
});
