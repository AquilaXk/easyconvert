import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as v1JobsRoute } from '../src/app/api/v1/jobs/route';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { getJobAcrossQueues } from '../src/lib/queue/conversion-queue';
import { s3Storage } from '../src/lib/storage/s3-storage';

/**
 * The lane a job runs in follows the size of its input as the server knows it: the length of an inline payload, the size of a stored
 * object. The `fileSize` in the body is the client's own figure, left out or wrong, and does not choose the lane. A CSV file of 12 MiB
 * is over the 10 MiB the light lane takes (resource-class.ts), whatever the request says.
 */

const BASE_URL = 'http://localhost:3000';
const MIB = 1024 * 1024;
const LARGE_CSV = Buffer.alloc(12 * MIB, 'a,b\n');

let apiKey: string;
let userId: string;

beforeEach(async () => {
  vi.stubEnv('REDIS_URL', '');
  vi.stubEnv('REDIS_HOST', '');
  const user = await userStore.createUser({ email: `size_${Date.now()}_${crypto.randomBytes(6).toString('hex')}@routing.test`, name: 'Routing', tier: 'pro' });
  userId = user.id;
  apiKey = (await redisKeyStore.generateApiKey(user.id, 'Routing Key', { scopes: ['convert:write', 'convert:read'] })).secretKey;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function submit(body: Record<string, unknown>) {
  const response = await v1JobsRoute(
    new NextRequest(`${BASE_URL}/api/v1/jobs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
  expect(response.status).toBe(202);
  const job = await getJobAcrossQueues((await response.json()).jobId);
  return job!.data;
}

describe('POST /api/v1/jobs puts a job in the lane its input needs', () => {
  it('for an inline payload sent without a fileSize', async () => {
    const data = await submit({ filename: 'large.csv', targetFormat: 'json', inputBufferBase64: LARGE_CSV.toString('base64') });
    expect(data.resourceClass).toBe('cpu');
    expect(data.fileSize).toBe(LARGE_CSV.length);
  });

  it('for an inline payload sent with a fileSize of 1', async () => {
    const data = await submit({ filename: 'large.csv', targetFormat: 'json', inputBufferBase64: LARGE_CSV.toString('base64'), fileSize: 1 });
    expect(data.resourceClass).toBe('cpu');
    expect(data.fileSize).toBe(LARGE_CSV.length);
  });

  it('for a stored input sent with a fileSize of 1', async () => {
    const storageKey = `uploads/${userId}/large.csv`;
    s3Storage.saveObject(storageKey, LARGE_CSV, 'text/csv', 'large.csv');
    const data = await submit({ filename: 'large.csv', targetFormat: 'json', storageKey, fileSize: 1 });
    expect(data.resourceClass).toBe('cpu');
    expect(data.fileSize).toBe(LARGE_CSV.length);
  });

  it('and keeps a small input in the light lane', async () => {
    const small = Buffer.from('name,score\nAlice,100\n');
    const data = await submit({ filename: 'small.csv', targetFormat: 'json', inputBufferBase64: small.toString('base64'), fileSize: 999 * MIB });
    expect(data.resourceClass).toBe('light');
    expect(data.fileSize).toBe(small.length);
  });
});
