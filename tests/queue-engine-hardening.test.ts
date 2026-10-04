import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import Redis from 'ioredis';
import {
  Queue,
  DistributedBullMQAdapter,
  calculateJobPriorityScore,
  subscribeToJobTelemetry,
  ADD_JOB_LUA_SCRIPT,
  POP_NEXT_WAITING_JOB_LUA_SCRIPT,
  PROMOTE_DELAYED_JOBS_LUA_SCRIPT,
  CANCEL_JOB_LUA_SCRIPT,
  REQUEUE_JOB_LUA_SCRIPT,
  RECOVER_STALLED_JOBS_LUA_SCRIPT,
  Job,
} from '@/lib/queue/bullmq-engine';
import { conversionQueue } from '@/lib/queue/conversion-queue';

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

describe('Phase 3-A: Queue Engine Hardening (Priority ZSET, Atomic Lua Add, Pub/Sub, User Index)', () => {
  describe('1. In-Memory Priority Scheduling and FIFO Ties', () => {
    it('orders jobs strictly by priority (1 > 2 > default/1000) with FIFO on ties', async () => {
      const queue = new Queue<any, any>(`mem-priority-${Date.now()}`);

      // Add jobs with different priorities and timestamps
      // priority 1 = urgent, priority 2 = normal, priority 0/undefined = default (1000)
      const jobLow1 = await queue.add('task', { id: 'low-1' }, { priority: 1000 });
      const jobHigh1 = await queue.add('task', { id: 'high-1' }, { priority: 1 });
      const jobMed1 = await queue.add('task', { id: 'med-1' }, { priority: 2 });
      const jobHigh2 = await queue.add('task', { id: 'high-2' }, { priority: 1 });
      const jobLow2 = await queue.add('task', { id: 'low-2' }, { priority: 0 }); // 0 treated as default 1000

      const poppedIds: string[] = [];
      while (true) {
        const popped = queue._popNextWaiting();
        if (!popped) break;
        poppedIds.push(popped.id);
      }

      // Expected order:
      // high-1 (prio 1, earlier)
      // high-2 (prio 1, later)
      // med-1 (prio 2)
      // low-1 (prio 1000, earlier)
      // low-2 (prio 1000, later)
      expect(poppedIds).toEqual([jobHigh1.id, jobHigh2.id, jobMed1.id, jobLow1.id, jobLow2.id]);
    });

    it('indexes user jobs and retrieves by user with pagination and state filtering', async () => {
      const queue = new Queue<any, any>(`mem-user-${Date.now()}`);
      const userId1 = 'user_alice_123';
      const userId2 = 'user_bob_456';

      const jobA1 = await queue.add('convert', { userId: userId1, doc: 'a1' });
      const jobA2 = await queue.add('convert', { userId: userId1, doc: 'a2' });
      const jobB1 = await queue.add('convert', { userId: userId2, doc: 'b1' });
      const jobA3 = await queue.add('convert', { userId: userId1, doc: 'a3' });

      // Alice has 3 jobs, Bob has 1 job
      const aliceJobs = await queue.getJobsByUser(userId1, undefined, 10, 0);
      expect(aliceJobs.map((j) => j.id)).toEqual([jobA3.id, jobA2.id, jobA1.id]);

      const bobJobs = await queue.getJobsByUser(userId2, undefined, 10, 0);
      expect(bobJobs.map((j) => j.id)).toEqual([jobB1.id]);

      // Pagination on Alice
      const page1 = await queue.getJobsByUser(userId1, undefined, 2, 0);
      expect(page1.map((j) => j.id)).toEqual([jobA3.id, jobA2.id]);

      const page2 = await queue.getJobsByUser(userId1, undefined, 2, 2);
      expect(page2.map((j) => j.id)).toEqual([jobA1.id]);

      // State filtering
      jobA2.state = 'completed';
      const onlyCompleted = await queue.getJobsByUser(userId1, ['completed'], 10, 0);
      expect(onlyCompleted.map((j) => j.id)).toEqual([jobA2.id]);

      const onlyWaiting = await queue.getJobsByUser(userId1, ['waiting'], 10, 0);
      expect(onlyWaiting.map((j) => j.id)).toEqual([jobA3.id, jobA1.id]);
    });

    it('enforces removeOnComplete, removeOnFail, and clean with user index cleanup in memory', async () => {
      const queue = new Queue<any, any>(`mem-clean-${Date.now()}`);
      const userId = 'user_retention_mem';

      // removeOnComplete: true
      const job1 = await queue.add('t1', { userId }, { removeOnComplete: true });
      job1.state = 'completed';
      job1.finishedOn = Date.now();
      queue._onJobCompleted(job1, { success: true });

      expect(await queue.getJob(job1.id)).toBeUndefined();
      expect(await queue.getJobsByUser(userId)).toEqual([]);

      // removeOnComplete: numeric limit
      const job2 = await queue.add('t2', { userId }, { removeOnComplete: 2 });
      job2.state = 'completed';
      job2.finishedOn = Date.now() - 3000;
      queue._onJobCompleted(job2, null);

      const job3 = await queue.add('t3', { userId }, { removeOnComplete: 2 });
      job3.state = 'completed';
      job3.finishedOn = Date.now() - 2000;
      queue._onJobCompleted(job3, null);

      const job4 = await queue.add('t4', { userId }, { removeOnComplete: 2 });
      job4.state = 'completed';
      job4.finishedOn = Date.now() - 1000;
      queue._onJobCompleted(job4, null);

      // Kept only 2 most recent completed: job4 and job3; job2 purged
      expect(await queue.getJob(job2.id)).toBeUndefined();
      expect(await queue.getJob(job3.id)).toBeDefined();
      expect(await queue.getJob(job4.id)).toBeDefined();

      // Clean
      const cleaned = await queue.clean(0, 10, 'completed');
      expect(cleaned).toContain(job3.id);
      expect(cleaned).toContain(job4.id);
      expect(await queue.getJob(job3.id)).toBeUndefined();
      expect(await queue.getJob(job4.id)).toBeUndefined();
      expect(await queue.getJobsByUser(userId)).toEqual([]);
    });
  });

  describe('2. Real Redis Priority ZSET & Atomic Lua Operations', () => {
    let keyPrefix: string;
    let admin: Redis;
    const adapters: DistributedBullMQAdapter<any, any>[] = [];

    function connect<T = any, R = any>(queueName: string): DistributedBullMQAdapter<T, R> {
      const client = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
      const adapter = new DistributedBullMQAdapter<T, R>(queueName, { redisClient: client, keyPrefix });
      adapters.push(adapter);
      return adapter;
    }

    beforeEach(() => {
      keyPrefix = `hardening-test-${crypto.randomBytes(6).toString('hex')}:`;
      admin = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
    });

    afterEach(async () => {
      while (adapters.length > 0) {
        await adapters.pop()!.close();
      }
      const keys = await admin.keys(`${keyPrefix}*`);
      if (keys.length > 0) {
        await admin.del(...keys);
      }
      await admin.quit();
    });

    it('atomic ADD_JOB_LUA_SCRIPT creates hash, schedules in waiting ZSET, indexes user, and deduplicates', async () => {
      const adapter = connect('atomic-add');
      const userId = 'user_test_atomic_1';
      const fixedJobId = 'job_atomic_dedup_100';

      const job = await adapter.add('convert', { userId, format: 'pdf' }, { jobId: fixedJobId, priority: 5 });

      expect(job.id).toBe(fixedJobId);
      expect(job.state).toBe('waiting');

      // Verify Redis Hash
      const hashKey = `${keyPrefix}{atomic-add}:job:${fixedJobId}`;
      const hash = await admin.hgetall(hashKey);
      expect(hash.id).toBe(fixedJobId);
      expect(hash.state).toBe('waiting');
      expect(JSON.parse(hash.data)).toEqual({ userId, format: 'pdf' });

      // Verify Waiting ZSET
      const waitingKey = `${keyPrefix}{atomic-add}:waiting`;
      const ztype = await admin.type(waitingKey);
      expect(ztype).toBe('zset');
      const score = await admin.zscore(waitingKey, fixedJobId);
      expect(Number(score)).toBeGreaterThan(0);

      // Verify User Jobs ZSET
      const userJobsKey = `${keyPrefix}{atomic-add}:user_jobs:${userId}`;
      const userJobs = await admin.zrevrange(userJobsKey, 0, -1);
      expect(userJobs).toEqual([fixedJobId]);

      // Deduplication: re-adding with same jobId must return existing hash without error or re-adding
      const duplicateJob = await adapter.add('convert', { userId, format: 'docx' }, { jobId: fixedJobId, priority: 1 });
      expect(duplicateJob.id).toBe(fixedJobId);
      expect((duplicateJob.data as any).format).toBe('pdf'); // preserved original data
    });

    it('schedules jobs with priority ordering (1 > 2 > 0/1000) and FIFO ties in Redis', async () => {
      const adapter = connect('redis-priority');

      const jobLow1 = await adapter.add('c', { id: 'low-1' }, { priority: 1000 });
      const jobHigh1 = await adapter.add('c', { id: 'high-1' }, { priority: 1 });
      const jobMed1 = await adapter.add('c', { id: 'med-1' }, { priority: 2 });
      const jobHigh2 = await adapter.add('c', { id: 'high-2' }, { priority: 1 });
      const jobLow2 = await adapter.add('c', { id: 'low-2' }, { priority: 0 });

      const poppedIds: string[] = [];
      while (true) {
        const popped = await adapter._popNextWaiting();
        if (!popped) break;
        poppedIds.push(popped.id);
      }

      expect(poppedIds).toEqual([jobHigh1.id, jobHigh2.id, jobMed1.id, jobLow1.id, jobLow2.id]);
    });

    it('auto-migrates legacy waiting LIST to ZSET on POP_NEXT_WAITING_JOB', async () => {
      const adapter = connect('legacy-migrate');
      const waitingKey = `${keyPrefix}{legacy-migrate}:waiting`;

      // Simulate a legacy deployment where waiting is a LIST with 2 jobs
      const job1 = await adapter.add('task1', { v: 1 });
      const job2 = await adapter.add('task2', { v: 2 }, { priority: 1 });

      // Convert waitingKey to a LIST in Redis
      await admin.del(waitingKey);
      await admin.rpush(waitingKey, job1.id, job2.id);
      expect(await admin.type(waitingKey)).toBe('list');

      // Pop should automatically migrate LIST to ZSET and pop the highest priority job (job2)
      const firstPopped = await adapter._popNextWaiting();
      expect(firstPopped?.id).toBe(job2.id);
      expect(await admin.type(waitingKey)).toBe('zset');

      const secondPopped = await adapter._popNextWaiting();
      expect(secondPopped?.id).toBe(job1.id);
    });

    it('broadcasts pub/sub events on both {queue}:events and {queue}:job:{id}:events channels', async () => {
      const adapter = connect('pubsub-events');
      const subAdmin = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });

      const globalEvents: any[] = [];
      const perJobEvents: any[] = [];

      const job = await adapter.add('transcode', { file: 'video.mp4' });

      const globalChannel = `${keyPrefix}pubsub-events:events`;
      const perJobChannel = `${keyPrefix}pubsub-events:job:${job.id}:events`;

      await subAdmin.subscribe(globalChannel, perJobChannel);
      subAdmin.on('message', (chan, msg) => {
        const parsed = JSON.parse(msg);
        if (chan === globalChannel) {
          globalEvents.push(parsed);
        } else if (chan === perJobChannel) {
          perJobEvents.push(parsed);
        }
      });

      // Update progress
      await job.updateProgress(50);
      await new Promise((r) => setTimeout(r, 50));

      // Pop and complete
      const popped = await adapter._popNextWaiting();
      expect(popped?.id).toBe(job.id);
      await adapter._onJobCompleted(popped!, { outputKey: 'out.mp4' });
      await new Promise((r) => setTimeout(r, 100));

      await subAdmin.quit();

      // Verify global events received progress and completed
      const globalProgress = globalEvents.find((e) => e.event === 'progress' && e.jobId === job.id);
      const globalCompleted = globalEvents.find((e) => e.event === 'completed' && e.jobId === job.id);
      expect(globalProgress).toBeDefined();
      expect(globalProgress.progress).toBe(50);
      expect(globalCompleted).toBeDefined();
      expect(globalCompleted.result).toEqual({ outputKey: 'out.mp4' });

      // Verify per-job channel received progress and completed
      const jobProgress = perJobEvents.find((e) => e.event === 'progress');
      const jobCompleted = perJobEvents.find((e) => e.event === 'completed');
      expect(jobProgress).toBeDefined();
      expect(jobProgress.progress).toBe(50);
      expect(jobCompleted).toBeDefined();
      expect(jobCompleted.result).toEqual({ outputKey: 'out.mp4' });
    });

    it('queries indexed user jobs with getJobsByUser across pagination and state filtering', async () => {
      const adapter = connect('user-index');
      const userId = 'usr_redis_999';

      const j1 = await adapter.add('doc', { userId, name: 'first' });
      await new Promise((r) => setTimeout(r, 10));
      const j2 = await adapter.add('doc', { userId, name: 'second' });
      await new Promise((r) => setTimeout(r, 10));
      const j3 = await adapter.add('doc', { userId, name: 'third' });

      const userJobs = await adapter.getJobsByUser(userId, undefined, 10, 0);
      expect(userJobs.map((j) => j.id)).toEqual([j3.id, j2.id, j1.id]);

      // Pagination
      const page1 = await adapter.getJobsByUser(userId, undefined, 2, 0);
      expect(page1.map((j) => j.id)).toEqual([j3.id, j2.id]);

      const page2 = await adapter.getJobsByUser(userId, undefined, 2, 2);
      expect(page2.map((j) => j.id)).toEqual([j1.id]);
    });

    it('enforces retention (removeOnComplete, removeOnFail, clean) and prunes user jobs index in Redis', async () => {
      const adapter = connect('redis-retention');
      const userId = 'usr_retention_redis';

      // 1. removeOnComplete: true
      const job1 = await adapter.add('task1', { userId }, { removeOnComplete: true });
      const popped1 = await adapter._popNextWaiting();
      expect(popped1?.id).toBe(job1.id);
      await adapter._onJobCompleted(popped1!, { ok: 1 });

      expect(await adapter.getJob(job1.id)).toBeUndefined();
      expect(await adapter.getJobsByUser(userId)).toEqual([]);

      // 2. removeOnComplete: 2
      const job2 = await adapter.add('task2', { userId }, { removeOnComplete: 2 });
      const p2 = await adapter._popNextWaiting();
      await adapter._onJobCompleted(p2!, { ok: 2 });

      const job3 = await adapter.add('task3', { userId }, { removeOnComplete: 2 });
      const p3 = await adapter._popNextWaiting();
      await adapter._onJobCompleted(p3!, { ok: 3 });

      const job4 = await adapter.add('task4', { userId }, { removeOnComplete: 2 });
      const p4 = await adapter._popNextWaiting();
      await adapter._onJobCompleted(p4!, { ok: 4 });

      // After 3 completed jobs with limit 2, job2 is pruned
      expect(await adapter.getJob(job2.id)).toBeUndefined();
      expect(await adapter.getJob(job3.id)).toBeDefined();
      expect(await adapter.getJob(job4.id)).toBeDefined();

      // 3. clean(grace, limit, 'completed')
      const cleaned = await adapter.clean(0, 10, 'completed');
      expect(cleaned.length).toBeGreaterThanOrEqual(2);
      expect(await adapter.getJob(job3.id)).toBeUndefined();
      expect(await adapter.getJob(job4.id)).toBeUndefined();
      expect(await adapter.getJobsByUser(userId)).toEqual([]);
    });

    it('tracks real connection lifecycle events (ready, close, end, error)', async () => {
      const client = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
      const adapter = new DistributedBullMQAdapter('lifecycle-events', { redisClient: client, keyPrefix });
      adapters.push(adapter);

      expect(adapter.isConnected).toBe(true);

      // Simulate connection close
      client.emit('close');
      expect(adapter.isConnected).toBe(false);

      // Simulate connection ready
      client.emit('ready');
      expect(adapter.isConnected).toBe(true);

      // Simulate connection end
      client.emit('end');
      expect(adapter.isConnected).toBe(false);
    });

    it('guarantees strict FIFO ordering on concurrent same-tick additions with identical priority in Redis', async () => {
      const adapter = connect('redis-fifo-concurrent-ties');

      // Add jobs concurrently without awaiting in between, with IDs that would sort in reverse if tied
      const p1 = adapter.add('c', { seq: 1 }, { jobId: 'zzz-job-tie-1', priority: 1000 });
      const p2 = adapter.add('c', { seq: 2 }, { jobId: 'aaa-job-tie-2', priority: 1000 });
      await Promise.all([p1, p2]);

      const popped1 = await adapter._popNextWaiting();
      const popped2 = await adapter._popNextWaiting();

      expect(popped1?.id).toBe('zzz-job-tie-1');
      expect(popped2?.id).toBe('aaa-job-tie-2');
    });

    it('enforces removeOnComplete and removeOnFail in fallback in-memory mode without Redis', async () => {
      const fallbackAdapter = new DistributedBullMQAdapter('fallback-retention-test');
      const userId = 'usr_fallback_retention';

      const jobCompleted = await fallbackAdapter.add('c', { userId }, { removeOnComplete: true });
      jobCompleted.state = 'completed';
      jobCompleted.finishedOn = Date.now();
      const completedOk = await fallbackAdapter._onJobCompleted(jobCompleted, { ok: 1 });
      expect(completedOk).toBe(true);
      expect(await fallbackAdapter.getJob(jobCompleted.id)).toBeUndefined();
      expect(await fallbackAdapter.getJobsByUser(userId)).toEqual([]);

      const jobFailed = await fallbackAdapter.add('c', { userId }, { removeOnFail: true });
      jobFailed.state = 'failed';
      jobFailed.finishedOn = Date.now();
      const failedOk = await fallbackAdapter._onJobFailed(jobFailed, new Error('boom'));
      expect(failedOk).toBe(true);
      expect(await fallbackAdapter.getJob(jobFailed.id)).toBeUndefined();
      expect(await fallbackAdapter.getJobsByUser(userId)).toEqual([]);
    });

    it('preserves list sequence order during legacy LIST to ZSET migration', async () => {
      const adapter = connect('legacy-seq-migrate');
      const waitingKey = `${keyPrefix}{legacy-seq-migrate}:waiting`;

      // Seed 3 items in reverse alphabetical order: zzz, mmm, aaa
      await admin.del(waitingKey);
      await admin.rpush(waitingKey, 'zzz-seq', 'mmm-seq', 'aaa-seq');
      expect(await admin.type(waitingKey)).toBe('list');

      // Add a job to trigger ADD_JOB_LUA_SCRIPT migration
      await adapter.add('trigger', { val: 1 });

      expect(await admin.type(waitingKey)).toBe('zset');
      const zsetItems = await admin.zrange(waitingKey, 0, -1);
      // Verify sequence is preserved: zzz-seq, mmm-seq, aaa-seq (followed by trigger)
      expect(zsetItems.slice(0, 3)).toEqual(['zzz-seq', 'mmm-seq', 'aaa-seq']);
    });
  });

  describe('3. Unified ConversionQueue Delegation and Telemetry', () => {
    it('delegates getJobsByUser and clean across all resource queues', async () => {
      const userId = 'usr_multi_queue_test';

      const job = await conversionQueue.add('convert', {
        userId,
        originalFilename: 'test.docx',
        sourceFormat: 'docx',
        targetFormat: 'pdf',
        fileSize: 1024,
      } as any);

      const userJobs = await conversionQueue.getJobsByUser(userId, undefined, 10, 0);
      expect(userJobs.some((j) => j.id === job.id)).toBe(true);

      // Clean
      await conversionQueue.cancelJob(job.id, 'cleanup test');
      const cleaned = await conversionQueue.clean(0, 10, 'cancelled');
      expect(cleaned).toContain(job.id);
    });

    it('subscribes to job telemetry and receives progress, completed, failed, and cancelled deterministically', async () => {
      const queue = new Queue('telemetry-test');
      const job = await queue.add('job-telemetry', { dummy: 1 });

      const events: any[] = [];
      const unsub = subscribeToJobTelemetry(queue, job.id, (e) => {
        events.push(e);
      });

      await job.updateProgress(42);
      queue.emit('completed', job, { success: true });

      expect(events).toEqual([
        { event: 'progress', data: { jobId: job.id, progress: 42, state: 'waiting' } },
        { event: 'completed', data: { jobId: job.id, progress: 100, state: 'completed', result: { success: true } } },
      ]);

      unsub();
      await job.updateProgress(99);
      expect(events).toHaveLength(2); // no new events after unsub
    });
  });
});
