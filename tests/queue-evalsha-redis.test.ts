import crypto from 'node:crypto';
import Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DistributedBullMQAdapter,
  Worker,
} from '../src/lib/queue/bullmq-engine';
import { luaScriptSha1 } from '../src/lib/queue/eval-lua';
import { forgetUserJobs, keepNewestEnded, type QueueKeySpace } from '../src/lib/queue/ended-jobs';
import { readOldestWaitingSince } from '../src/lib/queue/queue-queries';
import { UPDATE_ATTEMPT_PROGRESS_LUA_SCRIPT } from '../src/lib/queue/lua-scripts';
import { RedisGraphScheduler } from '../src/lib/queue/graph';
import { sealGraph } from '../src/lib/queue/graph/node-jobs';
import { countUserJobs } from '../src/lib/queue/user-job-list';
import { clearKeysMatching } from '../src/lib/redis/clear-keys';

const REDIS_URL = process.env.REDIS_URL;

interface CapturedCommand {
  name: string;
  args: unknown[];
}

function captureCommands(admin: Redis): { commands: CapturedCommand[]; restore: () => void } {
  const commands: CapturedCommand[] = [];
  const prototype = Redis.prototype as unknown as {
    sendCommand: (this: unknown, command: { name: string; args: unknown[] }, stream?: object, node?: unknown) => unknown;
  };
  const real = prototype.sendCommand;
  const spy = vi.spyOn(prototype, 'sendCommand').mockImplementation(function (this: unknown, command, stream, node) {
    if (this !== admin) {
      commands.push({ name: command.name, args: command.args });
    }
    return real.call(this, command, stream, node);
  });
  return {
    commands,
    restore: () => spy.mockRestore(),
  };
}

