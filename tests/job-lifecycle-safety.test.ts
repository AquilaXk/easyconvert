import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  Queue,
  Worker,
  DistributedBullMQAdapter,
  JobCancelledError,
  JobTimeoutError,
  type IQueueEngine,
} from '../src/lib/queue/bullmq-engine';
import {
  conversionQueue,
  processConversionJob,
  attachJobLifecycleListeners,
  attachJobCancellationListeners,
} from '../src/lib/queue/conversion-queue';
import { GET as getLegacyJob, DELETE as deleteLegacyJob } from '../src/app/api/queue/jobs/[id]/route';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { s3Storage } from '../src/lib/storage/s3-storage';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';

interface Gate {
  promise: Promise<void>;
  release: () => void;
}

function createGate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function nextEvent(emitter: EventEmitter, event: string): Promise<unknown[]> {
  return new Promise((resolve) => {
    emitter.once(event, (...args: unknown[]) => resolve(args));
  });
}

interface EngineCase {
  label: string;
  create: (name: string) => IQueueEngine<{ payload: string }, string>;
}

const IN_PROCESS_ENGINES: EngineCase[] = [
  { label: 'in-memory Queue', create: (name) => new Queue<{ payload: string }, string>(name) },
  {
    label: 'DistributedBullMQAdapter without Redis (in-memory fallback)',
    create: (name) => new DistributedBullMQAdapter<{ payload: string }, string>(name),
  },
];

const CSV_INPUT = 'name,score\nAlice,100\nBob,95\n';
const PIPELINE_INPUT_LOADED_PROGRESS = 35;

async function createQuotaUser(label: string) {
  const user = await redisUserStore.createUser({
    email: `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}@example.com`,
    name: `Lifecycle ${label}`,
    tier: 'pro',
    provider: 'email',
    passwordHash: 'lifecycle_hash',
    salt: 'lifecycle_salt',
  });
  const reservation = await redisKeyStore.reserveQuota(user.id, 1);
  expect(reservation.allowed).toBe(true);
  expect(typeof reservation.reservationId).toBe('string');
  return { user, reservationId: reservation.reservationId as string };
}

function csvJobData(overrides: Partial<ConversionJobData> = {}): ConversionJobData {
  const input = Buffer.from(CSV_INPUT, 'utf-8');
  return {
    jobId: `lifecycle_${Date.now()}`,
    originalFilename: 'scores.csv',
    sourceFormat: 'csv',
    targetFormat: 'json',
    fileSize: input.length,
    options: {},
    inputBufferBase64: input.toString('base64'),
    ...overrides,
  };
}

