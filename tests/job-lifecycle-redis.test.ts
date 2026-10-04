import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import Redis from 'ioredis';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DistributedBullMQAdapter,
  Worker,
  JobCancelledError,
  JobOwnershipLostError,
  HEARTBEAT_INTERVAL_MS,
  STALL_TIMEOUT_MS,
  STALLED_SWEEP_INTERVAL_MS,
  COMPLETE_JOB_LUA_SCRIPT,
  COMPLETION_COMMIT_MAX_ATTEMPTS,
} from '../src/lib/queue/bullmq-engine';
import {
  processConversionJob,
  attachJobLifecycleListeners,
  attachInputCleanupOnCompletion,
} from '../src/lib/queue/conversion-queue';
import { s3Storage } from '../src/lib/storage/s3-storage';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';

/**
 * Redis-mode lifecycle guarantees need a real Redis server: the transitions are Lua scripts,
 * and an in-process mock cannot execute Lua. These suites run only when REDIS_URL is set
 * (for example `docker run -p 6379:6379 redis:7-alpine` and `REDIS_URL=redis://127.0.0.1:6379`).
 */
const REDIS_URL = process.env.REDIS_URL;
const STALLED_REASON = 'Job stalled: worker heartbeat lost';
const CSV_INPUT = 'name,score\nAlice,100\nBob,95\n';

interface Payload {
  payload: string;
}

function nextEvent(emitter: EventEmitter, event: string): Promise<unknown[]> {
  return new Promise((resolve) => {
    emitter.once(event, (...args: unknown[]) => resolve(args));
  });
}

function createGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe.skipIf(!REDIS_URL)('Job lifecycle safety on a real Redis server', () => {
  let keyPrefix: string;
  let admin: Redis;
  const adapters: DistributedBullMQAdapter<any, any>[] = [];

  function connect<T = Payload, R = string>(queueName: string): DistributedBullMQAdapter<T, R> {
    const client = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
    const adapter = new DistributedBullMQAdapter<T, R>(queueName, { redisClient: client, keyPrefix });
    adapters.push(adapter);
    return adapter;
  }

  /**
   * Makes the adapter's completion script fail as a dropped connection would. `mode` decides
   * whether the script runs on the server before the reply is lost.
   */
  function injectCompletionFailures(
    adapter: DistributedBullMQAdapter<any, any>,
    plan: { failures: () => boolean; runBeforeFailing?: boolean }
  ): { commitCalls: () => number } {
    const client = adapter.getRedisClient() as Redis;
    const realEval = client.eval.bind(client) as (...args: unknown[]) => Promise<unknown>;
    let calls = 0;
    vi.spyOn(client, 'eval').mockImplementation((async (...args: unknown[]) => {
      if (args[0] !== COMPLETE_JOB_LUA_SCRIPT) {
        return realEval(...args);
      }
      calls++;
      if (!plan.failures()) {
        return realEval(...args);
      }
      if (plan.runBeforeFailing) {
        await realEval(...args);
      }
      throw new Error('Connection is closed.');
    }) as never);
    return { commitCalls: () => calls };
  }

  function keyOf(queueName: string, suffix: string): string {
    return `${keyPrefix}{${queueName}}:${suffix}`;
  }

  async function getWaitingIds(queueName: string): Promise<string[]> {
    const key = keyOf(queueName, 'waiting');
    const t = await admin.type(key);
    return t === 'zset' ? admin.zrange(key, 0, -1) : admin.lrange(key, 0, -1);
  }

  beforeEach(() => {
    keyPrefix = `lifecycle-test-${crypto.randomBytes(6).toString('hex')}:`;
    admin = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    while (adapters.length > 0) {
      await adapters.pop()!.close();
    }
    const keys = await admin.keys(`${keyPrefix}*`);
    if (keys.length > 0) {
      await admin.del(...keys);
    }
    await admin.quit();
  });

  describe('1. Atomic cancel versus worker transitions', () => {
    it('lets a concurrent cancel win over a late completion', async () => {
      const api = connect('cas-complete');
      const workerSide = connect('cas-complete');
      const job = await api.add('convert', { payload: 'x' });

      const popped = await workerSide._popNextWaiting();
      expect(popped?.id).toBe(job.id);
      expect(popped?.state).toBe('active');

      expect(await api.cancelJob(job.id, 'client cancelled')).toBe(true);
      expect(await workerSide._onJobCompleted(popped!, 'late result')).toBe(false);

      const stored = await api.getJob(job.id);
      expect(stored?.state).toBe('cancelled');
      expect(stored?.failedReason).toBe('client cancelled');
      expect(stored?.returnvalue).toBeUndefined();
      expect(stored?.logs.some((line) => line.endsWith('Job cancelled: client cancelled'))).toBe(true);

      expect(await api.getJobCounts()).toMatchObject({ active: 0, completed: 0, cancelled: 1 });
      expect(await admin.sismember(keyOf('cas-complete', 'completed'), job.id)).toBe(0);
      expect(await admin.exists(keyOf('cas-complete', `heartbeat:${job.id}`))).toBe(0);
    });

    it('refuses failure and retry transitions after a cancel', async () => {
      const api = connect('cas-fail');
      const workerSide = connect('cas-fail');
      const job = await api.add('convert', { payload: 'x' }, { attempts: 3 });
      const popped = await workerSide._popNextWaiting();
      expect(popped?.id).toBe(job.id);

      expect(await api.cancelJob(job.id, 'client cancelled')).toBe(true);

      popped!.attemptsMade = 1;
      popped!.failedReason = 'engine crashed';
      expect(await workerSide._requeue(popped!, 0)).toBe(false);
      expect(await workerSide._requeue(popped!, 1000)).toBe(false);
      expect(await workerSide._onJobFailed(popped!, new Error('engine crashed'))).toBe(false);

      const stored = await api.getJob(job.id);
      expect(stored?.state).toBe('cancelled');
      expect(stored?.failedReason).toBe('client cancelled');
      expect(await api.getJobCounts()).toMatchObject({
        waiting: 0,
        delayed: 0,
        active: 0,
        failed: 0,
        cancelled: 1,
      });
    });

    it('refuses a cancel once the completion has been committed', async () => {
      const api = connect('cas-cancel-late');
      const workerSide = connect('cas-cancel-late');
      const job = await api.add('convert', { payload: 'x' });
      const popped = await workerSide._popNextWaiting();
      popped!.attemptsMade = 1;

      expect(await workerSide._onJobCompleted(popped!, 'final result')).toBe(true);
      expect(await api.cancelJob(job.id, 'too late')).toBe(false);

      const stored = await api.getJob(job.id);
      expect(stored?.state).toBe('completed');
      expect(stored?.returnvalue).toBe('final result');
      expect(stored?.attemptsMade).toBe(1);
      expect(await api.getJobCounts()).toMatchObject({ completed: 1, cancelled: 0, active: 0 });
    });

    it('removes cancelled waiting and delayed jobs from their lists so no worker can pop them', async () => {
      const api = connect('cancel-queued');
      const waiting = await api.add('convert', { payload: 'waiting' });
      const delayed = await api.add('convert', { payload: 'delayed' }, { delay: 1 });

      expect(await api.cancelJob(waiting.id, 'drop waiting')).toBe(true);
      expect(await api.cancelJob(delayed.id, 'drop delayed')).toBe(true);
      expect(await api.cancelJob(waiting.id, 'again')).toBe(false);

      expect(await getWaitingIds('cancel-queued')).toEqual([]);
      expect(await admin.zrange(keyOf('cancel-queued', 'delayed'), 0, '-1')).toEqual([]);
      expect((await admin.smembers(keyOf('cancel-queued', 'cancelled'))).sort()).toEqual(
        [waiting.id, delayed.id].sort()
      );

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(await api._popNextWaiting()).toBeUndefined();
      expect((await api.getJobs(['cancelled'])).map((j) => j.id).sort()).toEqual([waiting.id, delayed.id].sort());
    });

    it('emits exactly one local cancelled event, from the process that won the transition', async () => {
      const api = connect('cancel-event');
      const other = connect('cancel-event');
      const apiEvents: string[] = [];
      const otherEvents: string[] = [];
      api.on('cancelled', (job: { id: string; data: Payload }) => apiEvents.push(`${job.id}:${job.data.payload}`));
      other.on('cancelled', (job: { id: string }) => otherEvents.push(job.id));

      const job = await api.add('convert', { payload: 'refundable' });
      const [first, second] = await Promise.all([
        api.cancelJob(job.id, 'client cancelled'),
        other.cancelJob(job.id, 'client cancelled'),
      ]);

      expect([first, second].filter(Boolean)).toHaveLength(1);
      expect(apiEvents.length + otherEvents.length).toBe(1);
      if (first) {
        expect(apiEvents).toEqual([`${job.id}:refundable`]);
      } else {
        expect(otherEvents).toEqual([job.id]);
      }
    });
  });

  describe('2. Cross-process abort of a running job', () => {
    it('aborts the worker-side signal and never records a completion', async () => {
      const api = connect('cross-process');
      const workerSide = connect('cross-process');
      const started = createGate();
      let observedReason: unknown;

      const worker = new Worker(
        workerSide,
        async (job) => {
          started.release();
          await new Promise<void>((resolve) => {
            job.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          observedReason = job.signal.reason;
          return 'result produced after abort';
        },
        { concurrency: 1 }
      );
      const completedEvents: unknown[] = [];
      worker.on('completed', (j) => completedEvents.push(j));

      const job = await api.add('convert', { payload: 'long' });
      await started.promise;
      expect((await api.getJob(job.id))?.state).toBe('active');

      const drained = nextEvent(worker, 'drained');
      expect(await api.cancelJob(job.id, 'client cancelled')).toBe(true);
      await drained;

      expect(observedReason).toBeInstanceOf(JobCancelledError);
      expect((observedReason as Error).message).toBe('client cancelled');
      expect(completedEvents).toHaveLength(0);

      const stored = await api.getJob(job.id);
      expect(stored?.state).toBe('cancelled');
      expect(stored?.returnvalue).toBeUndefined();
      expect(await api.getJobCounts()).toMatchObject({ active: 0, completed: 0, cancelled: 1 });

      await worker.close();
    }, 10000);
  });

  describe('3. Heartbeat and stalled-job recovery', () => {
    it('keeps a job with a live heartbeat, requeues it once the heartbeat is lost, then fails it into the DLQ', async () => {
      const queue = connect('stalled');
      const job = await queue.add('convert', { payload: 'crash-prone' }, { attempts: 2 });
      const heartbeatKey = keyOf('stalled', `heartbeat:${job.id}`);

      const firstAttempt = await queue._popNextWaiting();
      expect(firstAttempt?.id).toBe(job.id);
      const ttl = await admin.pttl(heartbeatKey);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(STALL_TIMEOUT_MS);

      expect(await queue._recoverStalledJobs()).toEqual([]);
      expect((await queue.getJob(job.id))?.state).toBe('active');

      // The worker process died: its heartbeat key expired.
      await admin.del(heartbeatKey);
      expect(await queue._recoverStalledJobs()).toEqual([]);

      const requeued = await queue.getJob(job.id);
      expect(requeued?.state).toBe('waiting');
      expect(requeued?.attemptsMade).toBe(1);
      expect(requeued?.failedReason).toBe(STALLED_REASON);
      expect(await getWaitingIds('stalled')).toEqual([job.id]);
      expect(await admin.sismember(keyOf('stalled', 'active'), job.id)).toBe(0);

      const secondAttempt = await queue._popNextWaiting();
      expect(secondAttempt?.id).toBe(job.id);
      await admin.del(heartbeatKey);
      const failedJobs = await queue._recoverStalledJobs();
      expect(failedJobs.map((j) => j.id)).toEqual([job.id]);

      const failed = await queue.getJob(job.id);
      expect(failed?.state).toBe('failed');
      expect(failed?.attemptsMade).toBe(2);
      expect(failed?.failedReason).toBe(STALLED_REASON);
      expect(await queue.getJobCounts()).toMatchObject({ waiting: 0, active: 0, failed: 1 });

      const dlq = await queue.getDlqEntries();
      expect(dlq).toHaveLength(1);
      expect(dlq[0]).toMatchObject({
        jobId: job.id,
        name: 'convert',
        data: { payload: 'crash-prone' },
        failedReason: STALLED_REASON,
        attemptsMade: 2,
      });
    });

    it('does not recover a stalled id twice when two sweepers race', async () => {
      const sweeperA = connect('stalled-race');
      const sweeperB = connect('stalled-race');
      const job = await sweeperA.add('convert', { payload: 'once' }, { attempts: 1 });
      await sweeperA._popNextWaiting();
      await admin.del(keyOf('stalled-race', `heartbeat:${job.id}`));

      const [a, b] = await Promise.all([sweeperA._recoverStalledJobs(), sweeperB._recoverStalledJobs()]);
      expect([...a, ...b].map((j) => j.id)).toEqual([job.id]);
      expect(await sweeperA.getDlqEntries()).toHaveLength(1);
    });

    it('runs the stalled sweep from the worker and emits failed for exhausted jobs', async () => {
      const deadWorkerSide = connect('stalled-worker');
      const job = await deadWorkerSide.add('convert', { payload: 'orphaned' }, { attempts: 1 });
      await deadWorkerSide._popNextWaiting();
      await admin.del(keyOf('stalled-worker', `heartbeat:${job.id}`));

      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const liveWorkerSide = connect('stalled-worker');
      const worker = new Worker(liveWorkerSide, async () => 'never runs', { concurrency: 1 });
      const failed = nextEvent(worker, 'failed');

      await vi.advanceTimersByTimeAsync(STALLED_SWEEP_INTERVAL_MS);
      const [failedJob, err] = (await failed) as [{ id: string; state: string }, Error];

      expect(failedJob.id).toBe(job.id);
      expect(failedJob.state).toBe('failed');
      expect(err.message).toBe(STALLED_REASON);

      await worker.close();
    });
  });

  describe('4. Attempt ownership fencing after stalled recovery', () => {
    it('rejects every write from a stale attempt once a new attempt owns the job', async () => {
      const staleSide = connect('fencing');
      const freshSide = connect('fencing');
      const job = await staleSide.add('convert', { payload: 'contended' }, { attempts: 3 });
      const jobKey = keyOf('fencing', `job:${job.id}`);
      const heartbeatKey = keyOf('fencing', `heartbeat:${job.id}`);

      const staleAttempt = await staleSide._popNextWaiting();
      expect(staleAttempt?.id).toBe(job.id);
      staleAttempt!.attemptsMade = 1;

      // The stale worker stops heartbeating (blocked event loop), so the sweep hands the job on.
      await admin.del(heartbeatKey);
      expect(await freshSide._recoverStalledJobs()).toEqual([]);
      const freshAttempt = await freshSide._popNextWaiting();
      expect(freshAttempt?.id).toBe(job.id);
      expect(freshAttempt?.attemptsMade).toBe(1);

      const hashBefore = await admin.hgetall(jobKey);
      const heartbeatBefore = await admin.get(heartbeatKey);
      expect(hashBefore.state).toBe('active');

      staleAttempt!.failedReason = 'stale attempt failure';
      expect(await staleSide._onJobCompleted(staleAttempt!, 'stale result')).toBe(false);
      expect(await staleSide._onJobFailed(staleAttempt!, new Error('stale attempt failure'))).toBe(false);
      expect(await staleSide._requeue(staleAttempt!, 0)).toBe(false);
      expect(await staleSide._requeue(staleAttempt!, 1000)).toBe(false);
      await staleAttempt!.updateProgress(99);
      await staleAttempt!.log('stale attempt log line');

      expect(await admin.hgetall(jobKey)).toEqual(hashBefore);
      expect(await admin.get(heartbeatKey)).toBe(heartbeatBefore);
      expect(await getWaitingIds('fencing')).toEqual([]);
      expect(await admin.zrange(keyOf('fencing', 'delayed'), 0, '-1')).toEqual([]);
      expect(await freshSide.getDlqEntries()).toEqual([]);
      expect(await freshSide.getJobCounts()).toMatchObject({ active: 1, completed: 0, failed: 0 });

      // The stale attempt's heartbeat refresh is refused and aborts its signal.
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const stopMonitoring = staleSide._monitorActiveJob(staleAttempt!);
      const aborted = new Promise<void>((resolve) => {
        staleAttempt!.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
      await aborted;
      stopMonitoring();
      expect(staleAttempt!.signal.reason).toBeInstanceOf(JobOwnershipLostError);
      expect(await admin.get(heartbeatKey)).toBe(heartbeatBefore);
      expect(await admin.hgetall(jobKey)).toEqual(hashBefore);

      // The owning attempt still completes normally.
      freshAttempt!.attemptsMade = 2;
      expect(await freshSide._onJobCompleted(freshAttempt!, 'fresh result')).toBe(true);
      const completed = await freshSide.getJob(job.id);
      expect(completed?.state).toBe('completed');
      expect(completed?.returnvalue).toBe('fresh result');
      expect(completed?.attemptsMade).toBe(2);
      expect(await freshSide.getJobCounts()).toMatchObject({ active: 0, completed: 1, failed: 0 });
    });

    it('stops a worker whose attempt lost ownership without recording anything', async () => {
      const staleSide = connect('fencing-worker');
      const freshSide = connect('fencing-worker');
      const job = await freshSide.add('convert', { payload: 'contended' }, { attempts: 3 });
      const heartbeatKey = keyOf('fencing-worker', `heartbeat:${job.id}`);
      const completeSpy = vi.spyOn(staleSide, '_onJobCompleted');
      const failSpy = vi.spyOn(staleSide, '_onJobFailed');
      const requeueSpy = vi.spyOn(staleSide, '_requeue');

      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const started = createGate();
      let observedReason: unknown;
      const worker = new Worker(
        staleSide,
        async (attempt) => {
          started.release();
          await new Promise<void>((resolve) => {
            attempt.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          observedReason = attempt.signal.reason;
          return 'stale result';
        },
        { concurrency: 1 }
      );
      const workerEvents: string[] = [];
      worker.on('completed', () => workerEvents.push('completed'));
      worker.on('failed', () => workerEvents.push('failed'));
      await started.promise;

      await admin.del(heartbeatKey);
      expect(await freshSide._recoverStalledJobs()).toEqual([]);
      const freshAttempt = await freshSide._popNextWaiting();
      expect(freshAttempt?.id).toBe(job.id);

      const drained = nextEvent(worker, 'drained');
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
      await drained;

      expect(observedReason).toBeInstanceOf(JobOwnershipLostError);
      expect(workerEvents).toEqual([]);
      expect(completeSpy).not.toHaveBeenCalled();
      expect(failSpy).not.toHaveBeenCalled();
      expect(requeueSpy).not.toHaveBeenCalled();

      const owned = await freshSide.getJob(job.id);
      expect(owned?.state).toBe('active');
      expect(owned?.attemptsMade).toBe(1);

      freshAttempt!.attemptsMade = 2;
      expect(await freshSide._onJobCompleted(freshAttempt!, 'fresh result')).toBe(true);
      expect((await freshSide.getJob(job.id))?.returnvalue).toBe('fresh result');

      await worker.close();
    });
  });

  describe('5. Recording a completion through transient Redis errors', () => {
    it('retries the completion commit after a transient Redis error', async () => {
      const queue = connect('commit-retry');
      const job = await queue.add('convert', { payload: 'x' });
      const attempt = await queue._popNextWaiting();
      attempt!.attemptsMade = 1;
      let remainingFailures = 1;
      const injected = injectCompletionFailures(queue, { failures: () => remainingFailures-- > 0 });
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      expect(await queue._onJobCompleted(attempt!, 'converted')).toBe(true);

      expect(injected.commitCalls()).toBe(2);
      const stored = await queue.getJob(job.id);
      expect(stored?.state).toBe('completed');
      expect(stored?.returnvalue).toBe('converted');
    });

    it('treats a retried commit whose first reply was lost as recorded', async () => {
      const queue = connect('commit-lost-reply');
      const job = await queue.add('convert', { payload: 'x' });
      const attempt = await queue._popNextWaiting();
      attempt!.attemptsMade = 1;
      let remainingFailures = 1;
      const injected = injectCompletionFailures(queue, {
        failures: () => remainingFailures-- > 0,
        runBeforeFailing: true,
      });
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      expect(await queue._onJobCompleted(attempt!, 'converted')).toBe(true);

      expect(injected.commitCalls()).toBe(2);
      expect((await queue.getJob(job.id))?.state).toBe('completed');
      expect(await queue.getJobCounts()).toMatchObject({ active: 0, completed: 1 });
    });

    it('keeps the input when the completion cannot be recorded, so the recovered job reconverts', async () => {
      const queue = connect<ConversionJobData, ConversionJobResult>('commit-failure');
      const inputKey = `uploads/commit-failure-${crypto.randomBytes(6).toString('hex')}.csv`;
      s3Storage.saveObject(inputKey, Buffer.from(CSV_INPUT, 'utf-8'), 'text/csv', 'scores.csv');
      const job = await queue.add(
        'convert',
        {
          jobId: 'commit-failure',
          originalFilename: 'scores.csv',
          sourceFormat: 'csv',
          targetFormat: 'json',
          fileSize: CSV_INPUT.length,
          options: {},
          storageKey: inputKey,
        },
        { attempts: 2 }
      );
      let redisDown = true;
      const injected = injectCompletionFailures(queue, { failures: () => redisDown });
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const worker = new Worker(queue, processConversionJob, { concurrency: 1 });
      attachJobLifecycleListeners(worker);
      attachInputCleanupOnCompletion(worker);
      const completedEvents: unknown[] = [];
      worker.on('completed', (j) => completedEvents.push(j));
      const firstAttemptDone = nextEvent(worker, 'drained');
      await firstAttemptDone;

      expect(injected.commitCalls()).toBe(COMPLETION_COMMIT_MAX_ATTEMPTS);
      expect((await queue.getJob(job.id))?.state).toBe('active');
      expect(completedEvents).toHaveLength(0);
      expect(s3Storage.getObject(inputKey)?.buffer.toString('utf-8')).toBe(CSV_INPUT);

      // Redis recovers; the attempt's heartbeat expires and the sweep hands the job to a new attempt.
      redisDown = false;
      await admin.del(keyOf('commit-failure', `heartbeat:${job.id}`));
      const completed = nextEvent(worker, 'completed');
      expect(await queue._recoverStalledJobs()).toEqual([]);
      const [, result] = (await completed) as [unknown, ConversionJobResult];

      expect(JSON.parse(s3Storage.getObject(result.resultKey)!.buffer.toString('utf-8'))).toEqual([
        // CSV cells are untyped text, so the JSON rows keep them as strings.
        { name: 'Alice', score: '100' },
        { name: 'Bob', score: '95' },
      ]);
      const recorded = await queue.getJob(job.id);
      expect(recorded?.state).toBe('completed');
      expect(recorded?.attemptsMade).toBe(2);
      expect(s3Storage.getObject(inputKey)).toBeUndefined();

      await worker.close();
    }, 10000);
  });
});
