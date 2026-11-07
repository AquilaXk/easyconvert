import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Queue, Worker, type Job } from '../src/lib/queue/bullmq-engine';
import { attachJobLifecycleListeners } from '../src/lib/queue/conversion-queue';
import { processNodeJob } from '../src/lib/queue/node-processor';
import { dispatchEngine } from '../src/lib/queue/dispatch-engine';
import type { ConversionEnginePort } from '../src/lib/queue/engine-port';
import { UnsupportedOptionError } from '../src/lib/types';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';
import { instruments } from '../src/lib/metrics/instruments';
import { sampleQueues } from '../src/lib/metrics/queue-sampler';
import { reading, resetMetrics } from './helpers/metrics-readings';

/**
 * The worker counts each queue job once, when it ends, by the family of its source and its outcome, and times its last
 * attempt (docs/slo.md). The jobs run through the real worker, node processor and lifecycle listeners; only the cases a
 * real engine cannot be made to produce on demand (a fault, an overrun) use an engine of the test.
 */

const JOB_TIMEOUT_MS = 100;
const WAIT_MS = 20_000;
const CSV = 'name,score\nAlice,100\nBob,95\n';

let queue: Queue<ConversionJobData, ConversionJobResult>;
let worker: Worker<ConversionJobData, ConversionJobResult>;
let engine: ConversionEnginePort;
let queueNumber = 0;

const jobs = (labels: Record<string, string>) => reading('easyconvert_jobs_total', labels);

function jobData(overrides: Partial<ConversionJobData> = {}): ConversionJobData {
  return {
    jobId: `metrics-${queueNumber}`,
    originalFilename: 'scores-private-name.csv',
    sourceFormat: 'csv',
    targetFormat: 'json',
    fileSize: CSV.length,
    inputBufferBase64: Buffer.from(CSV).toString('base64'),
    options: {},
    ...overrides,
  };
}

/** Adds a job and waits until the worker ends it. */
async function run(data: ConversionJobData, opts: { attempts: number; timeout?: number } = { attempts: 1 }): Promise<Job<ConversionJobData, ConversionJobResult>> {
  const ended = new Promise<void>((resolve) => {
    worker.once('completed', () => resolve());
    worker.once('failed', () => resolve());
  });
  const job = await queue.add('convert', data, opts);
  await ended;
  return job;
}

beforeEach(() => {
  resetMetrics();
  engine = dispatchEngine;
  queue = new Queue<ConversionJobData, ConversionJobResult>(`metrics-jobs-${queueNumber++}`);
  worker = new Worker<ConversionJobData, ConversionJobResult>(queue, (job) => processNodeJob(job, engine), { concurrency: 1 });
  attachJobLifecycleListeners(worker);
});

afterEach(async () => {
  await worker.close();
  await queue.close();
});

describe('the counters of the worker', () => {
  it('count a conversion that finished as ok in the family of its source, and time its attempt', async () => {
    await run(jobData());

    expect(await jobs({ family: 'data', outcome: 'ok' })).toBe(1);
    expect(await reading('easyconvert_job_duration_seconds_count', { family: 'data', outcome: 'ok' })).toBe(1);
  }, WAIT_MS);

  it('count a job the service refuses, which is not retried, as refused', async () => {
    engine = { name: 'refusing', convert: () => Promise.reject(new UnsupportedOptionError('Unsupported width "x"')) };

    const job = await run(jobData(), { attempts: 3 });

    expect(job.attemptsMade).toBe(1);
    expect(await jobs({ family: 'data', outcome: 'refused' })).toBe(1);
    expect(await jobs({})).toBe(1);
  }, WAIT_MS);

  it('count a job that failed after its last attempt once, as failed', async () => {
    engine = { name: 'faulty', convert: () => Promise.reject(new Error('the engine fell over')) };

    const job = await run(jobData(), { attempts: 2 });

    expect(job.attemptsMade).toBe(2);
    expect(await jobs({ family: 'data', outcome: 'failed' })).toBe(1);
    expect(await jobs({})).toBe(1);
  }, WAIT_MS);

  it('count a job that ran past its deadline as timed_out', async () => {
    engine = {
      name: 'slow',
      convert: (_input, _source, _target, options) =>
        new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })),
    };

    await run(jobData(), { attempts: 3, timeout: JOB_TIMEOUT_MS });

    expect(await jobs({ family: 'data', outcome: 'timed_out' })).toBe(1);
    expect(await reading('easyconvert_job_duration_seconds_count', { outcome: 'timed_out' })).toBe(1);
  }, WAIT_MS);

  it('count a job whose source the registry does not name under the family unknown', async () => {
    engine = { name: 'faulty', convert: () => Promise.reject(new Error('no')) };

    await run(jobData({ sourceFormat: 'quarterly-report.xyz' }));

    expect(await jobs({ family: 'unknown', outcome: 'failed' })).toBe(1);
    const text = await instruments().registry.metrics();
    expect(text).not.toContain('scores-private-name');
    expect(text).not.toContain('quarterly-report');
  }, WAIT_MS);
});

describe('the gauges of the queues', () => {
  const NOW_OFFSET_MS = 5000;

  it('read the depth of a queue and the wait of its oldest job when sampled, and return to 0 when no job waits', async () => {
    await worker.close();
    const idle = new Queue<ConversionJobData, ConversionJobResult>('metrics-idle');
    const first = await idle.add('convert', jobData());
    const second = await idle.add('convert', jobData());
    const sources = [{ name: 'cpu' as const, jobCounts: () => idle.getJobCounts(), oldestWaitingSince: () => idle.oldestWaitingSince() }];

    await sampleQueues(sources, first.timestamp + NOW_OFFSET_MS);

    expect(await reading('easyconvert_queue_jobs', { queue: 'cpu', state: 'waiting' })).toBe(2);
    expect(await reading('easyconvert_queue_jobs', { queue: 'cpu', state: 'active' })).toBe(0);
    expect(await reading('easyconvert_queue_oldest_waiting_age_seconds', { queue: 'cpu' })).toBeCloseTo(NOW_OFFSET_MS / 1000, 1);

    await idle.cancelJob(first.id);
    await idle.cancelJob(second.id);
    await sampleQueues(sources);
    expect(await reading('easyconvert_queue_jobs', { queue: 'cpu', state: 'waiting' })).toBe(0);
    expect(await reading('easyconvert_queue_oldest_waiting_age_seconds', { queue: 'cpu' })).toBe(0);
    await idle.close();
  });

  it('drop the readings and count the failure when a queue cannot be read, instead of keeping an old depth', async () => {
    const healthy = { name: 'light' as const, jobCounts: () => Promise.resolve({ waiting: 4 }) };
    await sampleQueues([healthy]);
    expect(await reading('easyconvert_queue_jobs', { queue: 'light', state: 'waiting' })).toBe(4);

    await sampleQueues([healthy, { name: 'gpu', jobCounts: () => Promise.reject(new Error('redis down')) }]);

    expect(await reading('easyconvert_queue_jobs')).toBe(0);
    expect(await reading('easyconvert_queue_sample_failures_total')).toBe(1);
  });

  it('give the oldest waiting job of the memory queue, and none for an empty one', async () => {
    const q = new Queue<ConversionJobData, ConversionJobResult>('metrics-oldest');
    expect(await q.oldestWaitingSince()).toBeUndefined();
    const first = await q.add('convert', jobData());
    await q.add('convert', jobData());
    expect(await q.oldestWaitingSince()).toBe(first.timestamp);
    await q.close();
  });
});
