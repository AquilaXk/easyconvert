import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as createJob } from '../src/app/api/v1/jobs/route';
import { userStore } from '../src/lib/auth/user-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { graphScheduler } from '../src/lib/queue/graph';
import { Worker } from '../src/lib/queue/bullmq-engine';
import { allConversionQueues, attachJobLifecycleListeners, processConversionJob } from '../src/lib/queue/conversion-queue';
import { s3Storage } from '../src/lib/storage/s3-storage';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';

/**
 * A legacy `tasks` pipeline whose input comes in the request body, as `inputBufferBase64` or as a multipart `file`, reads
 * that input: the route stores it before the graph is queued, and the graph's import node names the stored file.
 */

const CSV = 'name,score\nAlice,100\nBob,95\n';
const GRAPH_TIMEOUT_MS = 30_000;

let worker: Worker<ConversionJobData, ConversionJobResult> | undefined;

afterEach(async () => {
  await worker?.close();
  worker = undefined;
  vi.restoreAllMocks();
});

async function apiKey(): Promise<string> {
  const email = `inline_${Date.now()}_${Math.random().toString(36).slice(2)}@inline.test`;
  const user = await userStore.createUser({ email, name: 'inline', tier: 'pro' });
  const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'inline', { scopes: ['convert:write'] });
  return secretKey;
}

const TASKS = [{ name: 'to-json', operation: 'convert', targetFormat: 'json' }];

async function viaBase64(): Promise<Response> {
  return createJob(
    new NextRequest('https://easyconvert.app/api/v1/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await apiKey()}` },
      body: JSON.stringify({ filename: 'scores.csv', inputBufferBase64: Buffer.from(CSV).toString('base64'), tasks: TASKS }),
    })
  );
}

async function viaMultipart(): Promise<Response> {
  const form = new FormData();
  form.set('file', new File([CSV], 'scores.csv', { type: 'text/csv' }));
  form.set('tasks', JSON.stringify(TASKS));
  return createJob(new NextRequest('https://easyconvert.app/api/v1/jobs', { method: 'POST', headers: { Authorization: `Bearer ${await apiKey()}` }, body: form }));
}

describe('a tasks pipeline whose input is in the request body', () => {
  it.each([
    ['inputBufferBase64', viaBase64],
    ['a multipart file', viaMultipart],
  ])('converts the input it was sent as %s', async (_label, submit) => {
    worker = new Worker<ConversionJobData, ConversionJobResult>([...allConversionQueues] as never, processConversionJob, { concurrency: 2 });
    attachJobLifecycleListeners(worker);

    const res = await submit();
    expect(res.status).toBe(202);
    const { jobId } = await res.json();

    await vi.waitFor(async () => expect(['completed', 'failed']).toContain((await graphScheduler.getGraphState(jobId))?.status), { timeout: GRAPH_TIMEOUT_MS, interval: 100 });
    const state = await graphScheduler.getGraphState(jobId);
    expect(Object.values(state?.nodes ?? {}).map((node) => node.error).filter(Boolean)).toEqual([]);
    expect(state?.status).toBe('completed');
  }, GRAPH_TIMEOUT_MS + 10_000);
});

describe('a request whose input is in the request body and that is refused', () => {
  async function multipart(fields: Record<string, string>): Promise<Response> {
    const form = new FormData();
    form.set('file', new File([CSV], 'scores.csv', { type: 'text/csv' }));
    for (const [name, value] of Object.entries(fields)) form.set(name, value);
    return createJob(new NextRequest('https://easyconvert.app/api/v1/jobs', { method: 'POST', headers: { Authorization: `Bearer ${await apiKey()}` }, body: form }));
  }

  it.each([
    ['names a target format that does not exist', { targetFormat: 'not-a-format' }, 400],
    ['names a webhook without its secret', { targetFormat: 'json', webhookUrl: 'https://hooks.example.com/job' }, 400],
  ])('stores nothing when it %s', async (_label, fields, status) => {
    const stored = vi.spyOn(s3Storage, 'completeMultipartUpload');

    const res = await multipart(fields);

    expect(res.status).toBe(status);
    expect(stored).not.toHaveBeenCalled();
  });
});
