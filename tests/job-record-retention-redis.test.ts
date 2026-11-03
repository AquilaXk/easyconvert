import crypto from 'node:crypto';
import Redis from 'ioredis';
import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DistributedBullMQAdapter, Worker, type JobOptions } from '../src/lib/queue/bullmq-engine';
import { attachJobLifecycleListeners, resourceQueues, sweepEndedRecords } from '../src/lib/queue/conversion-queue';
import { endedJobRetentionMs, enqueueConversionJob } from '../src/lib/queue/enqueue';
import { webhookDispatcher } from '../src/lib/api-keys/webhook-dispatcher';
import type { ConversionJobData } from '../src/lib/types';

/**
 * What the Redis queue keeps of a job once it ends: the data keys named in `removeDataOnFinish` are gone from the stored
 * job and from its dead letter, and `removeOnComplete` / `removeOnFail` given as `{ age }` remove the jobs that ended more
 * than `age` seconds ago, as BullMQ's KeepJobs does. Needs a real Redis server (the transitions are Lua scripts); the
 * Redis-mode CI step (npm run test:redis) sets REDIS_URL and runs this file.
 */
const REDIS_URL = process.env.REDIS_URL;
const AGE_SECONDS = 60;
const AGE_MS = AGE_SECONDS * 1000;

interface Data {
  userId?: string;
  name: string;
  inline?: string;
  secret?: string;
}

const ENDING_OPTS: JobOptions = {
  attempts: 1,
  removeDataOnFinish: ['inline', 'secret'],
  removeOnComplete: { age: AGE_SECONDS },
  removeOnFail: { age: AGE_SECONDS },
};

