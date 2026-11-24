import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Job, Queue, Worker } from '../src/lib/queue/bullmq-engine';
import { conversionQueue, processConversionJob, resourceQueues } from '../src/lib/queue/conversion-queue';
import {
  dispatchSyncArchiveInspection,
  dispatchSyncRouteConversion,
  dispatchSyncWebTool,
} from '../src/lib/queue/wait-for-job';
import * as workerPresence from '../src/lib/queue/worker-presence';
import { storageProvider } from '../src/lib/storage';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';

describe('Queue scheduling fairness, direct targetQueue polling, and progress deduplication', () => {
  const openWorkers: Worker<any, any>[] = [];
  const openQueues: Queue<any, any>[] = [];
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
    if (savedExecMode === undefined) delete process.env.WEB_EXECUTION_MODE;
    else process.env.WEB_EXECUTION_MODE = savedExecMode;
    vi.restoreAllMocks();
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
    expect(chainWrites).toEqual([10, 35, 50, 80, 100]);
  });
});
