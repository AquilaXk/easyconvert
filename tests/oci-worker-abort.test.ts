import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import { ociWorker, stopHeartbeat } from '../src/worker/index';
import { allConversionQueues, conversionQueue } from '../src/lib/queue/conversion-queue';
import { s3Storage } from '../src/lib/storage/s3-storage';
import { Job } from '../src/lib/queue/bullmq-engine';
import { unregisterLiveWorkerHeartbeat } from '../src/lib/queue/worker-presence';
import { webhookDispatcher } from '../src/lib/api-keys/webhook-dispatcher';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';

const CSV_INPUT = 'name,score\nAlice,100\nBob,95\n';
// Progress the OCI processor reports after loading the input and after converting it.
const INPUT_LOADED_PROGRESS = 35;
const CONVERTED_PROGRESS = 75;

function nextJobId(): string {
  return `oci_abort_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

function nextEvent(emitter: EventEmitter, event: string): Promise<unknown[]> {
  return new Promise((resolve) => {
    emitter.once(event, (...args: unknown[]) => resolve(args));
  });
}

function waitForCompleted(
  emitter: EventEmitter,
  jobId: string
): Promise<[Job<ConversionJobData, ConversionJobResult>, ConversionJobResult]> {
  return new Promise((resolve) => {
    const handler = (job: Job<ConversionJobData, ConversionJobResult>, result: ConversionJobResult) => {
      if (job.id === jobId) {
        emitter.off('completed', handler);
        resolve([job, result]);
      }
    };
    emitter.on('completed', handler);
  });
}

function createGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Pauses the processor right after `jobId` reports `progress`, until the returned gate is released. */
function pauseAt(jobId: string, progress: number) {
  const reached = createGate();
  const resume = createGate();
  const originalUpdateProgress = Job.prototype.updateProgress;
  const spy = vi.spyOn(Job.prototype, 'updateProgress').mockImplementation(async function (
    this: Job<ConversionJobData, ConversionJobResult>,
    value: number
  ) {
    await originalUpdateProgress.call(this, value);
    if (this.id === jobId && value === progress) {
      reached.release();
      await resume.promise;
    }
  });
  return {
    reached: reached.promise,
    resume: resume.release,
    restore: () => spy.mockRestore(),
  };
}

function resultWritesFor(jobId: string, ...spies: { mock: { calls: unknown[][] } }[]): unknown[][] {
  return spies.flatMap((spy) => spy.mock.calls.filter(([key]) => String(key).startsWith(`results/${jobId}/`)));
}

describe('OCI worker processor honours the attempt abort signal', () => {
  const createdJobIds: string[] = [];
  const createdResultKeys: string[] = [];

  async function addCsvJob(jobId: string, options: ConversionJobData['options'] = {}) {
    createdJobIds.push(jobId);
    const input = Buffer.from(CSV_INPUT, 'utf-8');
    return conversionQueue.add(
      'convert',
      {
        jobId,
        originalFilename: 'scores.csv',
        sourceFormat: 'csv',
        targetFormat: 'json',
        fileSize: input.length,
        options,
        inputBufferBase64: input.toString('base64'),
      },
      { jobId, attempts: 1 }
    );
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const key of createdResultKeys.splice(0)) {
      s3Storage.deleteObject(key);
    }
    for (const id of createdJobIds.splice(0)) {
      await conversionQueue.remove(id).catch(() => undefined);
    }
  });

  afterAll(async () => {
    stopHeartbeat();
    await unregisterLiveWorkerHeartbeat();
    await ociWorker.close();
    await webhookDispatcher.close();
    await Promise.all(allConversionQueues.map((q) => q.close()));
    await redisKeyStore.close();
    s3Storage.stopGc();
  });

  it('stores the converted result when the attempt is not aborted', async () => {
    const saveSpy = vi.spyOn(s3Storage, 'saveObject');
    const saveFromFileSpy = vi.spyOn(s3Storage, 'saveObjectFromFile');
    const jobId = nextJobId();
    const completed = waitForCompleted(ociWorker, jobId);
    const job = await addCsvJob(jobId);

    const [, result] = await completed;
    createdResultKeys.push(result.resultKey);

    expect(resultWritesFor(job.id, saveSpy, saveFromFileSpy)).toHaveLength(1);
    expect(JSON.parse(s3Storage.getObject(result.resultKey)!.buffer.toString('utf-8'))).toEqual([
      // CSV cells are untyped text, so the JSON rows keep them as strings.
      { name: 'Alice', score: '100' },
      { name: 'Bob', score: '95' },
    ]);
  });

  it('does not convert when the job is cancelled after the input loads', async () => {
    const saveSpy = vi.spyOn(s3Storage, 'saveObject');
    const saveFromFileSpy = vi.spyOn(s3Storage, 'saveObjectFromFile');
    const jobId = nextJobId();
    const paused = pauseAt(jobId, INPUT_LOADED_PROGRESS);

    try {
      await addCsvJob(jobId);
      await paused.reached;
      expect((await conversionQueue.getJob(jobId))?.progress).toBe(INPUT_LOADED_PROGRESS);
      const drained = nextEvent(ociWorker, 'drained');
      expect(await conversionQueue.cancelJob(jobId, 'client cancelled')).toBe(true);
      paused.resume();
      await drained;

      const finalJob = await conversionQueue.getJob(jobId);
      expect(finalJob?.state).toBe('cancelled');
      expect(finalJob?.progress).toBe(INPUT_LOADED_PROGRESS);
      expect(finalJob?.logs.some((line) => line.includes('Conversion completed'))).toBe(false);
      expect(resultWritesFor(jobId, saveSpy, saveFromFileSpy)).toEqual([]);
    } finally {
      paused.resume();
      paused.restore();
    }
  });

  it('stores nothing and discards the output file when cancelled after the conversion', async () => {
    const saveSpy = vi.spyOn(s3Storage, 'saveObject');
    const saveFromFileSpy = vi.spyOn(s3Storage, 'saveObjectFromFile');
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oci-abort-'));
    const outputPath = path.join(outputDir, 'scores.json');
    const jobId = nextJobId();
    const observedProgress: number[] = [];
    const onProgress = (j: { id?: string }, p: number) => {
      if (j.id === jobId) observedProgress.push(p);
    };
    conversionQueue.on('progress', onProgress);
    const paused = pauseAt(jobId, CONVERTED_PROGRESS);
    try {
      await addCsvJob(jobId, { outputPath } as ConversionJobData['options']);

      await paused.reached;
      expect((await conversionQueue.getJob(jobId))?.progress).toBe(CONVERTED_PROGRESS);
      expect(JSON.parse(fs.readFileSync(outputPath, 'utf-8'))).toEqual([
        { name: 'Alice', score: '100' },
        { name: 'Bob', score: '95' },
      ]);
      const drained = nextEvent(ociWorker, 'drained');
      expect(await conversionQueue.cancelJob(jobId, 'client cancelled')).toBe(true);
      paused.resume();
      await drained;

      const finalJob = await conversionQueue.getJob(jobId);
      expect(finalJob?.state).toBe('cancelled');
      expect(finalJob?.progress).toBe(CONVERTED_PROGRESS);
      expect(finalJob?.logs.some((line) => line.includes('Conversion completed'))).toBe(true);
      expect(finalJob?.logs.some((line) => line.includes('Output saved'))).toBe(false);
      expect(observedProgress).not.toContain(100);
      expect(resultWritesFor(jobId, saveSpy, saveFromFileSpy)).toEqual([]);
      expect(fs.existsSync(outputPath)).toBe(false);
    } finally {
      conversionQueue.off('progress', onProgress);
      paused.resume();
      paused.restore();
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
