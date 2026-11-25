import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { DistributedBullMQAdapter, Job, JobCancelledError, Queue, Worker } from '../src/lib/queue/bullmq-engine';
import { allConversionQueues, conversionQueue, processConversionJob, resourceQueues } from '../src/lib/queue/conversion-queue';
import { ensureQueueLuaLoaded, evalQueueLua, execPipelineEvalQueueLua, luaScriptSha1 } from '../src/lib/queue/eval-lua';
import { UPDATE_ATTEMPT_PROGRESS_LUA_SCRIPT } from '../src/lib/queue/lua-scripts';
import { processNodeJob, type ConversionEnginePort } from '../src/lib/queue/node-processor';
import {
  dispatchSyncArchiveInspection,
  dispatchSyncRouteConversion,
  dispatchSyncWebTool,
} from '../src/lib/queue/wait-for-job';
import * as workerPresence from '../src/lib/queue/worker-presence';
import { storageProvider } from '../src/lib/storage';
import { closeRetentionLedger, getRetentionLedger } from '../src/lib/storage/retention-ledger';
import { s3Storage } from '../src/lib/storage/s3-storage';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';

describe('Queue scheduling fairness, direct targetQueue polling, and progress deduplication', () => {
  const openWorkers: Worker<any, any>[] = [];
  const openQueues: Queue<any, any>[] = [];
  const openAdapters: DistributedBullMQAdapter<any, any>[] = [];
  const tempDirs: string[] = [];
  let savedExecMode: string | undefined;

  beforeEach(() => {
    savedExecMode = process.env.WEB_EXECUTION_MODE;
  });

  afterEach(async () => {
    while (openWorkers.length > 0) {
      await openWorkers.pop()!.close().catch(() => undefined);
    }
    while (openQueues.length > 0) {
      await openQueues.pop()!.close().catch(() => undefined);
    }
    while (openAdapters.length > 0) {
      await openAdapters.pop()!.close().catch(() => undefined);
    }
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
    if (savedExecMode === undefined) delete process.env.WEB_EXECUTION_MODE;
    else process.env.WEB_EXECUTION_MODE = savedExecMode;
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await Promise.all(allConversionQueues.map((q) => q.close()));
    await closeRetentionLedger();
    await redisKeyStore.close();
    await redisUserStore.close();
    s3Storage.stopGc();
  });

  it('round-robins popNextEligibleJob across queues instead of starving later queues', async () => {
    const qA = new Queue<{ tag: string }, string>('rr-a');
    const qB = new Queue<{ tag: string }, string>('rr-b');
    const qC = new Queue<{ tag: string }, string>('rr-c');
    openQueues.push(qA, qB, qC);

    await qA.add('job', { tag: 'a1' });
    await qA.add('job', { tag: 'a2' });
    await qA.add('job', { tag: 'a3' });
    await qB.add('job', { tag: 'b1' });
    await qB.add('job', { tag: 'b2' });
    await qC.add('job', { tag: 'c1' });
    await qC.add('job', { tag: 'c2' });

    const poppedOrder: string[] = [];
    const done = new Promise<void>((resolve) => {
      const worker = new Worker<{ tag: string }, string>(
        [qA, qB, qC],
        async (job) => {
          poppedOrder.push(job.data.tag);
          if (poppedOrder.length === 7) resolve();
          return job.data.tag;
        },
        { concurrency: 1 }
      );
      openWorkers.push(worker);
    });

    await done;
    expect(poppedOrder).toEqual(['a1', 'b1', 'c1', 'a2', 'b2', 'c2', 'a3']);
  });

  it('rotates heavy queues fairly under maxHeavyConcurrency while allowing fast queues to progress', async () => {
    const fastA = new Queue<{ tag: string }, string>('fast-a');
    const fastB = new Queue<{ tag: string }, string>('fast-b');
    const heavyA = new Queue<{ tag: string }, string>('heavy-a');
    const heavyB = new Queue<{ tag: string }, string>('heavy-b');
    openQueues.push(fastA, fastB, heavyA, heavyB);

    await heavyA.add('job', { tag: 'ha1' });
    await heavyA.add('job', { tag: 'ha2' });
    await heavyB.add('job', { tag: 'hb1' });
    await heavyB.add('job', { tag: 'hb2' });
    await fastA.add('job', { tag: 'fa1' });
    await fastB.add('job', { tag: 'fb1' });

    const order: string[] = [];
    let maxObservedHeavyActive = 0;
    let currentHeavyActive = 0;

    const done = new Promise<void>((resolve) => {
      const worker = new Worker<{ tag: string }, string>(
        [fastA, fastB, heavyA, heavyB],
        async (job) => {
          const isHeavy = job.data.tag.startsWith('h');
          if (isHeavy) {
            currentHeavyActive++;
            maxObservedHeavyActive = Math.max(maxObservedHeavyActive, currentHeavyActive);
          }
          order.push(job.data.tag);
          await new Promise((r) => setTimeout(r, 10));
          if (isHeavy) currentHeavyActive--;
          if (order.length === 6) resolve();
          return job.data.tag;
        },
        {
          concurrency: 3,
          heavyQueueNames: new Set(['heavy-a', 'heavy-b']),
          maxHeavyConcurrency: 1,
        }
      );
      openWorkers.push(worker);
    });

    await done;
    expect(maxObservedHeavyActive).toBe(1);
    const heavySequence = order.filter((t) => t.startsWith('h'));
    expect(heavySequence).toEqual(['ha1', 'hb1', 'ha2', 'hb2']);
  });

  it('polls, subscribes, and cancels targetQueue directly in waitForQueuedJobResult without scanning conversionQueue', async () => {
    process.env.WEB_EXECUTION_MODE = 'queue-only';
    vi.spyOn(workerPresence, 'hasLiveQueueWorker').mockResolvedValue(true);
    vi.spyOn(storageProvider, 'saveObject').mockResolvedValue({ key: 'k', size: 3 } as never);
    vi.spyOn(storageProvider, 'deleteObject').mockResolvedValue(true);
    vi.spyOn(storageProvider, 'getObject').mockResolvedValue({
      buffer: Buffer.from('out'),
      mimeType: 'application/json',
      filename: 'out.json',
      release: async () => undefined,
    } as never);

    const defaultGetJobSpy = vi.spyOn(conversionQueue, 'getJob');
    const defaultCancelSpy = vi.spyOn(conversionQueue, 'cancelJob');
    const defaultOnSpy = vi.spyOn(conversionQueue, 'on');

    const handleJob = async (job: Job<ConversionJobData, ConversionJobResult>): Promise<ConversionJobResult> => {
      if (job.name === 'archive-inspect-sync') {
        return {
          jobId: job.id,
          status: 'completed',
          resultKey: '',
          downloadUrl: '',
          filename: 'a.zip',
          mimeType: 'application/json',
          size: 3,
          durationMs: 1,
          archiveInspection: { entries: [], totalEntries: 0, totalUncompressedBytes: 0, encrypted: false },
        };
      }
      return {
        jobId: job.id,
        status: 'completed',
        resultKey: 'results/mock/out.json',
        downloadUrl: '/api/storage/file/results/mock/out.json',
        filename: 'out.json',
        mimeType: 'application/json',
        size: 3,
        durationMs: 1,
        engineUsed: 'native',
      };
    };

    openWorkers.push(
      new Worker<ConversionJobData, ConversionJobResult>([resourceQueues.cpu], handleJob, { concurrency: 1 }),
      new Worker<ConversionJobData, ConversionJobResult>([resourceQueues.light], handleJob, { concurrency: 1 })
    );

    // 1. Route conversion (small txt -> pdf) -> resourceQueues.light
    await dispatchSyncRouteConversion({
      inputBuffer: Buffer.from('hello'),
      sourceFormat: 'txt',
      targetFormat: 'pdf',
      options: {},
      originalFilename: 'a.txt',
      userId: 'u_direct',
      tier: 'paid',
    });

    // 2. Archive inspection -> resourceQueues.cpu
    await dispatchSyncArchiveInspection({
      archiveBuffer: Buffer.from('PK\x05\x06' + '\x00'.repeat(18)),
      inputBytes: 22,
      filename: 'a.zip',
      userId: 'u_direct',
      tier: 'paid',
    });

    // 3. Aborted web tool -> cancels targetQueue directly without conversionQueue fanout
    const ac = new AbortController();
    const cancelTargetSpy = vi.spyOn(resourceQueues.cpu, 'cancelJob');
    await expect(
      dispatchSyncWebTool({
        tool: 'merge',
        files: [
          { name: 'a.pdf', buffer: Buffer.from('%PDF-1.4\n') },
          { name: 'b.pdf', buffer: Buffer.from('%PDF-1.4\n') },
        ],
        options: {},
        userId: 'u_direct',
        tier: 'paid',
        signal: (() => {
          setTimeout(() => ac.abort(new Error('Client aborted')), 5);
          return ac.signal;
        })(),
      })
    ).rejects.toThrow('Client aborted');

    expect(defaultGetJobSpy).not.toHaveBeenCalled();
    expect(defaultCancelSpy).not.toHaveBeenCalled();
    const telemetrySubsOnDefault = defaultOnSpy.mock.calls.filter(([evt]) => String(evt).startsWith('telemetry:'));
    expect(telemetrySubsOnDefault).toHaveLength(0);
    expect(cancelTargetSpy).toHaveBeenCalled();
  });

  it('suppresses duplicate updateProgress writes in Job and redundant backward progress in processConversionJob', async () => {
    const q = new Queue<ConversionJobData, ConversionJobResult>('progress-dedup');
    openQueues.push(q);

    // Job.updateProgress ignores unchanged rounded progress values.
    const hookWrites: number[] = [];
    const emitterEvents: number[] = [];
    q.on('progress', (_j, p) => emitterEvents.push(p));
    const job = new Job<ConversionJobData, ConversionJobResult>(
      'j_dedup',
      'convert',
      {
        jobId: 'j_dedup',
        originalFilename: 'a.csv',
        sourceFormat: 'csv',
        targetFormat: 'json',
        fileSize: 10,
        options: {},
        inputBufferBase64: Buffer.from('a,b\n1,2\n').toString('base64'),
      },
      {},
      q,
      async (j) => {
        hookWrites.push(j.progress);
      }
    );

    await job.updateProgress(49.6);
    await job.updateProgress(50.4);
    await job.updateProgress(50);
    await job.updateProgress(Number.NaN);
    await job.updateProgress(Number.POSITIVE_INFINITY);
    await job.updateProgress(Number.NEGATIVE_INFINITY);
    await job.updateProgress(-5);
    await job.updateProgress(0.2);
    await job.updateProgress(100);
    await job.updateProgress(150);

    expect(hookWrites).toEqual([50, 0, 100]);
    expect(emitterEvents).toEqual([50, 0, 100]);

    // processConversionJob produces strictly increasing, duplicate-free progress on both single and chained conversions.
    const single = await q.add('convert', {
      jobId: 'j_single_prog',
      originalFilename: 's.csv',
      sourceFormat: 'csv',
      targetFormat: 'json',
      fileSize: 8,
      options: {},
      inputBufferBase64: Buffer.from('a,b\n1,2\n').toString('base64'),
    });
    const singleWrites: number[] = [];
    q.on('progress', (j, p) => {
      if (j.id === single.id) singleWrites.push(p);
    });
    await processConversionJob(single);
    expect(singleWrites).toEqual([10, 35, 75, 100]);

    const chain = await q.add('convert', {
      jobId: 'j_chain_prog',
      originalFilename: 'c.csv',
      sourceFormat: 'csv',
      targetFormat: 'yaml',
      fileSize: 8,
      options: {},
      inputBufferBase64: Buffer.from('a,b\n1,2\n').toString('base64'),
      tasks: [
        { name: 'step1', operation: 'convert', targetFormat: 'json' },
        { name: 'step2', operation: 'convert', targetFormat: 'yaml' },
      ],
    });
    const chainWrites: number[] = [];
    q.on('progress', (j, p) => {
      if (j.id === chain.id) chainWrites.push(p);
    });
    await processConversionJob(chain);
    expect(chainWrites).toEqual([10, 35, 58, 80, 100]);

    // Multi-stage chains with >=5 stages must stay strictly increasing above 35% rather than regressing backwards.
    const longChain = await q.add('convert', {
      jobId: 'j_long_chain_prog',
      originalFilename: 'long.csv',
      sourceFormat: 'csv',
      targetFormat: 'yaml',
      fileSize: 8,
      options: {},
      inputBufferBase64: Buffer.from('a,b\n1,2\n').toString('base64'),
      tasks: [
        { name: 's1', operation: 'convert', targetFormat: 'json' },
        { name: 's2', operation: 'convert', targetFormat: 'yaml' },
        { name: 's3', operation: 'convert', targetFormat: 'json' },
        { name: 's4', operation: 'convert', targetFormat: 'yaml' },
        { name: 's5', operation: 'convert', targetFormat: 'json' },
        { name: 's6', operation: 'convert', targetFormat: 'yaml' },
      ],
    });
    const longChainWrites: number[] = [];
    q.on('progress', (j, p) => {
      if (j.id === longChain.id) longChainWrites.push(p);
    });
    await processConversionJob(longChain);
    expect(longChainWrites).toEqual([10, 35, 43, 50, 58, 65, 73, 80, 100]);
    for (let i = 1; i < longChainWrites.length; i++) {
      expect(longChainWrites[i]).toBeGreaterThan(longChainWrites[i - 1]);
    }
  });

  it('loads Lua scripts across every Cluster master in ensureQueueLuaLoaded and fails closed on truncated EVALSHA pipelines', async () => {
    const script = 'return 1';
    const expectedSha = luaScriptSha1(script);
    const masterCalls: unknown[][] = [];
    const clusterClient = {
      isCluster: true,
      eval: vi.fn(),
      evalsha: vi.fn(),
      nodes: vi.fn().mockReturnValue([
        { script: vi.fn(async (...args: unknown[]) => masterCalls.push(['m1', ...args])) },
        { script: vi.fn(async (...args: unknown[]) => masterCalls.push(['m2', ...args])) },
      ]),
    } as unknown as Redis;

    expect(await ensureQueueLuaLoaded(clusterClient, script)).toBe(expectedSha);
    expect(await ensureQueueLuaLoaded(clusterClient, script)).toBe(expectedSha);
    expect(masterCalls).toEqual([
      ['m1', 'LOAD', script],
      ['m2', 'LOAD', script],
    ]);

    const truncatedClient = {
      eval: vi.fn(),
      evalsha: vi.fn(),
      script: vi.fn().mockResolvedValue(expectedSha),
      pipeline: () => ({
        evalsha: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([[null, 1]]),
      }),
    } as unknown as Redis;

    await expect(
      execPipelineEvalQueueLua(truncatedClient, {
        script,
        calls: [
          { numKeys: 1, args: ['k1'] },
          { numKeys: 1, args: ['k2'] },
        ],
      })
    ).rejects.toThrow(/returned 1 replies for 2 commands/);

    const truncatedRetryClient = {
      eval: vi.fn(),
      evalsha: vi.fn(),
      script: vi.fn().mockResolvedValue(expectedSha),
      pipeline: vi
        .fn()
        .mockReturnValueOnce({
          evalsha: vi.fn().mockReturnThis(),
          exec: vi.fn().mockResolvedValue([
            [new Error('NOSCRIPT No matching script'), null],
            [new Error('NOSCRIPT No matching script'), null],
          ]),
        })
        .mockReturnValueOnce({
          eval: vi.fn().mockReturnThis(),
          evalsha: vi.fn().mockReturnThis(),
          exec: vi.fn().mockResolvedValue([[null, 1]]),
        }),
    } as unknown as Redis;

    await expect(
      execPipelineEvalQueueLua(truncatedRetryClient, {
        script,
        calls: [
          { numKeys: 1, args: ['k1'] },
          { numKeys: 1, args: ['k2'] },
        ],
      })
    ).rejects.toThrow(/retry pipeline returned 1 replies for 2 commands/);

    const extraRepliesClient = {
      eval: vi.fn(),
      evalsha: vi.fn(),
      script: vi.fn().mockResolvedValue(expectedSha),
      pipeline: () => ({
        evalsha: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([
          [null, 1],
          [null, 2],
          [null, 3],
        ]),
      }),
    } as unknown as Redis;

    await expect(
      execPipelineEvalQueueLua(extraRepliesClient, {
        script,
        calls: [
          { numKeys: 1, args: ['k1'] },
          { numKeys: 1, args: ['k2'] },
        ],
      })
    ).rejects.toThrow(/returned 3 replies for 2 commands/);
  });

  it('suppresses Job.updateProgress after abort or terminal state and suppresses Redis Pub/Sub when Lua returns 0', async () => {
    const q = new Queue<ConversionJobData, ConversionJobResult>('progress-abort-gate');
    openQueues.push(q);

    const emitted: number[] = [];
    const hookCalls: number[] = [];
    q.on('progress', (_j, p) => emitted.push(p));

    const makeJob = (id: string) =>
      new Job<ConversionJobData, ConversionJobResult>(
        id,
        'convert',
        {
          jobId: id,
          originalFilename: 'a.csv',
          sourceFormat: 'csv',
          targetFormat: 'json',
          fileSize: 8,
          options: {},
          inputBufferBase64: Buffer.from('a,b\n1,2\n').toString('base64'),
        },
        {},
        q,
        async (j) => {
          hookCalls.push(j.progress);
        }
      );

    // 1. Aborted signal while still marked active blocks mutation, event emission, and hook calls.
    const abortedJob = makeJob('j_aborted_sig');
    abortedJob.state = 'active';
    await abortedJob.updateProgress(25);
    abortedJob._abortAttempt(new JobCancelledError('client cancelled'));
    await abortedJob.updateProgress(75);
    expect(abortedJob.progress).toBe(25);
    expect(emitted).toEqual([25]);
    expect(hookCalls).toEqual([25]);

    // 2. Terminal states ('cancelled', 'failed', 'completed') block updateProgress even with a fresh signal.
    for (const terminalState of ['cancelled', 'failed', 'completed'] as const) {
      const terminalJob = makeJob(`j_terminal_${terminalState}`);
      terminalJob.state = 'active';
      await terminalJob.updateProgress(40);
      terminalJob.state = terminalState;
      await terminalJob.updateProgress(90);
      expect(terminalJob.progress).toBe(40);
    }
    expect(emitted).toEqual([25, 40, 40, 40]);
    expect(hookCalls).toEqual([25, 40, 40, 40]);

    // 3. DistributedBullMQAdapter suppresses Pub/Sub 'progress' when UPDATE_ATTEMPT_PROGRESS_LUA_SCRIPT returns 0.
    let luaProgressReply = 1;
    const publishedPayloads: Array<{ channel: string; payload: Record<string, unknown> }> = [];
    const fakeRedis = {
      status: 'ready',
      on: vi.fn(),
      evalsha: vi.fn(async () => {
        throw new Error('NOSCRIPT No matching script');
      }),
      eval: vi.fn(async (scriptArg: string) => {
        if (scriptArg === UPDATE_ATTEMPT_PROGRESS_LUA_SCRIPT) {
          return luaProgressReply;
        }
        return [1];
      }),
      pipeline: vi.fn(() => {
        const queued: Array<{ channel: string; message: string }> = [];
        return {
          publish(channel: string, message: string) {
            queued.push({ channel, message });
            return this;
          },
          async exec() {
            for (const entry of queued) {
              publishedPayloads.push({ channel: entry.channel, payload: JSON.parse(entry.message) });
            }
            return queued.map(() => [null, 1]);
          },
        };
      }),
      publish: vi.fn(async (channel: string, message: string) => {
        publishedPayloads.push({ channel, payload: JSON.parse(message) });
        return 1;
      }),
      quit: vi.fn(async () => 'OK'),
      disconnect: vi.fn(),
    } as unknown as Redis;

    const adapter = new DistributedBullMQAdapter<ConversionJobData, ConversionJobResult>('q-pubsub-gate', {
      redisClient: fakeRedis,
      keyPrefix: 'gate:',
    });
    openAdapters.push(adapter);

    const added = await adapter.add('convert', {
      jobId: 'j_redis_gate',
      originalFilename: 'a.csv',
      sourceFormat: 'csv',
      targetFormat: 'json',
      fileSize: 8,
      options: {},
    });
    added.state = 'active';
    added._attemptToken = 'tok_active';

    await added.updateProgress(35);
    expect(publishedPayloads.filter((p) => p.payload.event === 'progress')).toEqual([
      { channel: 'gate:q-pubsub-gate:events', payload: { event: 'progress', jobId: added.id, progress: 35 } },
      {
        channel: `gate:q-pubsub-gate:job:${added.id}:events`,
        payload: { event: 'progress', jobId: added.id, progress: 35 },
      },
    ]);

    publishedPayloads.length = 0;
    luaProgressReply = 0;
    await added.updateProgress(75);
    expect(publishedPayloads).toEqual([]);

    // 4. Aborting while UPDATE_ATTEMPT_PROGRESS_LUA_SCRIPT is in flight suppresses Pub/Sub even when Lua returns 1.
    const inFlightJob = await adapter.add('convert', {
      jobId: 'j_redis_inflight_abort',
      originalFilename: 'a.csv',
      sourceFormat: 'csv',
      targetFormat: 'json',
      fileSize: 8,
      options: {},
    });
    inFlightJob.state = 'active';
    inFlightJob._attemptToken = 'tok_inflight';
    const origEval = fakeRedis.eval as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(fakeRedis, 'eval').mockImplementationOnce((async (scriptArg: string | Buffer, ...rest: unknown[]) => {
      if (scriptArg === UPDATE_ATTEMPT_PROGRESS_LUA_SCRIPT) {
        inFlightJob.state = 'cancelled';
        inFlightJob._abortAttempt(new JobCancelledError('cancelled mid-Lua'));
        return 1;
      }
      return origEval(scriptArg, ...rest);
    }) as typeof fakeRedis.eval);
    await inFlightJob.updateProgress(55);
    expect(publishedPayloads).toEqual([]);
  });

  it('aborts post-storage, post-engine, diagnostic, and pre-100% progress writes cleanly in processNodeJob', async () => {
    const q = new Queue<ConversionJobData, ConversionJobResult>('processor-abort-gates');
    openQueues.push(q);

    const makeBaseJobData = (id: string, extra: Partial<ConversionJobData> = {}): ConversionJobData => ({
      jobId: id,
      originalFilename: 'scores.csv',
      sourceFormat: 'csv',
      targetFormat: 'json',
      fileSize: 12,
      options: {},
      inputBufferBase64: Buffer.from('a,b\n1,2\n').toString('base64'),
      ...extra,
    });

    // 1. Abort during storage.getObject stops before updateProgress(35) and engine.convert.
    const uploadKey = `uploads/abort-get-${Date.now()}.csv`;
    const getJob = await q.add('convert', makeBaseJobData('j_abort_get', { storageKey: uploadKey, inputBufferBase64: undefined }));
    const getProgressCalls: number[] = [];
    vi.spyOn(getJob, 'updateProgress').mockImplementation(async (p) => {
      getProgressCalls.push(p);
    });
    const fakeGetStorage = {
      ...storageProvider,
      getObject: vi.fn(async () => {
        getJob._abortAttempt(new JobCancelledError('cancelled during getObject'));
        return {
          key: uploadKey,
          filename: 'scores.csv',
          mimeType: 'text/csv',
          buffer: Buffer.from('a,b\n1,2\n'),
          size: 8,
          etag: '"1"',
          uploadedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        };
      }),
    };
    const uncalledEngine: ConversionEnginePort = {
      name: 'mock-engine',
      convert: vi.fn(),
    };
    await expect(processNodeJob(getJob, uncalledEngine, fakeGetStorage as never)).rejects.toThrow(/cancelled/i);
    expect(getProgressCalls).toEqual([10]);
    expect(uncalledEngine.convert).not.toHaveBeenCalled();

    const missingAfterAbortJob = await q.add(
      'convert',
      makeBaseJobData('j_abort_get_missing', { storageKey: `${uploadKey}-missing`, inputBufferBase64: undefined })
    );
    const fakeMissingAbortStorage = {
      ...storageProvider,
      getObject: vi.fn(async () => {
        missingAfterAbortJob._abortAttempt(new JobCancelledError('cancelled and purged during getObject'));
        return undefined;
      }),
    };
    await expect(processNodeJob(missingAfterAbortJob, uncalledEngine, fakeMissingAbortStorage as never)).rejects.toThrow(
      /cancelled and purged during getObject/i
    );

    // 2. Single-stage post-engine abort discards output file and skips updateProgress(75) and (100).
    const singleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-abort-single-'));
    tempDirs.push(singleDir);
    const singleDiskOut = path.join(singleDir, 'out.json');
    const singleJob = await q.add('convert', makeBaseJobData('j_abort_single'));
    const singleProgressCalls: number[] = [];
    vi.spyOn(singleJob, 'updateProgress').mockImplementation(async (p) => {
      singleProgressCalls.push(p);
    });
    const saveSpy = vi.spyOn(storageProvider, 'saveObject');
    const singleAbortEngine: ConversionEnginePort = {
      name: 'mock-single',
      async convert() {
        fs.writeFileSync(singleDiskOut, '{"ok":true}');
        singleJob._abortAttempt(new JobCancelledError('cancelled mid-convert'));
        return {
          buffer: Buffer.from('{"ok":true}'),
          filePath: singleDiskOut,
          size: 11,
          mimeType: 'application/json',
          filename: 'out.json',
          engineUsed: 'mock-single',
          executionTimeMs: 5,
        };
      },
    };
    await expect(processNodeJob(singleJob, singleAbortEngine, storageProvider)).rejects.toThrow(/cancelled/i);
    expect(singleProgressCalls).toEqual([10, 35]);
    expect(fs.existsSync(singleDiskOut)).toBe(false);
    expect(singleJob.logs.some((l) => l.includes('Conversion completed'))).toBe(false);
    expect(saveSpy.mock.calls.filter(([k]) => String(k).startsWith(`results/${singleJob.id}/`))).toEqual([]);

    // 3. Multi-stage post-engine abort discards all produced stage files and skips updateProgress(80) and (100).
    const multiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-abort-multi-'));
    tempDirs.push(multiDir);
    const stage1Out = path.join(multiDir, 'stage1.json');
    const stage2Out = path.join(multiDir, 'stage2.yaml');
    const multiJob = await q.add(
      'convert',
      makeBaseJobData('j_abort_multi', {
        targetFormat: 'yaml',
        tasks: [
          { name: 's1', operation: 'convert', targetFormat: 'json' },
          { name: 's2', operation: 'convert', targetFormat: 'yaml' },
        ],
      })
    );
    const multiProgressCalls: number[] = [];
    vi.spyOn(multiJob, 'updateProgress').mockImplementation(async (p) => {
      multiProgressCalls.push(p);
    });
    let stageNum = 0;
    const multiAbortEngine: ConversionEnginePort = {
      name: 'mock-multi',
      async convert() {
        stageNum++;
        if (stageNum === 1) {
          fs.writeFileSync(stage1Out, '{"ok":1}');
          return {
            buffer: Buffer.from('{"ok":1}'),
            filePath: stage1Out,
            size: 8,
            mimeType: 'application/json',
            filename: 'stage1.json',
            engineUsed: 'mock-multi',
            executionTimeMs: 3,
          };
        }
        fs.writeFileSync(stage2Out, 'ok: 1\n');
        multiJob._abortAttempt(new JobCancelledError('cancelled stage 2'));
        return {
          buffer: Buffer.from('ok: 1\n'),
          filePath: stage2Out,
          size: 6,
          mimeType: 'application/yaml',
          filename: 'stage2.yaml',
          engineUsed: 'mock-multi',
          executionTimeMs: 4,
        };
      },
    };
    await expect(processNodeJob(multiJob, multiAbortEngine, storageProvider)).rejects.toThrow(/cancelled/i);
    expect(multiProgressCalls).toEqual([10, 35, 58]);
    expect(fs.existsSync(stage1Out)).toBe(false);
    expect(fs.existsSync(stage2Out)).toBe(false);
    expect(multiJob.logs.some((l) => l.includes('Conversion completed'))).toBe(false);

    // 4. Sequential diagnostic logging aborts cleanly before warning/fallback logs and updateProgress(75).
    const diagJob = await q.add('convert', makeBaseJobData('j_abort_diag'));
    const diagProgressCalls: number[] = [];
    vi.spyOn(diagJob, 'updateProgress').mockImplementation(async (p) => {
      diagProgressCalls.push(p);
    });
    const origLog = diagJob.log.bind(diagJob);
    vi.spyOn(diagJob, 'log').mockImplementation(async (row) => {
      await origLog(row);
      if (row.includes('Conversion completed')) {
        diagJob._abortAttempt(new JobCancelledError('cancelled during diagnostics'));
      }
    });
    const diagEngine: ConversionEnginePort = {
      name: 'mock-diag',
      async convert() {
        return {
          buffer: Buffer.from('[]'),
          size: 2,
          mimeType: 'application/json',
          filename: 'out.json',
          engineUsed: 'mock-diag',
          executionTimeMs: 2,
          skippedLinks: ['http://example.com'],
          fallbackChain: ['step-a'],
          metadata: { warnings: ['warn-1'] },
        };
      },
    };
    await expect(processNodeJob(diagJob, diagEngine, storageProvider)).rejects.toThrow(/cancelled/i);
    expect(diagProgressCalls).toEqual([10, 35]);
    expect(diagJob.logs.some((l) => l.includes('Skipped 1 link entries'))).toBe(false);
    expect(diagJob.logs.some((l) => l.includes('Warning: warn-1'))).toBe(false);
    expect(diagJob.logs.some((l) => l.includes('Engine fallback'))).toBe(false);

    // Multi-stage pipeline emits diagnostics before final updateProgress(80) and aborts cleanly if cancelled mid-diagnostics.
    const multiDiagDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-abort-multi-diag-'));
    tempDirs.push(multiDiagDir);
    const multiDiagOut = path.join(multiDiagDir, 'final.yaml');
    const multiDiagJob = await q.add(
      'convert',
      makeBaseJobData('j_abort_multi_diag', {
        targetFormat: 'yaml',
        tasks: [
          { name: 's1', operation: 'convert', targetFormat: 'json' },
          { name: 's2', operation: 'convert', targetFormat: 'yaml' },
        ],
      })
    );
    const multiDiagProgressCalls: number[] = [];
    vi.spyOn(multiDiagJob, 'updateProgress').mockImplementation(async (p) => {
      multiDiagProgressCalls.push(p);
    });
    const origMultiDiagLog = multiDiagJob.log.bind(multiDiagJob);
    vi.spyOn(multiDiagJob, 'log').mockImplementation(async (row) => {
      await origMultiDiagLog(row);
      if (row.includes('Conversion completed')) {
        multiDiagJob._abortAttempt(new JobCancelledError('cancelled during multi-stage diagnostics'));
      }
    });
    let diagStage = 0;
    const multiDiagEngine: ConversionEnginePort = {
      name: 'mock-multi-diag',
      async convert() {
        diagStage++;
        if (diagStage === 1) {
          return {
            buffer: Buffer.from('[]'),
            size: 2,
            mimeType: 'application/json',
            filename: 's1.json',
            engineUsed: 'mock-multi-diag',
            executionTimeMs: 1,
          };
        }
        fs.writeFileSync(multiDiagOut, 'ok: true\n');
        return {
          buffer: Buffer.from('ok: true\n'),
          filePath: multiDiagOut,
          size: 9,
          mimeType: 'application/yaml',
          filename: 'final.yaml',
          engineUsed: 'mock-multi-diag',
          executionTimeMs: 2,
          metadata: { warnings: ['multi-warn-1'] },
        };
      },
    };
    await expect(processNodeJob(multiDiagJob, multiDiagEngine, storageProvider)).rejects.toThrow(/cancelled/i);
    expect(multiDiagProgressCalls).toEqual([10, 35, 58]);
    expect(fs.existsSync(multiDiagOut)).toBe(false);
    expect(multiDiagJob.logs.some((l) => l.includes('Warning: multi-warn-1'))).toBe(false);

    // 5. Normal run emits "Output saved" log BEFORE updateProgress(100), and aborting inside "Output saved" skips 100%.
    const orderJob = await q.add('convert', makeBaseJobData('j_log_before_100'));
    let outputSavedBefore100 = false;
    const orderEngine: ConversionEnginePort = {
      name: 'mock-ok',
      async convert() {
        return {
          buffer: Buffer.from('[]'),
          size: 2,
          mimeType: 'application/json',
          filename: 'out.json',
          engineUsed: 'mock-ok',
          executionTimeMs: 1,
        };
      },
    };
    const origOrderUpdate = orderJob.updateProgress.bind(orderJob);
    vi.spyOn(orderJob, 'updateProgress').mockImplementation(async (p) => {
      if (p === 100) {
        outputSavedBefore100 = orderJob.logs.some((l) => l.includes('Output saved'));
      }
      await origOrderUpdate(p);
    });
    const okRes = await processNodeJob(orderJob, orderEngine, storageProvider);
    storageProvider.deleteObject(okRes.resultKey);
    await getRetentionLedger().forget(okRes.resultKey).catch(() => undefined);
    expect(outputSavedBefore100).toBe(true);

    const lateAbortJob = await q.add('convert', makeBaseJobData('j_abort_before_100'));
    const lateProgressCalls: number[] = [];
    vi.spyOn(lateAbortJob, 'updateProgress').mockImplementation(async (p) => {
      lateProgressCalls.push(p);
    });
    const origLateLog = lateAbortJob.log.bind(lateAbortJob);
    vi.spyOn(lateAbortJob, 'log').mockImplementation(async (row) => {
      await origLateLog(row);
      if (row.includes('Output saved')) {
        lateAbortJob._abortAttempt(new JobCancelledError('cancelled right after save log'));
      }
    });
    const lateRes = await processNodeJob(lateAbortJob, orderEngine, storageProvider);
    storageProvider.deleteObject(lateRes.resultKey);
    await getRetentionLedger().forget(lateRes.resultKey).catch(() => undefined);
    expect(lateProgressCalls).toEqual([10, 35, 75]);
  });

  it('keeps Cluster preload cache isolated from evalQueueLua, awaits whenReady before nodes(master), and retries every multi-shard NOSCRIPT entry with eval', async () => {
    const script = 'return redis.call("GET", KEYS[1])';
    const expectedSha = luaScriptSha1(script);

    // 1. Lazy-connecting Cluster client: evalQueueLua loads only one shard; ensureQueueLuaLoaded must await whenReady and load all masters.
    const emitter = new EventEmitter();
    const masterLoadCalls: string[] = [];
    let connected = false;
    const clusterClient = Object.assign(emitter, {
      isCluster: true,
      status: 'wait',
      connect: vi.fn(async () => {
        connected = true;
        clusterClient.status = 'ready';
        emitter.emit('ready');
      }),
      evalsha: vi.fn(async () => 'val'),
      eval: vi.fn(async () => 'val'),
      nodes: vi.fn((role: 'master' | 'slave' | 'all') => {
        if (!connected || role !== 'master') return [];
        return [
          {
            script: vi.fn(async (...args: unknown[]) => {
              masterLoadCalls.push(`m1:${String(args[0])}`);
              return expectedSha;
            }),
          },
          {
            script: vi.fn(async (...args: unknown[]) => {
              masterLoadCalls.push(`m2:${String(args[0])}`);
              return expectedSha;
            }),
          },
        ];
      }),
    }) as unknown as Redis;

    expect(await evalQueueLua(clusterClient, script, 1, 'k1')).toBe('val');
    expect(masterLoadCalls).toEqual([]);

    expect(await ensureQueueLuaLoaded(clusterClient, script)).toBe(expectedSha);
    expect((clusterClient as unknown as { connect: ReturnType<typeof vi.fn> }).connect).toHaveBeenCalledTimes(1);
    expect(masterLoadCalls).toEqual(['m1:LOAD', 'm2:LOAD']);

    // Second ensureQueueLuaLoaded hits preloadedClusterMastersByClient.
    expect(await ensureQueueLuaLoaded(clusterClient, script)).toBe(expectedSha);
    expect(masterLoadCalls).toEqual(['m1:LOAD', 'm2:LOAD']);

    // 2. Multi-entry NOSCRIPT retry in execPipelineEvalQueueLua uses retry.eval for EVERY missed index (pos === 0 and pos > 0)
    // and clears Cluster preload cache so subsequent ensureQueueLuaLoaded reloads all masters.
    const retryOps: Array<{ op: 'eval' | 'evalsha'; firstArg: unknown; args: unknown[] }> = [];
    const clusterWithPipeline = Object.assign(clusterClient, {
      pipeline: vi
        .fn()
        .mockReturnValueOnce({
          evalsha: vi.fn().mockReturnThis(),
          exec: vi.fn().mockResolvedValue([
            [new Error('NOSCRIPT No matching script'), null],
            [new Error('NOSCRIPT No matching script'), null],
            [new Error('NOSCRIPT No matching script'), null],
          ]),
        })
        .mockReturnValueOnce({
          eval: vi.fn(function (this: unknown, ...args: unknown[]) {
            retryOps.push({ op: 'eval', firstArg: args[0], args });
            return this;
          }),
          evalsha: vi.fn(function (this: unknown, ...args: unknown[]) {
            retryOps.push({ op: 'evalsha', firstArg: args[0], args });
            return this;
          }),
          exec: vi.fn().mockResolvedValue([
            [null, 'r0'],
            [null, 'r1'],
            [null, 'r2'],
          ]),
        }),
    }) as unknown as Redis;

    const replies = await execPipelineEvalQueueLua(clusterWithPipeline, {
      script,
      calls: [
        { numKeys: 1, args: ['{a}:k'] },
        { numKeys: 1, args: ['{b}:k'] },
        { numKeys: 1, args: ['{c}:k'] },
      ],
    });
    expect(replies).toEqual(['r0', 'r1', 'r2']);
    expect(retryOps.map((r) => r.op)).toEqual(['eval', 'eval', 'eval']);
    expect(retryOps.map((r) => r.args)).toEqual([
      [script, 1, '{a}:k'],
      [script, 1, '{b}:k'],
      [script, 1, '{c}:k'],
    ]);

    // After Cluster NOSCRIPT, preloadedClusterMastersByClient was cleared so ensureQueueLuaLoaded loads all masters again.
    expect(await ensureQueueLuaLoaded(clusterWithPipeline, script)).toBe(expectedSha);
    expect(masterLoadCalls).toEqual(['m1:LOAD', 'm2:LOAD', 'm1:LOAD', 'm2:LOAD']);

    // 3. Single-key evalQueueLua NOSCRIPT -> eval fallback on Cluster still leaves ensureQueueLuaLoaded loading all masters.
    const fallbackScript = 'return redis.call("EXISTS", KEYS[1])';
    const fallbackSha = luaScriptSha1(fallbackScript);
    const fallbackMasterCalls: string[] = [];
    const fallbackCluster = Object.assign(new EventEmitter(), {
      isCluster: true,
      status: 'ready',
      evalsha: vi.fn().mockRejectedValueOnce(new Error('NOSCRIPT No matching script')),
      eval: vi.fn(async () => 1),
      nodes: vi.fn(() => [
        { script: vi.fn(async (op: unknown) => fallbackMasterCalls.push(`m1:${String(op)}`)) },
        { script: vi.fn(async (op: unknown) => fallbackMasterCalls.push(`m2:${String(op)}`)) },
      ]),
    }) as unknown as Redis;
    expect(await evalQueueLua(fallbackCluster, fallbackScript, 1, 'k2')).toBe(1);
    expect(fallbackMasterCalls).toEqual([]);
    expect(await ensureQueueLuaLoaded(fallbackCluster, fallbackScript)).toBe(fallbackSha);
    expect(fallbackMasterCalls).toEqual(['m1:LOAD', 'm2:LOAD']);
  });

  it('catches and logs a throwing drained listener on Worker without triggering an unhandled rejection', async () => {
    const q = new Queue<{ seq: number }, number>('drained-listener-error');
    openQueues.push(q);

    const unhandledRejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const processed: number[] = [];
      let drainedCount = 0;
      const worker = new Worker<{ seq: number }, number>(
        q,
        async (job) => {
          processed.push(job.data.seq);
          return job.data.seq * 10;
        },
        { concurrency: 1 }
      );
      openWorkers.push(worker);

      // Let the constructor's initial empty-queue check settle before attaching the throwing listener.
      await new Promise<void>((resolve) => worker.once('drained', () => resolve()));

      worker.on('drained', () => {
        drainedCount++;
        throw new Error(`drained listener failure #${drainedCount}`);
      });

      const runOneAndWaitDrainedError = async (seq: number) => {
        const completed = new Promise<void>((resolve) => {
          const onCompleted = (job: Job<{ seq: number }, number>) => {
            if (job.data.seq === seq) {
              worker.off('completed', onCompleted);
              resolve();
            }
          };
          worker.on('completed', onCompleted);
        });
        await q.add(`job-${seq}`, { seq });
        await completed;
        await vi.waitFor(() => {
          const logged = errorSpy.mock.calls.filter(
            ([msg]) => typeof msg === 'string' && msg.includes('[Worker:drained-listener-error] Unhandled drained listener error:')
          );
          expect(logged).toHaveLength(seq);
        });
      };

      await runOneAndWaitDrainedError(1);
      // Worker remains functional and handles a subsequent drain safely as well.
      await runOneAndWaitDrainedError(2);

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(processed).toEqual([1, 2]);
      expect(drainedCount).toBe(2);
      expect(unhandledRejections).toEqual([]);
      const loggedDrainedErrors = errorSpy.mock.calls.filter(
        ([msg]) => typeof msg === 'string' && msg.includes('[Worker:drained-listener-error] Unhandled drained listener error:')
      );
      expect(loggedDrainedErrors).toHaveLength(2);
      expect(loggedDrainedErrors[0]?.[1]).toBeInstanceOf(Error);
      expect((loggedDrainedErrors[0]?.[1] as Error).message).toBe('drained listener failure #1');
      expect((loggedDrainedErrors[1]?.[1] as Error).message).toBe('drained listener failure #2');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
