import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as createJob } from '../src/app/api/v1/jobs/route';
import { GET as readJob } from '../src/app/api/v1/jobs/[id]/route';
import { userStore } from '../src/lib/auth/user-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { graphScheduler } from '../src/lib/queue/graph';
import { Worker } from '../src/lib/queue/bullmq-engine';
import { allConversionQueues, attachJobLifecycleListeners } from '../src/lib/queue/conversion-queue';
import { processNodeJob } from '../src/lib/queue/node-processor';
import type { ConversionEnginePort } from '../src/lib/queue/engine-port';
import { s3Storage } from '../src/lib/storage/s3-storage';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';

/**
 * A job submitted as a `tasks` array is a graph of one chain. The job API documents the `result` of a job (the `downloadUrl`,
 * `filename`, `mimeType` and `size` of the file), and a caller of the array form reads it there, as a caller of a job of one
 * conversion does. The converter is a stub, so the outcome is the scheduler's and the job API's.
 */

const CSV = 'name,score\nAlice,100\nBob,95\n';
const WAIT = { timeout: 20_000, interval: 50 };

const stubEngine: ConversionEnginePort = {
  name: 'stub',
  async convert(_input, _source, target, _options, filename) {
    const buffer = Buffer.from(`${target}:${filename}`);
    return { buffer, size: buffer.length, mimeType: target === 'json' ? 'application/json' : 'text/tab-separated-values', filename: `${filename.replace(/\.[^.]+$/, '')}.${target}` };
  },
};

let worker: Worker<ConversionJobData, ConversionJobResult> | undefined;
afterEach(async () => {
  await worker?.close();
  worker = undefined;
  vi.restoreAllMocks();
});

async function caller() {
  const user = userStore.sanitizeUser(await userStore.createUser({ emailVerified: true, email: `legacy-${Date.now()}-${crypto.randomBytes(4).toString('hex')}@legacy.test`, name: 'Legacy', tier: 'paid' }));
  const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'legacy tasks', { scopes: ['convert:write', 'convert:read'] });
  return `Bearer ${secretKey}`;
}

async function get(authorization: string, jobId: string) {
  const res = await readJob(new NextRequest(`http://localhost/api/v1/jobs/${jobId}`, { headers: { authorization } }), { params: Promise.resolve({ id: jobId }) });
  return { status: res.status, body: await res.json() };
}

async function submit(authorization: string, tasks: unknown[]): Promise<string> {
  const res = await createJob(
    new NextRequest('http://localhost/api/v1/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization },
      body: JSON.stringify({ filename: 'scores.csv', inputBufferBase64: Buffer.from(CSV).toString('base64'), tasks }),
    })
  );
  expect(res.status).toBe(202);
  return (await res.json()).jobId as string;
}

describe('a job submitted as a tasks array', () => {
  it('reports the download URL, name, type and size of its file in `result` once it completed, and no result before', async () => {
    worker = new Worker<ConversionJobData, ConversionJobResult>([...allConversionQueues] as never, (job) => processNodeJob(job, stubEngine), { concurrency: 2 });
    attachJobLifecycleListeners(worker);
    const authorization = await caller();
    const jobId = await submit(authorization, [
      { name: 'to-json', operation: 'convert', targetFormat: 'json' },
      { name: 'to-tsv', operation: 'convert', targetFormat: 'tsv' },
    ]);

    await vi.waitFor(async () => expect((await graphScheduler.getGraphState(jobId))?.status).toBe('completed'), WAIT);
    const { status, body } = await get(authorization, jobId);
    expect(status).toBe(200);
    expect(body.status).toBe('completed');
    expect(body.result).toMatchObject({ jobId, status: 'completed', mimeType: 'text/tab-separated-values' });
    expect(body.result.downloadUrl.startsWith('/api/storage/file/')).toBe(true);
    expect(body.result.filename).toMatch(/\.tsv$/);

    const key = decodeURIComponent(body.result.downloadUrl.slice('/api/storage/file/'.length));
    expect(key.startsWith(`results/${jobId}/`)).toBe(true);
    expect(body.result.resultKey).toBe(key);
    const stored = (await s3Storage.getObject(key))!.buffer;
    expect(body.result.size).toBe(stored.length);
    expect(stored.toString('utf-8')).toBe('tsv:scores.json');
    expect(typeof body.result.durationMs).toBe('number');
    expect(body.tasks).toHaveLength(2);
  }, 40_000);

  it('has no result while it has not completed', async () => {
    const authorization = await caller();
    const jobId = await submit(authorization, [{ name: 'to-json', operation: 'convert', targetFormat: 'json' }]);
    const { body } = await get(authorization, jobId);
    expect(body.status).not.toBe('completed');
    expect(body.result).toBeUndefined();
  }, 40_000);
});
