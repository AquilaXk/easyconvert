import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import Redis from 'ioredis';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DistributedBullMQAdapter,
  Worker,
  JobCancelledError,
  STALL_TIMEOUT_MS,
  STALLED_SWEEP_INTERVAL_MS,
} from '../src/lib/queue/bullmq-engine';

/**
 * Redis-mode lifecycle guarantees need a real Redis server: the transitions are Lua scripts,
 * and an in-process mock cannot execute Lua. These suites run only when REDIS_URL is set
 * (for example `docker run -p 6379:6379 redis:7-alpine` and `REDIS_URL=redis://127.0.0.1:6379`).
 */
const REDIS_URL = process.env.REDIS_URL;
const STALLED_REASON = 'Job stalled: worker heartbeat lost';

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
  const adapters: DistributedBullMQAdapter<Payload, string>[] = [];

  function connect(queueName: string): DistributedBullMQAdapter<Payload, string> {
    const client = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
    const adapter = new DistributedBullMQAdapter<Payload, string>(queueName, { redisClient: client, keyPrefix });
    adapters.push(adapter);
    return adapter;
  }

  function keyOf(queueName: string, suffix: string): string {
    return `${keyPrefix}{${queueName}}:${suffix}`;
  }

  beforeEach(() => {
    keyPrefix = `lifecycle-test-${crypto.randomBytes(6).toString('hex')}:`;
    admin = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
  });

  afterEach(async () => {
    vi.useRealTimers();
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

      expect(await admin.lrange(keyOf('cancel-queued', 'waiting'), 0, -1)).toEqual([]);
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
      expect(await admin.lrange(keyOf('stalled', 'waiting'), 0, -1)).toEqual([job.id]);
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
});
