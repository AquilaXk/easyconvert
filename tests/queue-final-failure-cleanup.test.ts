import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventEmitter } from 'node:events';
import { Queue, Worker, type Job } from '../src/lib/queue/bullmq-engine';
import { attachInputCleanupOnCompletion, processConversionJob } from '../src/lib/queue/conversion-queue';
import { processGraphNodeJob } from '../src/lib/queue/graph/node-executor';
import { graphScheduler } from '../src/lib/queue/graph';
import { s3Storage } from '../src/lib/storage/s3-storage';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';
import { bombPng } from './helpers/image-bombs';

const ATTEMPTS = 3;
const RETRY_DELAY_MS = 20;
const OVER_LIMIT_SIDE = 15_000;
const ARTIFACT_TTL_MS = 60 * 60 * 1000;

function nextEvent(emitter: EventEmitter, event: string): Promise<unknown[]> {
  return new Promise((resolve) => {
    emitter.once(event, (...args: unknown[]) => resolve(args));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a failure that cannot be retried is a final failure', () => {
  it('removes the uploaded input when a typed rejection ends the job on its first attempt', async () => {
    const inputKey = `uploads/final-failure-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
    s3Storage.saveObject(inputKey, bombPng(OVER_LIMIT_SIDE, OVER_LIMIT_SIDE), 'image/png', 'bomb.png');
    const queue = new Queue<ConversionJobData, ConversionJobResult>('final-failure-input');
    const worker = new Worker(queue, processConversionJob, { concurrency: 1 });
    attachInputCleanupOnCompletion(worker);
    const failed = nextEvent(worker, 'failed');
    const job = await queue.add(
      'convert',
      {
        jobId: '',
        originalFilename: 'bomb.png',
        sourceFormat: 'png',
        targetFormat: 'jpg',
        fileSize: 123,
        options: {},
        storageKey: inputKey,
      },
      { attempts: ATTEMPTS, backoff: { type: 'fixed', delay: RETRY_DELAY_MS } }
    );
    await failed;

    expect(job.attemptsMade).toBe(1);
    expect(job.failedStatus).toBe(413);
    expect(s3Storage.getObject(inputKey)).toBeUndefined();
    await worker.close();
    await queue.close();
  });

  it('removes the input in the processor itself on the first attempt of a typed rejection', async () => {
    const inputKey = `uploads/final-failure-direct-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
    s3Storage.saveObject(inputKey, bombPng(OVER_LIMIT_SIDE, OVER_LIMIT_SIDE), 'image/png', 'bomb.png');
    const queue = new Queue<ConversionJobData, ConversionJobResult>('final-failure-direct');
    const job = await queue.add(
      'convert',
      { jobId: '', originalFilename: 'bomb.png', sourceFormat: 'png', targetFormat: 'jpg', fileSize: 123, options: {}, storageKey: inputKey },
      { attempts: ATTEMPTS }
    );
    job.attemptsMade = 1;

    await expect(processConversionJob(job)).rejects.toMatchObject({ status: 413 });
    expect(s3Storage.getObject(inputKey)).toBeUndefined();
    await queue.close();
  });
});

describe('a graph node fails its graph when a failure cannot be retried', () => {
  function mergeJob(inputKey: string, attemptsMade: number): Job<ConversionJobData, ConversionJobResult> {
    const graphId = `g_final_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return {
      id: `${graphId}:n1`,
      data: {
        jobId: `${graphId}:n1`,
        sourceFormat: 'txt',
        targetFormat: 'pdf',
        fileSize: 0,
        options: {},
        graphId,
        graphNodeId: 'n1',
        graphNode: { op: 'merge', targetFormat: 'pdf' },
        inputArtifacts: [inputKey],
      },
      opts: { attempts: ATTEMPTS },
      attemptsMade,
      signal: new AbortController().signal,
      log: async () => {},
      updateProgress: async () => {},
    } as unknown as Job<ConversionJobData, ConversionJobResult>;
  }

  it('fails the node on the first attempt when the input is rejected for what it is', async () => {
    const key = `tests/final-failure/${Date.now()}_wrong.txt`;
    s3Storage.saveObject(key, Buffer.from('not a pdf'), 'text/plain', 'wrong.txt', ARTIFACT_TTL_MS);
    const failNode = vi.spyOn(graphScheduler, 'onNodeFailed').mockResolvedValue(undefined as never);

    await expect(processGraphNodeJob(mergeJob(key, 1), undefined, s3Storage)).rejects.toThrow(/received a "txt" input/);

    expect(failNode).toHaveBeenCalledTimes(1);
    expect(String(failNode.mock.calls[0][2])).toContain('received a "txt" input');
  });

  it('leaves the node alone on a failure that a retry may cure', async () => {
    const failNode = vi.spyOn(graphScheduler, 'onNodeFailed').mockResolvedValue(undefined as never);

    await expect(processGraphNodeJob(mergeJob('tests/final-failure/missing-artifact', 1), undefined, s3Storage)).rejects.toThrow(
      /not found in storage/
    );

    expect(failNode).not.toHaveBeenCalled();
  });
});
