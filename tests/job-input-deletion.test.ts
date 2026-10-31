import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Queue, type Job } from '../src/lib/queue/bullmq-engine';
import { attachInputCleanupOnCompletion, attachJobCancellationListeners, processConversionJob } from '../src/lib/queue/conversion-queue';
import { dispatchEngine } from '../src/lib/queue/dispatch-engine';
import { InMemoryGraphScheduler } from '../src/lib/queue/graph/in-memory-scheduler';
import { initGraphHoldingInputs } from '../src/lib/queue/graph/input-cleanup';
import { s3Storage } from '../src/lib/storage/s3-storage';
import { FileRetentionLedger, setRetentionLedger } from '../src/lib/storage/retention-ledger';
import { restoreIsolatedRetentionLedger } from './helpers/isolated-retention-ledger';
import { holdResultForJob, recordServed, registerResult, releaseResultHold, sweepRetention, withInputHeld } from '../src/lib/storage/retention-service';
import { enqueueConversionJob } from '../src/lib/queue/enqueue';
import { StorageNotFoundError } from '../src/lib/storage/adapters/adapter-interface';
import {
  endUploadUse,
  holdRecord,
  JOB_INPUT_HOLD_MAX_MS,
  newUploadRecord,
  resolveRetentionPolicy,
  type RetentionRecord,
} from '../src/lib/storage/result-retention';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';

/**
 * An uploaded input is held for every job or graph that reads it and goes, after the grace period of a delivered
 * result, once the last of them ended, was cancelled or failed for the last time. It is kept while a retry may still run.
 */

const CSV_INPUT = 'name,score\nAlice,100\nBob,95\n';
const ATTEMPTS = 3;

const storedKeys: string[] = [];
const POLICY = resolveRetentionPolicy({});
let ledgerDir: string;

beforeEach(() => {
  ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-input-holds-'));
  setRetentionLedger(new FileRetentionLedger(ledgerDir));
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreIsolatedRetentionLedger();
  fs.rmSync(ledgerDir, { recursive: true, force: true });
  for (const key of storedKeys.splice(0)) s3Storage.deleteObject(key);
});

const afterGrace = () => Date.now() + POLICY.deliveredGraceMs + 1000;
const beforeGraceEnds = () => Date.now() + POLICY.deliveredGraceMs - 1000;

