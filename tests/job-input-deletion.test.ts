import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Queue } from '../src/lib/queue/bullmq-engine';
import { attachJobCancellationListeners, processConversionJob } from '../src/lib/queue/conversion-queue';
import { dispatchEngine } from '../src/lib/queue/dispatch-engine';
import { InMemoryGraphScheduler } from '../src/lib/queue/graph/in-memory-scheduler';
import { initGraphHoldingInputs } from '../src/lib/queue/graph/input-cleanup';
import { s3Storage } from '../src/lib/storage/s3-storage';
import { FileRetentionLedger, setRetentionLedger } from '../src/lib/storage/retention-ledger';
import { recordServed, registerResult, sweepRetention, withInputHeld } from '../src/lib/storage/retention-service';
import { enqueueConversionJob } from '../src/lib/queue/enqueue';
import { StorageNotFoundError } from '../src/lib/storage/adapters/adapter-interface';
import { resolveRetentionPolicy } from '../src/lib/storage/result-retention';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';

/**
 * An uploaded input is deleted as soon as nothing can read it any more: when the job ends, is cancelled, or
 * (for a graph) when the graph has ended. It is kept while a retry may still run.
 */

const CSV_INPUT = 'name,score\nAlice,100\nBob,95\n';
const ATTEMPTS = 3;

const storedKeys: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of storedKeys.splice(0)) s3Storage.deleteObject(key);
});

function storeUpload(label: string): string {
  const key = `uploads/input-deletion-${label}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.csv`;
  s3Storage.saveObject(key, Buffer.from(CSV_INPUT, 'utf-8'), 'text/csv', 'scores.csv');
  storedKeys.push(key);
  return key;
}

function jobData(storageKey: string): ConversionJobData {
  return {
    jobId: '',
    originalFilename: 'scores.csv',
    sourceFormat: 'csv',
    targetFormat: 'json',
    fileSize: CSV_INPUT.length,
    options: {},
    storageKey,
  };
}

