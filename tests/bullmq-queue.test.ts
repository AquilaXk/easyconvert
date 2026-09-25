import { describe, it, expect } from 'vitest';
import { Queue, Worker } from '../src/lib/queue/bullmq-engine';

describe('BullMQ Distributed Task Queue Tests', () => {
  it('enqueues jobs and processes them with worker concurrency', async () => {
    const queue = new Queue<{ num: number }, number>('test-math-queue');
    const processed: number[] = [];

    const worker = new Worker(
      queue,
      async (job) => {
        await job.log(`Starting calculation for input ${job.data.num}`);
        await job.updateProgress(50);
        processed.push(job.data.num);
        await job.updateProgress(100);
        return job.data.num * 2;
      },
      { concurrency: 3 }
    );

    const job1 = await queue.add('calc', { num: 10 });
    const job2 = await queue.add('calc', { num: 20 });

    // Wait for completion
    await new Promise((resolve) => {
      let completedCount = 0;
      worker.on('completed', () => {
        completedCount++;
        if (completedCount === 2) resolve(true);
      });
    });

    expect(job1.state).toBe('completed');
    expect(job1.returnvalue).toBe(20);
    expect(job1.progress).toBe(100);
    expect(job1.logs.length).toBeGreaterThan(0);

    expect(job2.state).toBe('completed');
    expect(job2.returnvalue).toBe(40);

    const counts = await queue.getJobCounts();
    expect(counts.completed).toBe(2);

    await worker.close();
    await queue.close();
  });

  it('retries failed jobs with backoff policy before marking as failed', async () => {
    const queue = new Queue<{ fail: boolean }, string>('test-retry-queue');
    let attempts = 0;

    const worker = new Worker(
      queue,
      async (job) => {
        attempts++;
        if (job.data.fail) {
          throw new Error('Planned worker exception');
        }
        return 'ok';
      },
      { concurrency: 1 }
    );

    const job = await queue.add(
      'faulty',
      { fail: true },
      { attempts: 2, backoff: { type: 'fixed', delay: 50 } }
    );

    await new Promise((resolve) => {
      worker.on('failed', () => resolve(true));
    });

    expect(job.state).toBe('failed');
    expect(job.attemptsMade).toBe(2);
    expect(job.failedReason).toContain('Planned worker exception');

    await worker.close();
    await queue.close();
  });
});
