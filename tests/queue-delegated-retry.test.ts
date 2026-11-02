import { afterEach, describe, expect, it, vi } from 'vitest';
import { Worker } from '../src/lib/queue/bullmq-engine';
import { allConversionQueues, getJobAcrossQueues, resourceQueues } from '../src/lib/queue/conversion-queue';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';

// The queues pick Redis or this process when they are first imported.
vi.hoisted(() => {
  vi.stubEnv('REDIS_URL', '');
  vi.stubEnv('REDIS_HOST', '');
});

/**
 * A worker of every queue takes the jobs of the resource queues through the default queue, which delegates its pops to
 * them. A job taken that way is retried by the queue that holds it, so its next attempt runs.
 */
describe('a resource queue job taken through the default queue', () => {
  let worker: Worker<ConversionJobData, ConversionJobResult> | undefined;

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
  });

  it('runs its next attempt after a retryable failure', async () => {
    const attempts: number[] = [];
    worker = new Worker<ConversionJobData, ConversionJobResult>(
      [...allConversionQueues] as never,
      async (job) => {
        attempts.push(job.attemptsMade);
        if (job.attemptsMade < 2) throw new Error('the connection to the engine dropped');
        return { jobId: job.id, status: 'completed' } as ConversionJobResult;
      },
      { concurrency: 1 }
    );

    const job = await resourceQueues.light.add(
      'retried',
      { jobId: '', originalFilename: 'scores.csv', sourceFormat: 'csv', targetFormat: 'json', fileSize: 30, options: {}, resourceClass: 'light' },
      { attempts: 2, backoff: { type: 'fixed', delay: 20 } }
    );

    await vi.waitFor(async () => expect((await getJobAcrossQueues(job.id))?.state).toBe('completed'), { timeout: 3_000, interval: 20 });
    expect(attempts).toEqual([1, 2]);
  });
});
