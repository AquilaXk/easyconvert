import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import dns from 'node:dns';
import { NextRequest } from 'next/server';
import { POST as credentialsPost } from '../src/app/api/v1/storage/credentials/route';
import { credentialsVault, S3_DEV_ENDPOINT_ALLOWLIST_ENV } from '../src/lib/storage';
import { userStore } from '../src/lib/auth/user-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';

/**
 * s3 credentials whose endpoint could never be used safely must be refused when they are
 * registered, not only later at import/export time. Oracle: the route's HTTP status, problem
 * type, and the vault contents (nothing stored).
 */

const INVALID_ENDPOINT_TYPE = 'https://api.easyconvert.io/problems/byos-invalid-endpoint';

describe('s3 credential registration validates the endpoint', () => {
  let userId: string;
  let authHeaders: Record<string, string>;

  beforeEach(async () => {
    const email = `byosreg_${Date.now()}_${Math.random().toString(36).slice(2)}@byos.test`;
    const user = await userStore.createUser({ email, name: 'byosreg', tier: 'pro' });
    userId = user.id;
    const { secretKey } = await redisKeyStore.generateApiKey(userId, 'byosreg', { scopes: ['convert:write'] });
    authHeaders = { Authorization: `Bearer ${secretKey}` };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function register(credentials: Record<string, unknown>) {
    return credentialsPost(
      new NextRequest('http://localhost:3000/api/v1/storage/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          providerType: 's3',
          credentials: { type: 's3', bucket: 'customer-bucket', accessKeyId: 'AKIA_X', secretAccessKey: 'SECRET_X', ...credentials },
        }),
      })
    );
  }

  it.each([
    ['loopback without the dev allowlist', { endpoint: 'http://127.0.0.1:9000' }],
    ['cloud metadata IP', { endpoint: 'https://169.254.169.254' }],
    ['metadata hostname', { endpoint: 'https://metadata.google.internal' }],
    ['private network', { endpoint: 'https://192.168.1.20' }],
    ['public host without TLS', { endpoint: 'http://objects.example.com' }],
    ['unparseable endpoint', { endpoint: 'not a url' }],
    ['invalid bucket name', { bucket: 'Bad_Bucket' }],
  ])('refuses %s with a typed 400 and stores nothing', async (_label, override) => {
    const res = await register(override);
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const body = await res.json();
    expect(body).toMatchObject({ type: INVALID_ENDPOINT_TYPE, status: 400, title: 'Invalid Storage Endpoint' });
    expect(JSON.stringify(body)).not.toContain('SECRET_X');
    expect(await credentialsVault.list(userId)).toEqual([]);
  });

  it('refuses a public-looking hostname that resolves to a private address', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '10.1.2.3', family: 4 }] as never);
    const res = await register({ endpoint: 'https://objects.customer-storage.example' });
    expect(res.status).toBe(400);
    expect((await res.json()).type).toBe(INVALID_ENDPOINT_TYPE);
    expect(await credentialsVault.list(userId)).toEqual([]);
  });

  it('accepts a dev-allowlisted local endpoint', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv(S3_DEV_ENDPOINT_ALLOWLIST_ENV, '127.0.0.1:9000');
    const res = await register({ endpoint: 'http://127.0.0.1:9000' });
    expect(res.status).toBe(201);
    expect((await credentialsVault.list(userId)).map((c) => c.providerType)).toEqual(['s3']);
  });

  it('accepts a public TLS endpoint whose host resolves publicly', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.215.14', family: 4 }] as never);
    const res = await register({ endpoint: 'https://objects.customer-storage.example' });
    expect(res.status).toBe(201);
  });
});
