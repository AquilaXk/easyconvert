import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { NextRequest } from 'next/server';
import { POST as credentialsPost } from '../src/app/api/v1/storage/credentials/route';
import {
  credentialsVault,
  createStorageAdapter,
  executeExportTask,
  executeImportTask,
  localFsStorage,
  S3StorageAdapter,
  S3_DEV_ENDPOINT_ALLOWLIST_ENV,
} from '../src/lib/storage';
import { StorageNotFoundError, StorageSsrfError } from '../src/lib/storage/adapters/adapter-interface';
import { userStore } from '../src/lib/auth/user-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { startS3StubServer, type S3StubServer } from './helpers/s3-stub-server';

/**
 * Regression for the re-enabled s3 BYOS provider: registration, import/s3, and export/s3 run
 * end-to-end through the real route and executeImportTask/executeExportTask against a node:http
 * S3 stub that verifies every SigV4 signature independently (tests/helpers/sigv4-verifier.ts).
 * Before the S3 client existed, every one of these failed with StorageProviderUnavailableError.
 */

const BUCKET = 'customer-bucket';
const ACCESS_KEY = 'AKIACUSTOMEREXAMPLE1';
const SECRET = 'customer/Secret+EXAMPLEKEY000000000000';
const MIB = 1024 * 1024;

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

describe('s3 BYOS provider end-to-end', () => {
  let stub: S3StubServer;
  let userId: string;
  let authHeaders: Record<string, string>;

  beforeAll(async () => {
    stub = await startS3StubServer({ bucket: BUCKET, credentials: { [ACCESS_KEY]: SECRET } });
  });

  afterAll(async () => {
    await stub.close();
  });

  beforeEach(async () => {
    vi.stubEnv(S3_DEV_ENDPOINT_ALLOWLIST_ENV, stub.host);
    stub.objects.clear();
    stub.requests.length = 0;
    const email = `byos_${Date.now()}_${Math.random().toString(36).slice(2)}@byos.test`;
    const user = await userStore.createUser({ email, name: 'byos', tier: 'pro' });
    userId = user.id;
    const { secretKey } = await redisKeyStore.generateApiKey(userId, 'byos', {
      scopes: ['convert:read', 'convert:write'],
    });
    authHeaders = { Authorization: `Bearer ${secretKey}` };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function s3Credentials() {
    return {
      type: 's3' as const,
      bucket: BUCKET,
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET,
      region: 'us-west-2',
      endpoint: stub.url,
    };
  }

  async function registerViaRoute(): Promise<string> {
    const res = await credentialsPost(
      new NextRequest('http://localhost:3000/api/v1/storage/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ providerType: 's3', credentials: s3Credentials() }),
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, providerType: 's3' });
    expect(body.credentialRef).toMatch(/^cred_[0-9a-f]{32}$/);
    expect(JSON.stringify(body)).not.toContain(SECRET);
    return body.credentialRef;
  }

  it('creates a real S3 adapter for s3 credentials', () => {
    const adapter = createStorageAdapter(s3Credentials());
    expect(adapter).toBeInstanceOf(S3StorageAdapter);
    expect(adapter.providerName).toBe('s3');
  });

  it('imports an object from the customer bucket into local storage', async () => {
    const credentialRef = await registerViaRoute();
    const payload = Buffer.from('id,total\n1,99.50\n2,12.00\n', 'utf-8');
    stub.objects.set('reports/q3.csv', { body: payload, contentType: 'text/csv', etag: '"x"' });

    const result = await executeImportTask({
      operation: 'import/s3',
      remotePath: 'reports/q3.csv',
      credentialRef,
      userId,
      filename: 'q3.csv',
    });

    expect(result.size).toBe(payload.length);
    expect((await localFsStorage.getBuffer(result.key))?.equals(payload)).toBe(true);
    const get = stub.requests.find((r) => r.method === 'GET');
    expect(get?.rawUrl).toBe(`/${BUCKET}/reports/q3.csv`);
    expect(get?.auth).toMatchObject({ ok: true, accessKeyId: ACCESS_KEY, region: 'us-west-2', service: 's3' });
  });

  it('exports a local object to the customer bucket with a streamed signed PUT', async () => {
    const credentialRef = await credentialsVault.store(userId, s3Credentials());
    const payload = Buffer.from('converted output body', 'utf-8');
    const source = await localFsStorage.putBuffer(`byos-export-${Date.now()}.txt`, payload, { contentType: 'text/plain' });

    const result = await executeExportTask({
      operation: 'export/s3',
      sourceKey: source.key,
      remotePath: 'out/payload.txt',
      credentialRef,
      userId,
    });

    expect(result).toMatchObject({ success: true, destination: 'out/payload.txt', size: payload.length });
    expect(result.etag).toBe(crypto.createHash('md5').update(payload).digest('hex'));
    const stored = stub.objects.get('out/payload.txt');
    expect(stored?.body.equals(payload)).toBe(true);
    expect(stored?.contentType).toBe('text/plain');
    expect(stub.requests[0].auth).toMatchObject({ ok: true, payloadHash: 'UNSIGNED-PAYLOAD' });
  });

  it('exports an object larger than one part as a multipart upload', async () => {
    const credentialRef = await credentialsVault.store(userId, s3Credentials());
    const payload = crypto.randomBytes(9 * MIB);
    const source = await localFsStorage.putBuffer(`byos-export-big-${Date.now()}.bin`, payload);

    await executeExportTask({ operation: 'export/s3', sourceKey: source.key, remotePath: 'out/big.bin', credentialRef, userId });

    expect(sha256(stub.objects.get('out/big.bin')!.body)).toBe(sha256(payload));
    expect(stub.requests.filter((r) => r.query.has('partNumber')).map((r) => r.bodyLength)).toEqual([8 * MIB, MIB]);
    expect(stub.requests.every((r) => r.auth.ok)).toBe(true);
  });

  it('fails import/s3 with StorageNotFoundError for a missing remote object', async () => {
    const credentialRef = await credentialsVault.store(userId, s3Credentials());
    await expect(
      executeImportTask({ operation: 'import/s3', remotePath: 'missing.csv', credentialRef, userId })
    ).rejects.toThrow(StorageNotFoundError);
  });

  it('refuses stored s3 credentials that point at a metadata endpoint', async () => {
    const credentialRef = await credentialsVault.store(userId, { ...s3Credentials(), endpoint: 'https://169.254.169.254' });
    await expect(
      executeImportTask({ operation: 'import/s3', remotePath: 'x', credentialRef, userId })
    ).rejects.toThrow(StorageSsrfError);
    expect(stub.requests).toHaveLength(0);
  });
});