/** Runs the sweep at the time the grace period of the last job has passed. */
async function sweepAfterGrace(): Promise<number> {
  return sweepRetention(s3Storage, afterGrace());
}

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
    const job = await enqueueConversionJob(queue, 'convert', jobData(key), { attempts: ATTEMPTS }, {});
    vi.spyOn(dispatchEngine, 'convert').mockRejectedValue(new Error('disk hiccup'));

    job.attemptsMade = 1;
    await expect(processConversionJob(job)).rejects.toThrow('disk hiccup');
    expect(await sweepAfterGrace()).toBe(0);
    expect(s3Storage.getObject(key)?.buffer.toString('utf-8')).toBe(CSV_INPUT);

    job.attemptsMade = ATTEMPTS;
    await expect(processConversionJob(job)).rejects.toThrow('disk hiccup');
    expect(await sweepRetention(s3Storage, beforeGraceEnds())).toBe(0);
    expect(await sweepAfterGrace()).toBe(1);
    expect(s3Storage.getObject(key)).toBeUndefined();
    await queue.close();
  });

  it('goes when the job is cancelled before it ran', async () => {
    const key = storeUpload('cancel');
    const queue = new Queue<ConversionJobData, ConversionJobResult>('input-deletion-cancel');
    attachJobCancellationListeners(queue);
    const job = await enqueueConversionJob(queue, 'convert', jobData(key), { attempts: ATTEMPTS }, {});
    expect(await sweepAfterGrace()).toBe(0);
    expect(s3Storage.getObject(key)).toBeDefined();

    expect(await queue.cancelJob(job.id, 'Cancelled by user')).toBe(true);

    await vi.waitFor(async () => {
      await sweepAfterGrace();
      expect(s3Storage.getObject(key)).toBeUndefined();
    });
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
    await initGraphHoldingInputs(scheduler, graphId, twoNodes(key), {});

    await scheduler.onNodeStarted(graphId, 'src');
    const first = await scheduler.onNodeCompleted(graphId, 'src', [key]);
    expect(first.graphCompleted).toBe(false);
    expect(await sweepAfterGrace()).toBe(0);
    expect(s3Storage.getObject(key)).toBeDefined();

    const last = await scheduler.onNodeCompleted(graphId, 'out', ['intermediate/none/out.json']);
    expect(last.graphCompleted).toBe(true);
    expect(await sweepAfterGrace()).toBe(1);
    expect(s3Storage.getObject(key)).toBeUndefined();
  });

  it('goes when a node fails the graph', async () => {
    const key = storeUpload('graph-failed');
    const scheduler = new InMemoryGraphScheduler();
    const graphId = newGraphId();
    await initGraphHoldingInputs(scheduler, graphId, twoNodes(key), {});

    const failure = await scheduler.onNodeFailed(graphId, 'src', 'boom');

    expect(failure.graphFailed).toBe(true);
    expect(await sweepAfterGrace()).toBe(1);
    expect(s3Storage.getObject(key)).toBeUndefined();
  });

  it('goes when the graph is cancelled', async () => {
    const key = storeUpload('graph-cancelled');
    const scheduler = new InMemoryGraphScheduler();
    const graphId = newGraphId();
    await initGraphHoldingInputs(scheduler, graphId, twoNodes(key), {});

    expect(await scheduler.cancelGraph(graphId)).toBe(true);

    expect(await sweepAfterGrace()).toBe(1);
    expect(s3Storage.getObject(key)).toBeUndefined();
  });

  it('is kept by a graph that never held it, to its own lifetime', async () => {
    const key = storeUpload('graph-unheld');
    const scheduler = new InMemoryGraphScheduler();
    const graphId = newGraphId();
    await scheduler.initGraph(graphId, twoNodes(key));

    expect(await scheduler.cancelGraph(graphId)).toBe(true);

    expect(await sweepAfterGrace()).toBe(0);
    expect(s3Storage.getObject(key)).toBeDefined();
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
  const deleted: string[] = [];
  const storage = { deleteObject: async (key: string) => (deleted.push(key), true) };

  afterEach(() => {
    deleted.length = 0;
  });

  async function deliveredResult(): Promise<string> {
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

describe('an upload that several jobs convert to different formats', () => {
  async function endJob(worker: EventEmitter, job: Job<ConversionJobData, ConversionJobResult>): Promise<void> {
    worker.emit('completed', job);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  it('converts for every job, one after the other and at the same time, and goes after the last one ends', async () => {
    const key = storeUpload('shared');
    const queue = new Queue<ConversionJobData, ConversionJobResult>('input-deletion-shared');
    const worker = new EventEmitter();
    attachInputCleanupOnCompletion(worker as never);
    const enqueue = (label: string) => enqueueConversionJob(queue, 'convert', jobData(key), { jobId: `shared_${label}_${crypto.randomBytes(4).toString('hex')}` }, {});
    const [first, second, third] = [await enqueue('a'), await enqueue('b'), await enqueue('c')];

    const firstResult = await processConversionJob(first);
    await endJob(worker, first);
    expect(firstResult.resultKey).toBeDefined();
    expect(s3Storage.getObject(key)).toBeDefined();
    expect(await sweepAfterGrace()).toBe(0);

    const [secondResult, thirdResult] = await Promise.all([processConversionJob(second), processConversionJob(third)]);
    expect(secondResult.resultKey).toBeDefined();
    expect(thirdResult.resultKey).toBeDefined();
    await endJob(worker, second);
    expect(s3Storage.getObject(key)).toBeDefined();
    expect(await sweepAfterGrace()).toBe(0);

    await endJob(worker, third);
    expect(await sweepRetention(s3Storage, beforeGraceEnds())).toBe(0);
    expect(s3Storage.getObject(key)).toBeDefined();
    expect(await sweepAfterGrace()).toBe(1);
    expect(s3Storage.getObject(key)).toBeUndefined();
    await queue.close();
  });

  it('starts the grace period again whenever a later job ends, so an upload is never deleted sooner than the rule says', async () => {
    const MINUTE_MS = 60_000;
    const key = storeUpload('grace-restart');
    const start = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(start);
      expect(await holdResultForJob(key, 'job-a')).toBe(true);
      await releaseResultHold(key, 'job-a');

      vi.setSystemTime(start + 8 * MINUTE_MS);
      expect(await holdResultForJob(key, 'job-b')).toBe(true);
      vi.setSystemTime(start + 8 * MINUTE_MS + 5000);
      await releaseResultHold(key, 'job-b');

      expect(await sweepRetention(s3Storage, start + 11 * MINUTE_MS)).toBe(0);
      expect(s3Storage.getObject(key)).toBeDefined();
      expect(await sweepRetention(s3Storage, start + 8 * MINUTE_MS + 5000 + POLICY.deliveredGraceMs + 1000)).toBe(1);
      expect(s3Storage.getObject(key)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('is not kept past its longest lifetime by the grace period of a late job', () => {
    const created = 1_000_000;
    const record = newUploadRecord('uploads/late.csv', created);
    const held = holdRecord(record, 'job-late', created + JOB_INPUT_HOLD_MAX_MS - 5 * 60_000) as RetentionRecord;
    const ended = endUploadUse(held, 'job-late', created + JOB_INPUT_HOLD_MAX_MS - 5 * 60_000, POLICY) as RetentionRecord;

    expect(ended.deleteAt).toBe(created + JOB_INPUT_HOLD_MAX_MS);
  });

  it('stays to its own lifetime when a job that held it could not be queued', async () => {
    const key = storeUpload('unqueued');
    await expect(withInputHeld(key, 'job-unqueued', () => Promise.reject(new Error('queue down')))).rejects.toThrow('queue down');

    expect(await sweepAfterGrace()).toBe(0);
    expect(s3Storage.getObject(key)).toBeDefined();
  });

  it('is not freed for the other job when the end of one job is reported twice', async () => {
    const key = storeUpload('twice');
    expect(await holdResultForJob(key, 'job-a')).toBe(true);
    expect(await holdResultForJob(key, 'job-b')).toBe(true);

    await releaseResultHold(key, 'job-a');
    await releaseResultHold(key, 'job-a');

    expect(await sweepAfterGrace()).toBe(0);
    expect(s3Storage.getObject(key)).toBeDefined();
    await releaseResultHold(key, 'job-b');
    expect(await sweepAfterGrace()).toBe(1);
    expect(s3Storage.getObject(key)).toBeUndefined();
  });
});