describe('the input of a single job', () => {
  it('stays while a retry is pending and goes with the final failed attempt', async () => {
    const key = storeUpload('retry');
    const queue = new Queue<ConversionJobData, ConversionJobResult>('input-deletion-retry');
    const job = await queue.add('convert', jobData(key), { attempts: ATTEMPTS });
    vi.spyOn(dispatchEngine, 'convert').mockRejectedValue(new Error('disk hiccup'));

    job.attemptsMade = 1;
    await expect(processConversionJob(job)).rejects.toThrow('disk hiccup');
    expect(s3Storage.getObject(key)?.buffer.toString('utf-8')).toBe(CSV_INPUT);

    job.attemptsMade = ATTEMPTS;
    await expect(processConversionJob(job)).rejects.toThrow('disk hiccup');
    expect(s3Storage.getObject(key)).toBeUndefined();
    await queue.close();
  });

  it('goes when the job is cancelled before it ran', async () => {
    const key = storeUpload('cancel');
    const queue = new Queue<ConversionJobData, ConversionJobResult>('input-deletion-cancel');
    attachJobCancellationListeners(queue);
    const job = await queue.add('convert', jobData(key), { attempts: ATTEMPTS });
    expect(s3Storage.getObject(key)).toBeDefined();

    expect(await queue.cancelJob(job.id, 'Cancelled by user')).toBe(true);

    await vi.waitFor(() => expect(s3Storage.getObject(key)).toBeUndefined());
    await queue.close();
  });

  it('keeps an owner\'s earlier output that was chained as the input of a cancelled job', async () => {
    const key = `conversions/user-1/${Date.now()}_chained.csv`;
    s3Storage.saveObject(key, Buffer.from(CSV_INPUT, 'utf-8'), 'text/csv', 'chained.csv');
    storedKeys.push(key);
    const queue = new Queue<ConversionJobData, ConversionJobResult>('input-deletion-chained');
    attachJobCancellationListeners(queue);
    const job = await queue.add('convert', jobData(key), { attempts: ATTEMPTS });

    expect(await queue.cancelJob(job.id, 'Cancelled by user')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(s3Storage.getObject(key)).toBeDefined();
    await queue.close();
  });
});

describe('the uploaded input of a graph', () => {
  function newGraphId(): string {
    return `g_input_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  }

  const twoNodes = (uploadKey: string) => ({
    nodes: {
      src: { op: 'import.upload' as const, storageKey: uploadKey },
      out: { op: 'convert' as const, input: 'src', targetFormat: 'json' },
    },
  });

  it('is kept while a node can still read it and goes when the graph completes', async () => {
    const key = storeUpload('graph-complete');
    const scheduler = new InMemoryGraphScheduler();
    const graphId = newGraphId();
    await scheduler.initGraph(graphId, twoNodes(key));

    await scheduler.onNodeStarted(graphId, 'src');
    const first = await scheduler.onNodeCompleted(graphId, 'src', [key]);
    expect(first.graphCompleted).toBe(false);
    expect(s3Storage.getObject(key)).toBeDefined();

    const last = await scheduler.onNodeCompleted(graphId, 'out', ['intermediate/none/out.json']);
    expect(last.graphCompleted).toBe(true);
    expect(s3Storage.getObject(key)).toBeUndefined();
  });

  it('goes when a node fails the graph', async () => {
    const key = storeUpload('graph-failed');
    const scheduler = new InMemoryGraphScheduler();
    const graphId = newGraphId();
    await scheduler.initGraph(graphId, twoNodes(key));

    const failure = await scheduler.onNodeFailed(graphId, 'src', 'boom');

    expect(failure.graphFailed).toBe(true);
    expect(s3Storage.getObject(key)).toBeUndefined();
  });

  it('goes when the graph is cancelled', async () => {
    const key = storeUpload('graph-cancelled');
    const scheduler = new InMemoryGraphScheduler();
    const graphId = newGraphId();
    await scheduler.initGraph(graphId, twoNodes(key));

    expect(await scheduler.cancelGraph(graphId)).toBe(true);

    expect(s3Storage.getObject(key)).toBeUndefined();
  });

  it('leaves an owner\'s earlier output used as the graph input alone', async () => {
    const key = `results/some-job/${Date.now()}_earlier.csv`;
    s3Storage.saveObject(key, Buffer.from(CSV_INPUT, 'utf-8'), 'text/csv', 'earlier.csv');
    storedKeys.push(key);
    const scheduler = new InMemoryGraphScheduler();
    const graphId = newGraphId();
    await scheduler.initGraph(graphId, twoNodes(key));

    expect(await scheduler.cancelGraph(graphId)).toBe(true);

    expect(s3Storage.getObject(key)).toBeDefined();
  });
});

describe('the hold on an owner\'s earlier output chained as a job input', () => {
  const POLICY = resolveRetentionPolicy({});
  let ledgerDir: string;
  const deleted: string[] = [];
  const storage = { deleteObject: async (key: string) => (deleted.push(key), true) };

  afterEach(() => {
    deleted.length = 0;
    setRetentionLedger(undefined);
    if (ledgerDir) fs.rmSync(ledgerDir, { recursive: true, force: true });
  });

  async function deliveredResult(): Promise<string> {
    ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-hold-'));
    setRetentionLedger(new FileRetentionLedger(ledgerDir));
    const key = `conversions/user-1/${Date.now()}_${crypto.randomBytes(4).toString('hex')}_chained.csv`;
    await registerResult(key);
    await recordServed(key, { first: 0, last: 9, size: 10 });
    return key;
  }

  const afterUndelivered = () => Date.now() + POLICY.undeliveredTtlMs + 1000;

  it('lasts while the job is queued and ends when the job is cancelled', async () => {
    const key = await deliveredResult();
    const queue = new Queue<ConversionJobData, ConversionJobResult>('input-hold-cancel');
    attachJobCancellationListeners(queue);
    const jobId = `hold_${crypto.randomBytes(4).toString('hex')}`;
    const job = await enqueueConversionJob(queue, 'convert', jobData(key), { jobId, attempts: ATTEMPTS }, {});
    expect(job.id).toBe(jobId);
    expect(await sweepRetention(storage, afterUndelivered())).toBe(0);

    expect(await queue.cancelJob(jobId, 'Cancelled by user')).toBe(true);

    await vi.waitFor(async () => expect(await sweepRetention(storage, afterUndelivered())).toBe(1));
    expect(deleted).toEqual([key]);
    await queue.close();
  });

  it('lasts while a graph that reads it runs and ends when the graph ends', async () => {
    const key = await deliveredResult();
    const scheduler = new InMemoryGraphScheduler();
    const graphId = `g_hold_${crypto.randomBytes(4).toString('hex')}`;
    await initGraphHoldingInputs(scheduler, graphId, {
      nodes: {
        src: { op: 'import.upload' as const, storageKey: key },
        out: { op: 'convert' as const, input: 'src', targetFormat: 'json' },
      },
    }, {});
    expect(await sweepRetention(storage, afterUndelivered())).toBe(0);

    expect(await scheduler.cancelGraph(graphId)).toBe(true);

    expect(await sweepRetention(storage, afterUndelivered())).toBe(1);
  });

  it('is given up when the job cannot be queued, and refuses an input deleted before the job was queued', async () => {
    const key = await deliveredResult();
    await expect(withInputHeld(key, 'job-refused', () => Promise.reject(new Error('queue down')))).rejects.toThrow('queue down');
    expect(await sweepRetention(storage, afterUndelivered())).toBe(1);

    const start = vi.fn(async () => 'queued');
    await expect(withInputHeld(key, 'job-late', start)).rejects.toBeInstanceOf(StorageNotFoundError);
    expect(start).not.toHaveBeenCalled();
  });
});