// skip-ok: mode selection. The shards run without REDIS_URL; the Redis-mode CI step (npm run test:redis) sets it and runs this file.
describe.skipIf(!REDIS_URL)('Job records after the job ends, on a real Redis server', () => {
  let keyPrefix: string;
  let admin: Redis;
  const adapters: DistributedBullMQAdapter<Data, string>[] = [];

  function connect(queueName: string): DistributedBullMQAdapter<Data, string> {
    const client = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
    const adapter = new DistributedBullMQAdapter<Data, string>(queueName, { redisClient: client, keyPrefix });
    adapters.push(adapter);
    return adapter;
  }

  const keyOf = (queueName: string, suffix: string) => `${keyPrefix}{${queueName}}:${suffix}`;

  async function storedData(queueName: string, jobId: string): Promise<Record<string, unknown>> {
    return JSON.parse((await admin.hget(keyOf(queueName, `job:${jobId}`), 'data')) ?? 'null');
  }

  async function runToActive(queue: DistributedBullMQAdapter<Data, string>, data: Data, opts: JobOptions = ENDING_OPTS) {
    const job = await queue.add('convert', data, opts);
    const popped = await queue._popNextWaiting();
    expect(popped?.id).toBe(job.id);
    popped!.attemptsMade = 1;
    return popped!;
  }

  beforeEach(() => {
    keyPrefix = `record-retention-${crypto.randomBytes(6).toString('hex')}:`;
    admin = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
  });

  afterEach(async () => {
    while (adapters.length > 0) await adapters.pop()!.close();
    const keys = await admin.keys(`${keyPrefix}*`);
    if (keys.length > 0) await admin.del(...keys);
    await admin.quit();
  });

  describe('the data a job drops when it ends', () => {
    const data: Data = { userId: 'u1', name: 'report.pdf', inline: 'aGVsbG8=', secret: 'whsec_plain' };

    it('drops it on completion, and the attempt that completed the job still has it', async () => {
      const queue = connect('drop-complete');
      const attempt = await runToActive(queue, data);
      expect(await queue._onJobCompleted(attempt, 'done')).toBe(true);

      expect(await storedData('drop-complete', attempt.id)).toEqual({ userId: 'u1', name: 'report.pdf' });
      expect(attempt.data.secret).toBe('whsec_plain');
      expect((await queue.getJob(attempt.id))?.state).toBe('completed');
    });

    it('drops it on the last failure, from the job and from its dead letter', async () => {
      const queue = connect('drop-fail');
      const attempt = await runToActive(queue, data);
      attempt.failedReason = 'engine crashed';
      expect(await queue._onJobFailed(attempt, new Error('engine crashed'))).toBe(true);
      await queue.moveToDlq(attempt, 'engine crashed');

      expect(await storedData('drop-fail', attempt.id)).toEqual({ userId: 'u1', name: 'report.pdf' });
      const [letter] = await queue.getDlqEntries();
      expect(letter.data).toEqual({ userId: 'u1', name: 'report.pdf' });
    });

    it('drops it on a cancel', async () => {
      const queue = connect('drop-cancel');
      const job = await queue.add('convert', data, ENDING_OPTS);
      expect(await queue.cancelJob(job.id, 'client cancelled')).toBe(true);

      expect(await storedData('drop-cancel', job.id)).toEqual({ userId: 'u1', name: 'report.pdf' });
    });

    it('drops it when the stalled sweep fails the job, after handing the job out with its data', async () => {
      const queue = connect('drop-stalled');
      const attempt = await runToActive(queue, data);
      await admin.del(keyOf('drop-stalled', `heartbeat:${attempt.id}`));

      const [failed] = await queue._recoverStalledJobs();
      expect(failed.data.secret).toBe('whsec_plain');
      expect(await storedData('drop-stalled', attempt.id)).toEqual({ userId: 'u1', name: 'report.pdf' });
    });

    it('keeps the data of a job that asks for nothing to be dropped', async () => {
      const queue = connect('drop-none');
      const attempt = await runToActive(queue, data, { attempts: 1 });
      expect(await queue._onJobCompleted(attempt, 'done')).toBe(true);

      expect(await storedData('drop-none', attempt.id)).toEqual(data);
    });

    it('keeps it while a failed attempt is retried', async () => {
      const queue = connect('drop-retry');
      const attempt = await runToActive(queue, data, { ...ENDING_OPTS, attempts: 2 });
      expect(await queue._requeue(attempt, 0)).toBe(true);

      expect(await storedData('drop-retry', attempt.id)).toEqual(data);
    });
  });

  describe('jobs removed by age, as BullMQ KeepJobs { age }', () => {
    it('removes a completed job that ended more than age seconds ago when a later job completes, and keeps a younger one', async () => {
      const queue = connect('age-complete');
      const old = await runToActive(queue, { userId: 'u1', name: 'old' });
      old.finishedOn = Date.now() - AGE_MS - 1;
      await queue._onJobCompleted(old, 'old');
      const young = await runToActive(queue, { userId: 'u1', name: 'young' });
      young.finishedOn = Date.now() - AGE_MS + 5_000;
      await queue._onJobCompleted(young, 'young');

      const last = await runToActive(queue, { userId: 'u1', name: 'last' });
      await queue._onJobCompleted(last, 'last');

      expect(await queue.getJob(old.id)).toBeUndefined();
      expect(await admin.sismember(keyOf('age-complete', 'completed'), old.id)).toBe(0);
      expect((await queue.getJobsByUser('u1')).map((job) => job.data.name).sort()).toEqual(['last', 'young']);
    });

    it('removes a failed job that ended more than age seconds ago when a later job fails, with its dead letter', async () => {
      const queue = connect('age-fail');
      const old = await runToActive(queue, { name: 'old' });
      old.finishedOn = Date.now() - AGE_MS - 1;
      await queue._onJobFailed(old, new Error('old'));
      await queue.moveToDlq(old, 'old');
      const dlqKey = keyOf('age-fail', 'dlq');
      await admin.lset(dlqKey, 0, JSON.stringify({ ...(await queue.getDlqEntries())[0], timestamp: Date.now() - AGE_MS - 1 }));

      const last = await runToActive(queue, { name: 'last' });
      await queue._onJobFailed(last, new Error('last'));
      await queue.moveToDlq(last, 'last');

      expect(await queue.getJob(old.id)).toBeUndefined();
      expect((await queue.getJob(last.id))?.state).toBe('failed');
      expect((await queue.getDlqEntries()).map((letter) => letter.jobId)).toEqual([last.id]);
    });

    it('clean removes ended jobs older than the grace of every end state, cancelled ones included', async () => {
      const queue = connect('age-clean');
      const job = await queue.add('convert', { userId: 'u2', name: 'cancelled' }, ENDING_OPTS);
      await queue.cancelJob(job.id, 'client cancelled');
      await admin.hset(keyOf('age-clean', `job:${job.id}`), 'finishedOn', String(Date.now() - AGE_MS - 1));

      expect(await queue.clean(AGE_MS, 100, 'cancelled')).toEqual([job.id]);
      expect(await queue.getJob(job.id)).toBeUndefined();
      expect(await queue.getJobsByUser('u2')).toEqual([]);
    });
  });

  describe('conversion jobs', () => {
    const conversionKeys: string[] = [];
    const csvJob = (extra: Partial<ConversionJobData>): ConversionJobData => ({
      jobId: '',
      originalFilename: 'scores.csv',
      sourceFormat: 'csv',
      targetFormat: 'json',
      fileSize: 8,
      options: {},
      userId: 'u-record',
      inputBufferBase64: Buffer.from('a\n1\n').toString('base64'),
      ...extra,
    });

    afterEach(async () => {
      if (conversionKeys.length > 0) await admin.del(...conversionKeys.splice(0));
    });

    it('drop their inline input and webhook secret when they end, while the completed webhook is still signed with the secret', async () => {
      const dispatch = vi.spyOn(webhookDispatcher, 'dispatch').mockResolvedValue({} as never);
      const worker = new Worker([resourceQueues.light], async (job) => ({ jobId: job.id, status: 'completed' }) as never, { concurrency: 1 });
      attachJobLifecycleListeners(worker);
      try {
        const completed = new Promise((resolve) => (worker as EventEmitter).once('completed', resolve));
        const job = await enqueueConversionJob(
          resourceQueues.light,
          'convert',
          csvJob({ webhookUrl: 'https://93.184.215.14/hook', webhookSecret: 'whsec_job_plain' }),
          { attempts: 1 },
          { tier: 'free', inputBytes: 8 }
        );
        const [jobKey] = await admin.keys(`*{easyconvert-jobs:light}:job:${job.id}`);
        conversionKeys.push(jobKey);
        await completed;
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalled());

        const stored = await admin.hgetall(jobKey);
        expect(stored.state).toBe('completed');
        const data = JSON.parse(stored.data);
        expect(data).not.toHaveProperty('inputBufferBase64');
        expect(data).not.toHaveProperty('webhookSecret');
        expect(data).toMatchObject({ originalFilename: 'scores.csv', webhookUrl: 'https://93.184.215.14/hook', userId: 'u-record' });
        expect(dispatch.mock.calls[0][3]).toBe('whsec_job_plain');
      } finally {
        vi.restoreAllMocks();
        await worker.close();
      }
    }, 15000);

    it('are removed by the sweep once the ended-job retention has passed, also when no later job ends', async () => {
      const job = await enqueueConversionJob(resourceQueues.light, 'convert', csvJob({}), { attempts: 1 }, { tier: 'free', inputBytes: 8 });
      const [jobKey] = await admin.keys(`*{easyconvert-jobs:light}:job:${job.id}`);
      conversionKeys.push(jobKey);
      expect(await resourceQueues.light.cancelJob(job.id, 'client cancelled')).toBe(true);

      await sweepEndedRecords();
      expect(await admin.exists(jobKey)).toBe(1);

      await admin.hset(jobKey, 'finishedOn', String(Date.now() - endedJobRetentionMs() - 1));
      await sweepEndedRecords();
      expect(await admin.exists(jobKey)).toBe(0);
      expect(await resourceQueues.light.getJobsByUser('u-record')).toEqual([]);
    });
  });
});
