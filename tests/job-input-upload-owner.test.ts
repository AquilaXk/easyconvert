import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as queueJobsRoute } from '../src/app/api/queue/jobs/route';
import { POST as v1ConvertRoute } from '../src/app/api/v1/convert/route';
import { POST as v1JobsRoute } from '../src/app/api/v1/jobs/route';
import { conversionQueue } from '../src/lib/queue/conversion-queue';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { getRetentionLedger } from '../src/lib/storage/retention-ledger';

/**
 * The input a request sends in its body is stored as an upload of its caller: an account's file lies under
 * `conversions/<userId>/` (where the erase of the account looks for it) and every one is recorded, so the sweep owns it.
 */

const BASE_URL = 'http://localhost:3000';
const CSV_INPUT = 'name,score\nAlice,100\nBob,95\n';

let userId: string;
let secretKey: string;

beforeEach(async () => {
  vi.stubEnv('REDIS_URL', '');
  vi.stubEnv('REDIS_HOST', '');
  const email = `owner_${Date.now()}_${crypto.randomBytes(6).toString('hex')}@owner.test`;
  const user = await userStore.createUser({ email, name: 'Owner', tier: 'free' });
  userId = user.id;
  secretKey = (await redisKeyStore.generateApiKey(user.id, 'Owner Key', { scopes: ['convert:write', 'convert:read'] })).secretKey;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function csvForm(): FormData {
  const form = new FormData();
  form.append('file', new File([CSV_INPUT], 'scores.csv', { type: 'text/csv' }));
  form.append('targetFormat', 'json');
  return form;
}

function request(url: string, headers: Record<string, string> = {}, auth = true): NextRequest {
  return new NextRequest(`${BASE_URL}${url}`, {
    method: 'POST',
    headers: { ...(auth ? { Authorization: `Bearer ${secretKey}` } : {}), ...headers },
    body: csvForm(),
  });
}

async function storedInputOf(res: Response): Promise<string> {
  const body = await res.json();
  const job = await conversionQueue.getJob(body.jobId);
  const key = job?.data.storageKey;
  expect(typeof key).toBe('string');
  return key as string;
}

describe('the file a request body carries, stored for a job', () => {
  it.each([
    ['POST /api/queue/jobs', () => queueJobsRoute(request('/api/queue/jobs')), 200],
    ['POST /api/v1/jobs', () => v1JobsRoute(request('/api/v1/jobs')), 202],
    ['POST /api/v1/convert with Prefer: respond-async', () => v1ConvertRoute(request('/api/v1/convert', { Prefer: 'respond-async' })), 202],
  ])('%s is stored under the account and recorded', async (_label, submit, status) => {
    const res = await submit();
    expect(res.status).toBe(status);

    const key = await storedInputOf(res);
    expect(key.startsWith(`conversions/${userId}/`)).toBe(true);
    expect((await getRetentionLedger().get(key))?.kind).toBe('account-upload');
  });

  it('POST /api/queue/jobs from a visitor without an account is recorded in the ownerless namespace', async () => {
    const res = await queueJobsRoute(request('/api/queue/jobs', {}, false));
    expect(res.status).toBe(200);

    const key = await storedInputOf(res);
    expect(key.startsWith('uploads/')).toBe(true);
    expect(await getRetentionLedger().get(key)).toBeDefined();
  });

  it('POST /api/queue/jobs answers 500 without the record error when the record cannot be written', async () => {
    vi.spyOn(getRetentionLedger(), 'update').mockRejectedValue(new Error('ledger is down at 10.1.2.3'));
    const res = await queueJobsRoute(request('/api/queue/jobs'));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('10.1.2.3');
  });
});