async function readSseEvents(res: Response): Promise<string[]> {
  const body = res.body;
  if (!body) {
    throw new Error('SSE response has no body');
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
}

describe('Job lifecycle safety: cancellation, timeouts, and engine-backed cancel routes', () => {
  beforeEach(() => {
    // Force the in-process engines in this file; Redis mode is covered in job-lifecycle-redis.test.ts.
    vi.stubEnv('REDIS_URL', '');
    vi.stubEnv('REDIS_HOST', '');
    redisKeyStore.resetStore();
    redisUserStore.resetStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe.each(IN_PROCESS_ENGINES)('1. Cancelling an active job ($label)', ({ create }) => {
    it('keeps the job cancelled when its processor resolves after the cancel', async () => {
      const queue = create('cancel-then-resolve');
      const started = createGate();
      const unblock = createGate();
      const observed: { aborted?: boolean; reason?: unknown } = {};
      const onJobCompletedSpy = queue._onJobCompleted ? vi.spyOn(queue, '_onJobCompleted') : undefined;
      const cancelledIds: string[] = [];
      queue.on('cancelled', (job: { id: string }) => cancelledIds.push(job.id));

      const worker = new Worker(
        queue,
        async (job) => {
          started.release();
          await unblock.promise;
          // Optional chaining keeps this processor non-throwing on engines without a signal.
          observed.aborted = job.signal?.aborted;
          observed.reason = job.signal?.reason;
          return `converted:${job.data.payload}`;
        },
        { concurrency: 1 }
      );
      const completedEvents: unknown[] = [];
      worker.on('completed', (job) => completedEvents.push(job));

      const job = await queue.add('convert', { payload: 'a' }, { attempts: 3 });
      await started.promise;
      expect((await queue.getJob(job.id))?.state).toBe('active');

      const drained = nextEvent(worker, 'drained');
      expect(await queue.cancelJob(job.id, 'client cancelled')).toBe(true);
      unblock.release();
      await drained;

      const final = await queue.getJob(job.id);
      expect(final?.state).toBe('cancelled');
      expect(final?.failedReason).toBe('client cancelled');
      expect(final?.returnvalue).toBeUndefined();
      expect(final?.progress).toBe(0);
      expect(completedEvents).toHaveLength(0);
      if (onJobCompletedSpy) {
        expect(onJobCompletedSpy).not.toHaveBeenCalled();
      }
      expect(observed.aborted).toBe(true);
      expect(observed.reason).toBeInstanceOf(JobCancelledError);
      expect(cancelledIds).toEqual([job.id]);

      const counts = await queue.getJobCounts();
      expect(counts).toMatchObject({ waiting: 0, active: 0, completed: 0, failed: 0, cancelled: 1 });

      await worker.close();
      await queue.close();
    });

    it('does not retry or dead-letter a cancelled job whose processor rejects afterwards', async () => {
      const queue = create('cancel-then-reject');
      const started = createGate();
      const unblock = createGate();
      let processorCalls = 0;

      const worker = new Worker(
        queue,
        async () => {
          processorCalls++;
          started.release();
          await unblock.promise;
          throw new Error('engine aborted mid-stream');
        },
        { concurrency: 1 }
      );
      const failedEvents: unknown[] = [];
      worker.on('failed', (job) => failedEvents.push(job));

      const job = await queue.add(
        'convert',
        { payload: 'b' },
        { attempts: 3, backoff: { type: 'fixed', delay: 5 } }
      );
      await started.promise;

      const drained = nextEvent(worker, 'drained');
      expect(await queue.cancelJob(job.id, 'client cancelled')).toBe(true);
      unblock.release();
      await drained;

      const final = await queue.getJob(job.id);
      expect(final?.state).toBe('cancelled');
      expect(final?.attemptsMade).toBe(1);
      expect(final?.failedReason).toBe('client cancelled');

      const counts = await queue.getJobCounts();
      expect(counts).toMatchObject({ waiting: 0, delayed: 0, active: 0, failed: 0, cancelled: 1 });
      expect(failedEvents).toHaveLength(0);
      expect(queue.getDlqEntries ? await queue.getDlqEntries() : []).toEqual([]);

      // A retry would have been scheduled 5ms out; confirm nothing re-runs the processor.
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(processorCalls).toBe(1);

      await worker.close();
      await queue.close();
    });

    it('cancels waiting and delayed jobs so a worker never runs them', async () => {
      const queue = create('cancel-queued');
      const waitingJob = await queue.add('convert', { payload: 'waiting' });
      const delayedJob = await queue.add('convert', { payload: 'delayed' }, { delay: 20 });

      expect(await queue.cancelJob(waitingJob.id, 'drop waiting')).toBe(true);
      expect(await queue.cancelJob(delayedJob.id, 'drop delayed')).toBe(true);

      const counts = await queue.getJobCounts();
      expect(counts).toMatchObject({ waiting: 0, delayed: 0, cancelled: 2 });
      const cancelledIds = (await queue.getJobs(['cancelled'])).map((j) => j.id).sort();
      expect(cancelledIds).toEqual([waitingJob.id, delayedJob.id].sort());
      expect(await queue.getJobs(['waiting', 'delayed'])).toEqual([]);

      const processed: string[] = [];
      const worker = new Worker(
        queue,
        async (job) => {
          processed.push(job.data.payload);
          return job.data.payload;
        },
        { concurrency: 1 }
      );
      // Wait past the original delay so a surviving timer would have promoted the delayed job.
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(processed).toEqual([]);
      expect((await queue.getJob(delayedJob.id))?.state).toBe('cancelled');

      await worker.close();
      await queue.close();
    });

    it('refuses to cancel completed, failed, cancelled, or unknown jobs', async () => {
      const queue = create('cancel-terminal');
      const worker = new Worker(
        queue,
        async (job) => {
          if (job.data.payload === 'fail') {
            throw new Error('unrecoverable input');
          }
          return 'ok';
        },
        { concurrency: 1 }
      );

      const completed = nextEvent(worker, 'completed');
      const completedJob = await queue.add('convert', { payload: 'ok' });
      await completed;

      const failed = nextEvent(worker, 'failed');
      const failedJob = await queue.add('convert', { payload: 'fail' }, { attempts: 1 });
      await failed;

      await worker.close();
      const cancelledJob = await queue.add('convert', { payload: 'cancel' });
      expect(await queue.cancelJob(cancelledJob.id, 'first cancel')).toBe(true);

      expect(await queue.cancelJob(completedJob.id, 'late cancel')).toBe(false);
      expect(await queue.cancelJob(failedJob.id, 'late cancel')).toBe(false);
      expect(await queue.cancelJob(cancelledJob.id, 'second cancel')).toBe(false);
      expect(await queue.cancelJob('job_does_not_exist', 'late cancel')).toBe(false);

      expect((await queue.getJob(completedJob.id))?.state).toBe('completed');
      expect((await queue.getJob(failedJob.id))?.state).toBe('failed');
      expect((await queue.getJob(cancelledJob.id))?.failedReason).toBe('first cancel');

      await queue.close();
    });
  });

  describe.each(IN_PROCESS_ENGINES)('2. Job timeout enforcement ($label)', ({ create }) => {
    it('aborts a hung attempt, retries it, then fails the job into the DLQ', async () => {
      const queue = create('timeout-retry');
      const abortReasons: unknown[] = [];

      const worker = new Worker(
        queue,
        (job) =>
          new Promise<string>((_resolve, reject) => {
            job.signal.addEventListener(
              'abort',
              () => {
                abortReasons.push(job.signal.reason);
                reject(job.signal.reason);
              },
              { once: true }
            );
          }),
        { concurrency: 1 }
      );

      const failed = nextEvent(worker, 'failed');
      const job = await queue.add(
        'convert',
        { payload: 'hang' },
        { attempts: 2, backoff: { type: 'fixed', delay: 5 }, timeout: 50 }
      );
      const [failedJob, err] = (await failed) as [{ id: string }, unknown];

      expect(failedJob.id).toBe(job.id);
      expect(err).toBeInstanceOf(JobTimeoutError);
      expect((err as Error).message).toBe('Job timed out after 50ms');

      const final = await queue.getJob(job.id);
      expect(final?.state).toBe('failed');
      expect(final?.attemptsMade).toBe(2);
      expect(final?.failedReason).toBe('Job timed out after 50ms');

      expect(abortReasons).toHaveLength(2);
      for (const reason of abortReasons) {
        expect(reason).toBeInstanceOf(JobTimeoutError);
        expect((reason as Error).name).toBe('TimeoutError');
      }

      const dlq = queue.getDlqEntries ? await queue.getDlqEntries() : [];
      expect(dlq).toHaveLength(1);
      expect(dlq[0].jobId).toBe(job.id);
      expect(dlq[0].failedReason).toBe('Job timed out after 50ms');
      expect(dlq[0].attemptsMade).toBe(2);

      await worker.close();
      await queue.close();
    }, 5000);

    it('fails a processor that ignores the abort signal once the timeout elapses', async () => {
      const queue = create('timeout-ignored-signal');
      const worker = new Worker(queue, () => new Promise<string>(() => undefined), { concurrency: 1 });

      const failed = nextEvent(worker, 'failed');
      const job = await queue.add('convert', { payload: 'stuck' }, { attempts: 1, timeout: 30 });
      const [, err] = (await failed) as [unknown, unknown];

      expect(err).toBeInstanceOf(JobTimeoutError);
      const final = await queue.getJob(job.id);
      expect(final?.state).toBe('failed');
      expect(final?.failedReason).toBe('Job timed out after 30ms');
      expect(final?.signal.aborted).toBe(true);

      await worker.close();
      await queue.close();
    }, 5000);
  });

  describe('3. SSE stream treats a cancelled job as terminal', () => {
    it('closes the SSE stream immediately for a cancelled job', async () => {
      const job = await conversionQueue.add('convert', csvJobData());
      expect(await conversionQueue.cancelJob(job.id, 'client cancelled')).toBe(true);

      const res = await getLegacyJob(
        new NextRequest(`https://easyconvert.app/api/queue/jobs/${job.id}?stream=true`),
        { params: { id: job.id } }
      );
      const events = await readSseEvents(res);
      expect(events).toHaveLength(1);
      expect(events[0].startsWith('event: initial')).toBe(true);
      const payload = JSON.parse(events[0].split('data: ')[1]);
      expect(payload.state).toBe('cancelled');
      expect(payload.error).toBe('client cancelled');
    });
  });

  describe('4. Conversion processor honours cancellation', () => {
    it('stores no result and refunds quota exactly once when an active conversion is cancelled', async () => {
      const { user, reservationId } = await createQuotaUser('pipeline_cancel');
      expect((await redisKeyStore.getQuotaUsage(user.id)).usedToday).toBe(1);

      const queue = new Queue<ConversionJobData, ConversionJobResult>('pipeline-cancel');
      attachJobCancellationListeners(queue);
      const rollbackSpy = vi.spyOn(redisKeyStore, 'rollbackQuota');
      const commitSpy = vi.spyOn(redisKeyStore, 'commitQuota');
      const saveSpy = vi.spyOn(s3Storage, 'saveObject');
      const objectsBefore = s3Storage.getObjectsCount();

      const job = await queue.add('convert', csvJobData({ userId: user.id, reservationId }), { attempts: 1 });

      // Pause the real pipeline right after the input is loaded and before convertFile runs.
      const reachedConversion = createGate();
      const resume = createGate();
      const originalUpdateProgress = job.updateProgress.bind(job);
      job.updateProgress = async (progress: number) => {
        await originalUpdateProgress(progress);
        if (progress === PIPELINE_INPUT_LOADED_PROGRESS) {
          reachedConversion.release();
          await resume.promise;
        }
      };

      const worker = new Worker(queue, processConversionJob, { concurrency: 1 });
      attachJobLifecycleListeners(worker);
      const completedEvents: unknown[] = [];
      worker.on('completed', (j) => completedEvents.push(j));

      await reachedConversion.promise;
      const drained = nextEvent(worker, 'drained');
      expect(await queue.cancelJob(job.id, 'client cancelled')).toBe(true);
      expect((await redisKeyStore.getQuotaUsage(user.id)).usedToday).toBe(0);

      resume.release();
      await drained;

      const final = await queue.getJob(job.id);
      expect(final?.state).toBe('cancelled');
      expect(final?.returnvalue).toBeUndefined();
      expect(completedEvents).toHaveLength(0);
      expect(commitSpy).not.toHaveBeenCalled();
      expect(rollbackSpy).toHaveBeenCalledTimes(1);
      expect(rollbackSpy).toHaveBeenCalledWith(reservationId);
      expect((await redisKeyStore.getQuotaUsage(user.id)).usedToday).toBe(0);

      const resultWrites = saveSpy.mock.calls.filter(([key]) => String(key).startsWith(`results/${job.id}/`));
      expect(resultWrites).toEqual([]);
      expect(s3Storage.getObjectsCount()).toBe(objectsBefore);

      await worker.close();
      await queue.close();
    });

    it('stops a multi-stage pipeline before its first stage when cancelled after the input loads', async () => {
      const queue = new Queue<ConversionJobData, ConversionJobResult>('pipeline-stage-cancel');
      const job = await queue.add(
        'convert',
        csvJobData({
          targetFormat: 'yaml',
          tasks: [
            { name: 'to-json', operation: 'convert', targetFormat: 'json' },
            { name: 'to-yaml', operation: 'convert', targetFormat: 'yaml' },
          ],
        }),
        { attempts: 1 }
      );
      const saveSpy = vi.spyOn(s3Storage, 'saveObject');

      const reachedPipeline = createGate();
      const resume = createGate();
      const originalUpdateProgress = job.updateProgress.bind(job);
      job.updateProgress = async (progress: number) => {
        await originalUpdateProgress(progress);
        if (progress === PIPELINE_INPUT_LOADED_PROGRESS) {
          reachedPipeline.release();
          await resume.promise;
        }
      };

      const worker = new Worker(queue, processConversionJob, { concurrency: 1 });
      await reachedPipeline.promise;
      const drained = nextEvent(worker, 'drained');
      expect(await queue.cancelJob(job.id, 'stop the chain')).toBe(true);
      resume.release();
      await drained;

      expect((await queue.getJob(job.id))?.state).toBe('cancelled');
      expect(job.logs.some((line) => line.includes('Executing 2-stage pipeline chaining'))).toBe(true);
      expect(job.logs.some((line) => line.includes('[Stage 1/2]'))).toBe(false);
      expect(saveSpy.mock.calls.filter(([key]) => String(key).startsWith(`results/${job.id}/`))).toEqual([]);

      await worker.close();
      await queue.close();
    });

    it('never lets a timed-out attempt that outlived its timeout store a result after the retry', async () => {
      const queue = new Queue<ConversionJobData, ConversionJobResult>('stale-attempt');
      const job = await queue.add('convert', csvJobData(), {
        attempts: 2,
        backoff: { type: 'fixed', delay: 5 },
        timeout: 50,
      });
      const saveSpy = vi.spyOn(s3Storage, 'saveObject');

      // Hold only the first attempt past its 50ms timeout, right before convertFile.
      const releaseFirstAttempt = createGate();
      let heldFirstAttempt = false;
      const originalUpdateProgress = job.updateProgress.bind(job);
      job.updateProgress = async (progress: number) => {
        await originalUpdateProgress(progress);
        if (progress === PIPELINE_INPUT_LOADED_PROGRESS && !heldFirstAttempt) {
          heldFirstAttempt = true;
          await releaseFirstAttempt.promise;
        }
      };

      const attempts: Promise<ConversionJobResult>[] = [];
      const worker = new Worker(
        queue,
        (j) => {
          const attempt = processConversionJob(j);
          attempts.push(attempt);
          return attempt;
        },
        { concurrency: 1 }
      );
      const completed = nextEvent(worker, 'completed');
      await completed;

      releaseFirstAttempt.release();
      const outcomes = await Promise.allSettled(attempts);
      expect(outcomes.map((o) => o.status)).toEqual(['rejected', 'fulfilled']);
      expect((outcomes[0] as PromiseRejectedResult).reason).toBeInstanceOf(JobTimeoutError);

      const resultWrites = saveSpy.mock.calls.filter(([key]) => String(key).startsWith(`results/${job.id}/`));
      expect(resultWrites).toHaveLength(1);
      const final = await queue.getJob(job.id);
      expect(final?.state).toBe('completed');
      expect(final?.attemptsMade).toBe(2);

      await worker.close();
      await queue.close();
    });
  });

  describe('5. DELETE /api/queue/jobs/{id} cancels through the engine', () => {
    it('cancels a waiting job in the engine, removes it from the waiting list, and refunds quota once', async () => {
      const { user, reservationId } = await createQuotaUser('legacy_delete');
      const rollbackSpy = vi.spyOn(redisKeyStore, 'rollbackQuota');
      const job = await conversionQueue.add('convert', csvJobData({ userId: user.id, reservationId }));

      const res = await deleteLegacyJob(
        new NextRequest(`https://easyconvert.app/api/queue/jobs/${job.id}`, { method: 'DELETE' }),
        { params: { id: job.id } }
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);

      const engineJob = await conversionQueue.getJob(job.id);
      expect(engineJob?.state).toBe('cancelled');
      expect(engineJob?.failedReason).toBe('Job was cancelled by client request.');
      expect((await conversionQueue.getJobs(['waiting'])).map((j) => j.id)).not.toContain(job.id);
      expect((await conversionQueue.getJobs(['cancelled'])).map((j) => j.id)).toContain(job.id);

      expect(rollbackSpy).toHaveBeenCalledTimes(1);
      expect(rollbackSpy).toHaveBeenCalledWith(reservationId);
      expect((await redisKeyStore.getQuotaUsage(user.id)).usedToday).toBe(0);
    });

    it('returns 409 for a job that already completed and leaves it completed', async () => {
      const worker = new Worker(
        conversionQueue,
        async (job) => ({
          jobId: job.id,
          status: 'completed' as const,
          resultKey: `results/${job.id}/scores.json`,
          downloadUrl: `/api/storage/file/results%2F${job.id}%2Fscores.json`,
          filename: 'scores.json',
          mimeType: 'application/json',
          size: 2,
          durationMs: 1,
        }),
        { concurrency: 1 }
      );
      const completed = nextEvent(worker, 'completed');
      const job = await conversionQueue.add('convert', csvJobData());
      await completed;
      await worker.close();

      const res = await deleteLegacyJob(
        new NextRequest(`https://easyconvert.app/api/queue/jobs/${job.id}`, { method: 'DELETE' }),
        { params: { id: job.id } }
      );
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toContain('completed');
      expect((await conversionQueue.getJob(job.id))?.state).toBe('completed');
    });

    it('returns 404 for an unknown job id', async () => {
      const res = await deleteLegacyJob(
        new NextRequest('https://easyconvert.app/api/queue/jobs/job_unknown', { method: 'DELETE' }),
        { params: { id: 'job_unknown' } }
      );
      expect(res.status).toBe(404);
    });

    it('emits a cancelled event and closes a live SSE stream when the job is cancelled', async () => {
      const job = await conversionQueue.add('convert', csvJobData());
      const res = await getLegacyJob(
        new NextRequest(`https://easyconvert.app/api/queue/jobs/${job.id}?stream=true`),
        { params: { id: job.id } }
      );
      const eventsPromise = readSseEvents(res);

      const cancelRes = await deleteLegacyJob(
        new NextRequest(`https://easyconvert.app/api/queue/jobs/${job.id}`, { method: 'DELETE' }),
        { params: { id: job.id } }
      );
      expect(cancelRes.status).toBe(200);

      const events = await eventsPromise;
      expect(events).toHaveLength(2);
      expect(events[0].startsWith('event: initial')).toBe(true);
      expect(events[1].startsWith('event: cancelled')).toBe(true);
      const payload = JSON.parse(events[1].split('data: ')[1]);
      expect(payload).toEqual({
        jobId: job.id,
        state: 'cancelled',
        error: 'Job was cancelled by client request.',
      });
    }, 5000);
  });
});
