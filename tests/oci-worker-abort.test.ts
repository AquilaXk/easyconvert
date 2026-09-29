import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import { ociWorker } from '../src/worker/index';
import { conversionQueue } from '../src/lib/queue/conversion-queue';
import { s3Storage } from '../src/lib/storage/s3-storage';
import type { Job } from '../src/lib/queue/bullmq-engine';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';

const CSV_INPUT = 'name,score\nAlice,100\nBob,95\n';
// Delay each job briefly so the test can instrument it before the OCI worker picks it up.
const PICKUP_DELAY_MS = 20;
// Progress the OCI processor reports after loading the input and after converting it.
const INPUT_LOADED_PROGRESS = 30;
const CONVERTED_PROGRESS = 75;

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

async function addCsvJob(options: ConversionJobData['options'] = {}) {
  const input = Buffer.from(CSV_INPUT, 'utf-8');
  return conversionQueue.add(
    'convert',
    {
      jobId: `oci_abort_${Date.now()}`,
      originalFilename: 'scores.csv',
      sourceFormat: 'csv',
      targetFormat: 'json',
      fileSize: input.length,
      options,
      inputBufferBase64: input.toString('base64'),
    },
    { attempts: 1, delay: PICKUP_DELAY_MS }
  );
}

/** Pauses the processor right after it reports `progress`, until the returned gate is released. */
function pauseAt(job: Job<ConversionJobData, ConversionJobResult>, progress: number) {
  const reached = createGate();
  const resume = createGate();
  const originalUpdateProgress = job.updateProgress.bind(job);
  job.updateProgress = async (value: number) => {
    await originalUpdateProgress(value);
    if (value === progress) {
      reached.release();
      await resume.promise;
    }
  };
  return { reached: reached.promise, resume: resume.release };
}

function resultWritesFor(jobId: string, ...spies: { mock: { calls: unknown[][] } }[]): unknown[][] {
  return spies.flatMap((spy) => spy.mock.calls.filter(([key]) => String(key).startsWith(`results/${jobId}/`)));
}

describe('OCI worker processor honours the attempt abort signal', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await ociWorker.close();
  });

  it('stores the converted result when the attempt is not aborted', async () => {
    const saveSpy = vi.spyOn(s3Storage, 'saveObject');
    const saveFromFileSpy = vi.spyOn(s3Storage, 'saveObjectFromFile');
    const completed = nextEvent(ociWorker, 'completed');
    const job = await addCsvJob();

    const [, result] = (await completed) as [unknown, ConversionJobResult];

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
    const job = await addCsvJob();
    const paused = pauseAt(job, INPUT_LOADED_PROGRESS);

    await paused.reached;
    const drained = nextEvent(ociWorker, 'drained');
    expect(await conversionQueue.cancelJob(job.id, 'client cancelled')).toBe(true);
    paused.resume();
    await drained;

    expect((await conversionQueue.getJob(job.id))?.state).toBe('cancelled');
    expect(job.logs.some((line) => line.includes('Conversion completed'))).toBe(false);
    expect(resultWritesFor(job.id, saveSpy, saveFromFileSpy)).toEqual([]);
  });

  it('stores nothing and discards the output file when cancelled after the conversion', async () => {
    const saveSpy = vi.spyOn(s3Storage, 'saveObject');
    const saveFromFileSpy = vi.spyOn(s3Storage, 'saveObjectFromFile');
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oci-abort-'));
    const outputPath = path.join(outputDir, 'scores.json');
    const job = await addCsvJob({ outputPath } as ConversionJobData['options']);
    const paused = pauseAt(job, CONVERTED_PROGRESS);

    await paused.reached;
    expect(JSON.parse(fs.readFileSync(outputPath, 'utf-8'))).toEqual([
      { name: 'Alice', score: '100' },
      { name: 'Bob', score: '95' },
    ]);
    const drained = nextEvent(ociWorker, 'drained');
    expect(await conversionQueue.cancelJob(job.id, 'client cancelled')).toBe(true);
    paused.resume();
    await drained;

    expect((await conversionQueue.getJob(job.id))?.state).toBe('cancelled');
    expect(job.logs.some((line) => line.includes('Conversion completed'))).toBe(true);
    expect(job.logs.some((line) => line.includes('Output saved'))).toBe(false);
    expect(resultWritesFor(job.id, saveSpy, saveFromFileSpy)).toEqual([]);
    expect(fs.existsSync(outputPath)).toBe(false);
    fs.rmSync(outputDir, { recursive: true, force: true });
  });
});