// skip-ok: mode selection. Standard test shards run without REDIS_URL; Redis integration runs set REDIS_URL.
describe.skipIf(!REDIS_URL)('Queue Lua EVALSHA execution and progress deduplication on real Redis', () => {
  let admin: Redis;
  let keyPrefix: string;
  const clients: Redis[] = [];

  beforeEach(() => {
    keyPrefix = `evalsha-suite-${crypto.randomBytes(6).toString('hex')}:`;
    admin = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearKeysMatching(admin, [`${keyPrefix}*`]).catch(() => undefined);
    for (const c of clients.splice(0)) {
      await c.quit().catch(() => undefined);
    }
    await admin.quit();
  });

  function connect(): Redis {
    const c = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
    clients.push(c);
    return c;
  }

  it('falls back to EVAL once on cold cache and runs steady-state queue, index, and graph Lua scripts via EVALSHA only', async () => {
    await admin.script('FLUSH');
    const qClient = connect();
    const gClient = connect();
    const adapter = new DistributedBullMQAdapter<{ userId: string; tag: string }, string>('q-evalsha', {
      redisClient: qClient,
      keyPrefix,
    });
    const scheduler = new RedisGraphScheduler({
      redisClient: gClient,
      keyPrefix,
      enqueueNode: async () => undefined,
      cancelNode: async () => true,
    });

    try {
      // Cold warmup pass: first encounter populates Redis script cache via NOSCRIPT -> EVAL fallback.
      const warmJob = await adapter.add('convert', { userId: 'u_warm', tag: 'cold' }, { removeOnComplete: 10 });
      const warmPop = await adapter._popNextWaiting();
      expect(warmPop?.id).toBe(warmJob.id);
      await warmPop!.updateProgress(40);
      await warmPop!.log('warm step');
      await adapter._claimDeadline(warmPop!, Date.now() + 60_000);
      await adapter._onJobCompleted(warmPop!, 'done-cold');

      const cancelWarm = await adapter.add('convert', { userId: 'u_warm', tag: 'cancel-cold' });
      expect(await adapter.cancelJob(cancelWarm.id, 'warm cancel')).toBe(true);

      await adapter.getJobsByUser('u_warm', undefined, 10, 0);
      await adapter.getJobsByUser('u_warm', ['completed'], 10, 0);
      await countUserJobs(qClient, {
        indexKey: adapter.getUserJobsKey('u_warm'),
        jobKeyPrefix: `${keyPrefix}{q-evalsha}:job:`,
        cap: 100,
      });
      await readOldestWaitingSince(qClient, `${keyPrefix}{q-evalsha}:waiting`, 1_000_000_000, 8, () => undefined);

      const gWarmId = `gw_${crypto.randomBytes(4).toString('hex')}`;
      await scheduler.initGraph(
        gWarmId,
        sealGraph(gWarmId, {
          failurePolicy: 'fail_fast',
          nodes: { a: { op: 'import.upload', storageKey: 'k/a' } },
        }),
        { ownerUserId: 'u_warm' }
      );
      await scheduler.onNodeStarted(gWarmId, 'a');
      await scheduler.onNodeCompleted(gWarmId, 'a', ['k/a'], 1);

      // Steady-state pass: assert zero EVAL commands are sent across all scripts.
      const capture = captureCommands(admin);
      const hotJob = await adapter.add('convert', { userId: 'u_hot', tag: 'warm' }, { removeOnComplete: 5 });
      const hotPop = await adapter._popNextWaiting();
      expect(hotPop?.id).toBe(hotJob.id);
      await hotPop!.updateProgress(45);
      await hotPop!.log('hot step');
      await adapter._claimDeadline(hotPop!, Date.now() + 60_000);
      await adapter._onJobCompleted(hotPop!, 'done-warm');

      const cancelHot = await adapter.add('convert', { userId: 'u_hot', tag: 'cancel-warm' });
      expect(await adapter.cancelJob(cancelHot.id, 'hot cancel')).toBe(true);
      await adapter.getJobsByUser('u_hot', undefined, 10, 0);
      await adapter.getJobsByUser('u_hot', ['cancelled'], 10, 0);
      await adapter.oldestWaitingSince();

      const gHotId = `gh_${crypto.randomBytes(4).toString('hex')}`;
      await scheduler.initGraph(
        gHotId,
        sealGraph(gHotId, {
          failurePolicy: 'fail_fast',
          nodes: { a: { op: 'import.upload', storageKey: 'k/a' } },
        }),
        { ownerUserId: 'u_hot' }
      );
      await scheduler.onNodeStarted(gHotId, 'a');
      await scheduler.onNodeCompleted(gHotId, 'a', ['k/a'], 1);
      capture.restore();

      const evalNames = capture.commands.map((c) => c.name);
      expect(evalNames).toContain('evalsha');
      expect(evalNames).not.toContain('eval');
    } finally {
      await adapter.close();
    }
  });

  it('recovers single and batched pipeline EVALSHA calls cleanly after mid-flight SCRIPT FLUSH', async () => {
    const qClient = connect();
    const adapter = new DistributedBullMQAdapter<{ userId: string }, string>('q-flush', {
      redisClient: qClient,
      keyPrefix,
    });
    const keys: QueueKeySpace = {
      jobKey: (id) => `${keyPrefix}{q-flush}:job:${id}`,
      userJobsKey: (uid) => `${keyPrefix}{q-flush}:user_jobs:${uid ?? 'none'}`,
      dlqKey: `${keyPrefix}{q-flush}:dlq`,
      stateKeys: [
        `${keyPrefix}{q-flush}:waiting`,
        `${keyPrefix}{q-flush}:delayed`,
        `${keyPrefix}{q-flush}:active`,
        `${keyPrefix}{q-flush}:completed`,
        `${keyPrefix}{q-flush}:failed`,
        `${keyPrefix}{q-flush}:cancelled`,
      ],
    };

    try {
      const createdIds: string[] = [];
      for (let i = 0; i < 20; i++) {
        const job = await adapter.add('convert', { userId: 'u_flush' });
        await adapter.cancelJob(job.id, 'done');
        createdIds.push(job.id);
      }

      // Populate ensureQueueLuaLoaded per-client cache for batch 1 (first 10 jobs), then wipe server cache!
      const leftAfterHalf = await forgetUserJobs(qClient, keys, 'u_flush', new Set(createdIds.slice(0, 10)));
      expect(leftAfterHalf).toEqual(createdIds.slice(10));

      // Simulate Redis SCRIPT FLUSH / server restart while client WeakMap still thinks script SHAs are loaded.
      await admin.script('FLUSH');

      const capture = captureCommands(admin);
      // Both pipeline forgetUserJobs and keepNewestEnded must recover seamlessly via NOSCRIPT -> EVAL.
      const leftAfterAll = await forgetUserJobs(qClient, keys, 'u_flush', new Set(createdIds.slice(10)));
      expect(leftAfterAll).toEqual([]);
      expect(await admin.zcard(adapter.getUserJobsKey('u_flush'))).toBe(0);

      // Enqueue and complete one job after flush, then run steady-state keepNewestEnded to confirm cache stays re-armed.
      const extra = await adapter.add('convert', { userId: 'u_after_flush' });
      const popped = await adapter._popNextWaiting();
      await adapter._onJobCompleted(popped!, 'ok');
      expect(await admin.hget(keys.jobKey(extra.id), 'state')).toBe('completed');
      await keepNewestEnded(qClient, keys, `${keyPrefix}{q-flush}:completed`, 5);
      capture.restore();

      const names = capture.commands.map((c) => c.name);
      expect(names).toContain('evalsha');
      expect(names).toContain('eval');
    } finally {
      await adapter.close();
    }
  });

  it('drops duplicate progress writes and redundant attempt 100 writes in Redis while preserving final progress=100', async () => {
    const adapter = new DistributedBullMQAdapter<{ transientSyncWait?: boolean }, string>('q-progress', {
      redisClient: connect(),
      keyPrefix,
    });
    const updateProgressSha = luaScriptSha1(UPDATE_ATTEMPT_PROGRESS_LUA_SCRIPT);

    try {
      // Warm all scripts first so captures inspect exact steady-state command counts.
      const warmWorker = new Worker<{ transientSyncWait?: boolean }, string>(
        adapter,
        async (j) => {
          await j.updateProgress(25);
          return 'warm';
        },
        { concurrency: 1 }
      );
      const warm = await adapter.add('convert', {});
      await new Promise<void>((resolve) => {
        warmWorker.once('completed', (j) => {
          if (j.id === warm.id) resolve();
        });
      });
      await warmWorker.close();

      // Now observe a worker that calls duplicate updates and updateProgress(100) before returning,
      // plus a transientSyncWait job.
      const capture = captureCommands(admin);
      const seenWorker = new Worker<{ transientSyncWait?: boolean }, string>(
        adapter,
        async (j) => {
          await j.updateProgress(50);
          await j.updateProgress(50);
          await j.updateProgress(100);
          return 'ok';
        },
        { concurrency: 1 }
      );

      const asyncJob = await adapter.add('convert', {});
      await new Promise<void>((resolve) => {
        seenWorker.once('completed', (j) => {
          if (j.id === asyncJob.id) resolve();
        });
      });
      const syncJob = await adapter.add('convert', { transientSyncWait: true });
      await new Promise<void>((resolve) => {
        seenWorker.once('completed', (j) => {
          if (j.id === syncJob.id) resolve();
        });
      });
      await seenWorker.close();
      capture.restore();

      const progressScriptCalls = capture.commands.filter(
        (c) => (c.name === 'evalsha' && c.args[0] === updateProgressSha) || (c.name === 'eval' && c.args[0] === UPDATE_ATTEMPT_PROGRESS_LUA_SCRIPT)
      );
      // Only one progress write for asyncJob (at 50), zero for duplicate 50, zero for attempt 100, zero for transientSyncWait.
      expect(progressScriptCalls).toHaveLength(1);
      expect(progressScriptCalls[0].args.at(-1)).toBe('50');

      const stored = await admin.hgetall(`${keyPrefix}{q-progress}:job:${asyncJob.id}`);
      expect(stored.state).toBe('completed');
      expect(stored.progress).toBe('100');
    } finally {
      await adapter.close();
    }
  });
});
