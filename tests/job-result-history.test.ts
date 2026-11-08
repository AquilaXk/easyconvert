import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { DELETE as deleteFileRoute } from '../src/app/api/account/files/[id]/route';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { createSessionToken } from '../src/lib/auth/session';
import { userStore } from '../src/lib/auth/user-store';
import type { User } from '../src/lib/auth/types';
import { Queue, Worker, type Job } from '../src/lib/queue/bullmq-engine';
import { attachJobLifecycleListeners } from '../src/lib/queue/conversion-queue';
import { recordJobResultInHistory } from '../src/lib/queue/job-history';
import { dispatchEngine } from '../src/lib/queue/dispatch-engine';
import { processNodeJob } from '../src/lib/queue/node-processor';
import { storageProvider } from '../src/lib/storage';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';

/**
 * A job a worker ends is part of its owner's history of converted files, as the synchronous conversion is: the account lists it
 * next to the others and can delete it, and a result nobody can reach is not listed.
 */

const CSV = 'name,score\nAlice,100\nBob,95\n';
const WAIT_MS = 20_000;
let queueNumber = 0;
let queue: Queue<ConversionJobData, ConversionJobResult>;
let worker: Worker<ConversionJobData, ConversionJobResult>;
let user: User;

beforeEach(async () => {
  user = userStore.sanitizeUser(await userStore.createUser({ email: `history_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@history.test`, name: 'History', tier: 'pro' }));
  queue = new Queue<ConversionJobData, ConversionJobResult>(`job-history-${queueNumber++}`);
  worker = new Worker<ConversionJobData, ConversionJobResult>(queue, (job) => processNodeJob(job, dispatchEngine), { concurrency: 1 });
  attachJobLifecycleListeners(worker);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await worker.close();
  await queue.close();
  await redisKeyStore.forgetUsage(user.id);
});

function jobData(overrides: Partial<ConversionJobData> = {}): ConversionJobData {
  return {
    jobId: 'history',
    originalFilename: 'scores.csv',
    sourceFormat: 'csv',
    targetFormat: 'json',
    fileSize: CSV.length,
    inputBufferBase64: Buffer.from(CSV).toString('base64'),
    options: {},
    userId: user.id,
    ...overrides,
  };
}

async function runToCompletion(data: ConversionJobData): Promise<Job<ConversionJobData, ConversionJobResult>> {
  const ended = new Promise<void>((resolve) => worker.once('completed', () => resolve()));
  const job = await queue.add('convert', data, { attempts: 1 });
  await ended;
  return job;
}

