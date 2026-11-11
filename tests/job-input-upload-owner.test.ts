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
import { storageProvider } from '../src/lib/storage';
import { sweepRetention } from '../src/lib/storage/retention-service';
import { resolveRetentionPolicy } from '../src/lib/storage/result-retention';
import { Worker } from '../src/lib/queue/bullmq-engine';
import { allConversionQueues, attachInputCleanupOnCompletion, attachJobLifecycleListeners, processConversionJob } from '../src/lib/queue/conversion-queue';
import { eraseAccount, planAccountErasure } from '../scripts/erase-account';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';

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
  ])('%s is stored under the account and recorded as a job input', async (_label, submit, status) => {
    const res = await submit();
    expect(res.status).toBe(status);

    const key = await storedInputOf(res);
    expect(key.startsWith(`conversions/${userId}/`)).toBe(true);
    // The body of one request, not an upload of the account: its job's end deletes it.
    expect((await getRetentionLedger().get(key))?.kind).toBe('upload');
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

describe('the lifecycle of the body file of a signed-in job', () => {
  let worker: Worker<ConversionJobData, ConversionJobResult> | undefined;

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
  });

  function startWorker(processor: (job: never) => Promise<ConversionJobResult>) {
    worker = new Worker<ConversionJobData, ConversionJobResult>([...allConversionQueues] as never, processor as never, { concurrency: 1 });
    attachJobLifecycleListeners(worker);
    attachInputCleanupOnCompletion(worker);
  }

  async function submit(): Promise<{ jobId: string; key: string }> {
    const res = await queueJobsRoute(request('/api/queue/jobs'));
    expect(res.status).toBe(200);
    const { jobId } = await res.json();
    const job = await conversionQueue.getJob(jobId);
    return { jobId, key: job?.data.storageKey as string };
  }

  /** The sweep a grace period after the job ended removes the body, as it does for a visitor's file. */
  async function expectBodyGoneAfterGrace(key: string): Promise<void> {
    await vi.waitFor(async () => {
      const record = await getRetentionLedger().get(key);
      expect(record === undefined || record.deleteAt <= Date.now() + resolveRetentionPolicy().deliveredGraceMs).toBe(true);
    });
    await sweepRetention(storageProvider, Date.now() + resolveRetentionPolicy().deliveredGraceMs + 1_000);
    expect(await storageProvider.stat(key)).toBeFalsy();
  }

  it('is deleted after the job completes', async () => {
    startWorker(processConversionJob as never);
    const { jobId, key } = await submit();
    expect(key.startsWith(`conversions/${userId}/`)).toBe(true);

    await vi.waitFor(async () => expect((await conversionQueue.getJob(jobId))?.state).toBe('completed'), { timeout: 20_000, interval: 100 });

    await expectBodyGoneAfterGrace(key);
  }, 40_000);

  it('is deleted after the job fails for good', async () => {
    startWorker(async () => {
      throw new Error('the engine failed');
    });
    const { jobId, key } = await submit();

    await vi.waitFor(async () => expect((await conversionQueue.getJob(jobId))?.state).toBe('failed'), { timeout: 20_000, interval: 100 });

    await expectBodyGoneAfterGrace(key);
  }, 40_000);

  it('is deleted after the job is cancelled', async () => {
    const { jobId, key } = await submit();

    expect(await conversionQueue.cancelJob(jobId, 'cancelled by the test')).toBe(true);

    await expectBodyGoneAfterGrace(key);
  });

  it('is found and deleted by the erasure of the account while its job waits', async () => {
    const { key } = await submit();
    const plan = await planAccountErasure(userId);
    expect(plan?.storedKeys).toContain(key);

    await eraseAccount(plan!, { drainMs: 0 });

    expect(await storageProvider.stat(key)).toBeFalsy();
    expect(await getRetentionLedger().get(key)).toBeUndefined();
  });
});
