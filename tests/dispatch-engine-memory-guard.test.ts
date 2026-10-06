import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { processNodeJob, nativeEngine, type ConversionEnginePort } from '../src/lib/queue/node-processor';
import { dispatchEngine } from '../src/lib/queue/dispatch-engine';
import { Queue } from '../src/lib/queue/bullmq-engine';
import { s3Storage } from '../src/lib/storage/s3-storage';
import { globalSharedObjects } from '../src/lib/storage/shared-store';
import { PayloadTooLargeForMemoryError } from '../src/lib/storage/errors';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';

const MEMORY_LIMIT_BYTES = 1024;
const OVERSIZED_BYTES = MEMORY_LIMIT_BYTES * 4;

describe('in-memory size guard applies to every engine', () => {
  let queue: Queue<ConversionJobData, ConversionJobResult>;
  let previousLimit: string | undefined;

  beforeEach(() => {
    queue = new Queue<ConversionJobData, ConversionJobResult>('test-dispatch-memory-guard-queue');
    globalSharedObjects.clear();
    previousLimit = process.env.MAX_IN_MEMORY_BYTES;
    process.env.MAX_IN_MEMORY_BYTES = String(MEMORY_LIMIT_BYTES);
  });

  afterEach(() => {
    if (previousLimit === undefined) {
      delete process.env.MAX_IN_MEMORY_BYTES;
    } else {
      process.env.MAX_IN_MEMORY_BYTES = previousLimit;
    }
  });

  function engineThatMustNotRun(): { engine: ConversionEnginePort; calls: () => number } {
    let calls = 0;
    const engine: ConversionEnginePort = {
      name: 'dispatch-engine',
      async convert() {
        calls += 1;
        throw new Error('the engine must not run for an oversized in-memory payload');
      },
    };
    return { engine, calls: () => calls };
  }

  async function base64Job(jobId: string) {
    return queue.add('convert', {
      jobId,
      sourceFormat: 'csv',
      targetFormat: 'json',
      originalFilename: 'big.csv',
      fileSize: OVERSIZED_BYTES,
      inputBufferBase64: Buffer.alloc(OVERSIZED_BYTES, 0x61).toString('base64'),
      options: {},
    });
  }

  it('rejects an oversized base64 payload before the default dispatch engine runs', async () => {
    const job = await base64Job('job_guard_base64_default');
    const run = processNodeJob(job, undefined, s3Storage);
    await expect(run).rejects.toBeInstanceOf(PayloadTooLargeForMemoryError);
    await expect(run).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE_FOR_MEMORY', limit: MEMORY_LIMIT_BYTES });
    await expect(run).rejects.toThrow(/exceeds in-memory buffer limit of 1024 bytes/);
  });

  it('rejects an oversized base64 payload for the native engine adapter', async () => {
    const job = await base64Job('job_guard_base64_native');
    await expect(processNodeJob(job, nativeEngine, s3Storage)).rejects.toBeInstanceOf(PayloadTooLargeForMemoryError);
    expect(nativeEngine).toBe(dispatchEngine);
  });

  it('rejects an oversized base64 payload without invoking the engine', async () => {
    const { engine, calls } = engineThatMustNotRun();
    const job = await base64Job('job_guard_base64_spy');
    await expect(processNodeJob(job, engine, s3Storage)).rejects.toMatchObject({
      name: 'PayloadTooLargeForMemoryError',
      limit: MEMORY_LIMIT_BYTES,
    });
    expect(calls()).toBe(0);
  });

  it('rejects an oversized stored object that is held in memory', async () => {
    const storageKey = 'uploads/guard-big.csv';
    s3Storage.saveObject(storageKey, Buffer.alloc(OVERSIZED_BYTES, 0x61), 'text/csv', 'big.csv');
    const { engine, calls } = engineThatMustNotRun();
    const job = await queue.add('convert', {
      jobId: 'job_guard_storage_memory',
      sourceFormat: 'csv',
      targetFormat: 'json',
      originalFilename: 'big.csv',
      fileSize: OVERSIZED_BYTES,
      storageKey,
      options: {},
    });
    await expect(processNodeJob(job, engine, s3Storage)).rejects.toBeInstanceOf(PayloadTooLargeForMemoryError);
    expect(calls()).toBe(0);
  });
});