describe('the history of converted files', () => {
  it('lists the result of a queue job that completed, under the job id, with the result it names', async () => {
    const job = await runToCompletion(jobData());

    await vi.waitFor(async () => expect(await redisKeyStore.listUserFiles(user.id)).toHaveLength(1), { timeout: WAIT_MS });
    const [record] = await redisKeyStore.listUserFiles(user.id);
    const result = job.returnvalue as ConversionJobResult;
    expect(record).toMatchObject({
      id: job.id,
      userId: user.id,
      fileName: result.filename,
      fromFormat: 'csv',
      toFormat: 'json',
      size: result.size,
      downloadUrl: result.downloadUrl,
      storageKey: result.resultKey,
    });
    expect(record.expiresAt).toBeGreaterThan(Date.now());
  }, WAIT_MS);

  it('records the same result once when the completion is reported again', async () => {
    const job = await runToCompletion(jobData());
    await vi.waitFor(async () => expect(await redisKeyStore.listUserFiles(user.id)).toHaveLength(1), { timeout: WAIT_MS });

    await recordJobResultInHistory(job, job.returnvalue as ConversionJobResult);

    expect(await redisKeyStore.listUserFiles(user.id)).toHaveLength(1);
  }, WAIT_MS);

  it('does not list the result of a job without an owner or of an anonymous visitor', async () => {
    const spy = vi.spyOn(redisKeyStore, 'recordUserFile');
    const result = { jobId: 'j', status: 'completed', resultKey: 'results/j/a.json', downloadUrl: '/x', filename: 'a.json', mimeType: 'application/json', size: 3, durationMs: 1 } satisfies ConversionJobResult;

    await recordJobResultInHistory({ id: 'j', data: jobData({ userId: undefined }) } as Job<ConversionJobData, ConversionJobResult>, result);
    await recordJobResultInHistory({ id: 'j', data: jobData({ userId: 'anon:203.0.113' }) } as Job<ConversionJobData, ConversionJobResult>, result);

    expect(spy).not.toHaveBeenCalled();
  });

  it('does not list a node of a graph: the graph answers for its nodes', async () => {
    const spy = vi.spyOn(redisKeyStore, 'recordUserFile');
    const result = { jobId: 'g:n', status: 'completed', resultKey: 'results/g/n/a.json', downloadUrl: '/x', filename: 'a.json', mimeType: 'application/json', size: 3, durationMs: 1 } satisfies ConversionJobResult;

    await recordJobResultInHistory({ id: 'g:n', data: jobData({ graphId: 'g', graphNodeId: 'n' }) } as Job<ConversionJobData, ConversionJobResult>, result);

    expect(spy).not.toHaveBeenCalled();
  });

  it('does not fail the completion of a job when the history cannot be written', async () => {
    vi.spyOn(redisKeyStore, 'recordUserFile').mockRejectedValue(new Error('history down'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const job = await runToCompletion(jobData());

    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(expect.stringContaining(`job ${job.id}`), expect.any(Error)), { timeout: WAIT_MS });
    expect(job.state).toBe('completed');
  }, WAIT_MS);

  it('deletes the stored result with the record when the owner deletes it from the account', async () => {
    const job = await runToCompletion(jobData());
    await vi.waitFor(async () => expect(await redisKeyStore.listUserFiles(user.id)).toHaveLength(1), { timeout: WAIT_MS });
    const result = job.returnvalue as ConversionJobResult;
    expect(await storageProvider.getObject(result.resultKey)).toBeTruthy();
    const cookie = { Cookie: `easyconvert_session=${createSessionToken(user)}` };

    const res = await deleteFileRoute(new NextRequest(`http://localhost/api/account/files/${job.id}`, { method: 'DELETE', headers: cookie }), { params: Promise.resolve({ id: job.id }) });

    expect(res.status).toBe(200);
    expect(await redisKeyStore.listUserFiles(user.id)).toEqual([]);
    await expect(Promise.resolve(storageProvider.getObject(result.resultKey))).resolves.toBeFalsy();
  }, WAIT_MS);

  it('refuses to delete a stored result that is not the one of the job the record names', async () => {
    const job = await runToCompletion(jobData());
    await vi.waitFor(async () => expect(await redisKeyStore.listUserFiles(user.id)).toHaveLength(1), { timeout: WAIT_MS });
    const otherKey = `results/other_job_${crypto.randomBytes(4).toString('hex')}/result.json`;
    await storageProvider.saveObject(otherKey, Buffer.from('{}'), 'application/json', 'result.json');
    await redisKeyStore.recordUserFile({ id: job.id, userId: user.id, fileName: 'result.json', fromFormat: 'csv', toFormat: 'json', size: 2, downloadUrl: '/x', storageKey: otherKey });
    const cookie = { Cookie: `easyconvert_session=${createSessionToken(user)}` };

    const res = await deleteFileRoute(new NextRequest(`http://localhost/api/account/files/${job.id}`, { method: 'DELETE', headers: cookie }), { params: Promise.resolve({ id: job.id }) });

    expect(res.status).toBe(404);
    expect(await storageProvider.getObject(otherKey)).toBeTruthy();
    expect(await redisKeyStore.findUserFile(user.id, job.id)).toBeDefined();
    await storageProvider.deleteObject(otherKey);
  }, WAIT_MS);
});
