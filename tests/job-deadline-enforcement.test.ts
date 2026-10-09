import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { Queue, Worker, JobTimeoutError, type Job } from '../src/lib/queue/bullmq-engine';
import { processNodeJob } from '../src/lib/queue/node-processor';
import { classifyJobFailure, isFinalFailure } from '../src/lib/queue/job-failure';
import { deadlineBoundEngine } from '../src/lib/queue/job-deadline';
import type { ConversionEnginePort, EngineResult } from '../src/lib/queue/engine-port';
import { executeSandboxedBinary } from '../src/lib/security/process-sandbox';
import { s3Storage } from '../src/lib/storage/s3-storage';
import { ConversionFailedError } from '../src/lib/types';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';

/**
 * A job that never ends is stopped at its deadline: the attempt's signal fires, the sandboxed process group is
 * killed, the engine's temporary directory is removed, the job fails with a typed error that is not retried,
 * and the worker takes the next job. The engine is a real child process, so liveness is read from the operating
 * system (`process.kill(pid, 0)`), not from a flag the test sets.
 */

const DEADLINE_MS = 400;
const JOB_FAIL_BOUND_MS = 4_000;
const POLL_MS = 25;
const HTTP_GATEWAY_TIMEOUT = 504;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextEvent(emitter: EventEmitter, event: string): Promise<unknown[]> {
  return new Promise((resolve) => {
    emitter.once(event, (...args: unknown[]) => resolve(args));
  });
}

async function waitUntil(condition: () => boolean, limitMs: number): Promise<boolean> {
  const stop = Date.now() + limitMs;
  while (Date.now() < stop) {
    if (condition()) return true;
    await pause(POLL_MS);
  }
  return condition();
}

/** True while the operating system still has a process with this id. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function jobData(name: string, overrides: Partial<ConversionJobData> = {}): ConversionJobData {
  const input = Buffer.from('a,b\n1,2\n', 'utf-8');
  return {
    jobId: name,
    originalFilename: `${name}.csv`,
    sourceFormat: 'csv',
    targetFormat: 'json',
    fileSize: input.length,
    options: {},
    inputBufferBase64: input.toString('base64'),
    ...overrides,
  };
}

interface Started {
  dir: string;
  shellPid: number;
  sleeperPid: number;
}

const OK_RESULT: EngineResult = {
  buffer: Buffer.from('[{"a":1,"b":2}]'),
  size: 15,
  mimeType: 'application/json',
  filename: 'ok.json',
  engineUsed: 'fake',
};

/**
 * An engine whose conversion of "hang-*" files never ends: it runs a shell that starts a `sleep` and waits for
 * it, inside a temporary directory the engine removes when it stops. Every other file converts at once.
 */
function createFakeEngine() {
  const seen: Array<{ filename: string; options: Record<string, unknown> }> = [];
  const started: Started[] = [];
  const abortReasons: unknown[] = [];
  const startedEvent = new EventEmitter();

  const engine: ConversionEnginePort = {
    name: 'fake-engine',
    async convert(_input, _src, _tgt, options, originalFilename) {
      seen.push({ filename: originalFilename, options: options as Record<string, unknown> });
      if (!originalFilename.startsWith('hang-')) return OK_RESULT;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-deadline-'));
      try {
        const run = executeSandboxedBinary(
          '/bin/sh',
          ['-c', '/bin/sleep 600 & echo $! > sleeper.pid; echo $$ > shell.pid; wait'],
          { cwd: dir, timeoutMs: 600_000, networkIsolated: false, signal: options.signal }
        );
        const ready = await waitUntil(
          () => fs.existsSync(path.join(dir, 'sleeper.pid')) && fs.existsSync(path.join(dir, 'shell.pid')),
          5_000
        );
        if (!ready) throw new Error('the child process did not start');
        const read = (file: string) => Number(fs.readFileSync(path.join(dir, file), 'utf8').trim());
        const info: Started = { dir, shellPid: read('shell.pid'), sleeperPid: read('sleeper.pid') };
        started.push(info);
        startedEvent.emit('started', info);
        options.signal?.addEventListener('abort', () => abortReasons.push(options.signal?.reason), { once: true });
        return await run.then(() => OK_RESULT);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  };
  return { engine, seen, started, abortReasons, startedEvent };
}

const queues: Array<Queue<ConversionJobData, ConversionJobResult>> = [];
const workers: Worker<ConversionJobData, ConversionJobResult>[] = [];

function startWorker(name: string, engine: ConversionEnginePort) {
  const queue = new Queue<ConversionJobData, ConversionJobResult>(name);
  const worker = new Worker<ConversionJobData, ConversionJobResult>(
    queue,
    (job: Job<ConversionJobData, ConversionJobResult>) => processNodeJob(job, engine, s3Storage),
    { concurrency: 1 }
  );
  queues.push(queue);
  workers.push(worker);
  return { queue, worker };
}

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.close();
  for (const queue of queues.splice(0)) await queue.close();
});

describe('a job that never ends', () => {
  it('is killed at its deadline: process group gone, temp directory removed, typed error, no retry', async () => {
    const fake = createFakeEngine();
    const { queue, worker } = startWorker('deadline-kill', fake.engine);
    const failed = nextEvent(worker, 'failed');
    const startedAt = Date.now();
    const job = await queue.add('convert', jobData('hang-1'), {
      attempts: 3,
      backoff: { type: 'fixed', delay: 5 },
      timeout: DEADLINE_MS,
    });

    const [info] = (await nextEvent(fake.startedEvent, 'started')) as [Started];
    // The oracle works: both processes of the group are alive while the job runs.
    expect(isAlive(info.shellPid)).toBe(true);
    expect(isAlive(info.sleeperPid)).toBe(true);
    expect(fs.existsSync(info.dir)).toBe(true);

    const [failedJob, err] = (await failed) as [{ id: string }, unknown];
    expect(Date.now() - startedAt).toBeLessThan(DEADLINE_MS + JOB_FAIL_BOUND_MS);
    expect(failedJob.id).toBe(job.id);
    expect(err).toBeInstanceOf(JobTimeoutError);
    expect((err as JobTimeoutError).timeoutMs).toBe(DEADLINE_MS);

    expect(await waitUntil(() => !isAlive(info.shellPid) && !isAlive(info.sleeperPid), JOB_FAIL_BOUND_MS)).toBe(true);
    expect(await waitUntil(() => !fs.existsSync(info.dir), JOB_FAIL_BOUND_MS)).toBe(true);

    const final = await queue.getJob(job.id);
    expect(final?.state).toBe('failed');
    expect(final?.attemptsMade).toBe(1);
    expect(final?.failedCode).toBe('JobTimeoutError');
    expect(final?.failedStatus).toBe(HTTP_GATEWAY_TIMEOUT);
    expect(final?.failedReason).toBe(`Job timed out after ${DEADLINE_MS}ms`);
    expect(fake.seen.filter((call) => call.filename === 'hang-1.csv')).toHaveLength(1);
    expect(fake.abortReasons).toHaveLength(1);
    expect(fake.abortReasons[0]).toBeInstanceOf(JobTimeoutError);
  }, 15_000);

  it('frees the worker slot: the next job on the same worker completes', async () => {
    const fake = createFakeEngine();
    const { queue, worker } = startWorker('deadline-next', fake.engine);
    const failed = nextEvent(worker, 'failed');
    const completed = nextEvent(worker, 'completed');
    const hung = await queue.add('convert', jobData('hang-2'), { attempts: 1, timeout: DEADLINE_MS });
    const next = await queue.add('convert', jobData('after-2'), { attempts: 1, timeout: 5_000 });

    const [failedJob] = (await failed) as [{ id: string }];
    expect(failedJob.id).toBe(hung.id);
    const [completedJob] = (await completed) as [{ id: string }];
    expect(completedJob.id).toBe(next.id);
    expect((await queue.getJob(next.id))?.state).toBe('completed');
    expect((await queue.getJob(next.id))?.returnvalue?.status).toBe('completed');
  }, 15_000);

  it('fails at the deadline even when the engine ignores the abort signal, and the next job runs', async () => {
    const calls: string[] = [];
    const engine: ConversionEnginePort = {
      name: 'deaf-engine',
      async convert(_input, _src, _tgt, _options, originalFilename) {
        calls.push(originalFilename);
        if (originalFilename.startsWith('hang-')) return new Promise<EngineResult>(() => undefined);
        return OK_RESULT;
      },
    };
    const { queue, worker } = startWorker('deadline-deaf', engine);
    const failed = nextEvent(worker, 'failed');
    const completed = nextEvent(worker, 'completed');
    const hung = await queue.add('convert', jobData('hang-3'), { attempts: 3, timeout: 200 });
    const next = await queue.add('convert', jobData('after-3'), { attempts: 1, timeout: 5_000 });

    const [failedJob, err] = (await failed) as [{ id: string }, unknown];
    expect(failedJob.id).toBe(hung.id);
    expect(err).toBeInstanceOf(JobTimeoutError);
    const [completedJob] = (await completed) as [{ id: string }];
    expect(completedJob.id).toBe(next.id);
    expect(calls).toEqual(['hang-3.csv', 'after-3.csv']);
    expect((await queue.getJob(hung.id))?.attemptsMade).toBe(1);
  }, 15_000);
});

describe('what the converter receives', () => {
  it('gets the job deadline as timeoutMs and the attempt signal, replacing a client-supplied timeoutMs', async () => {
    const fake = createFakeEngine();
    const { queue, worker } = startWorker('deadline-options', fake.engine);
    const completed = nextEvent(worker, 'completed');
    await queue.add('convert', jobData('plain', { options: { timeoutMs: 999_999_999 } }), { attempts: 1, timeout: 7_000 });
    await completed;

    expect(fake.seen).toHaveLength(1);
    expect(fake.seen[0].options.timeoutMs).toBe(7_000);
    expect(fake.seen[0].options.signal).toBeInstanceOf(AbortSignal);
  });

  it('gives every stage of a pipeline the same deadline and a signal', async () => {
    const fake = createFakeEngine();
    const { queue, worker } = startWorker('deadline-stages', fake.engine);
    const completed = nextEvent(worker, 'completed');
    await queue.add(
      'convert',
      jobData('stages', {
        tasks: [
          { name: 'one', operation: 'convert', targetFormat: 'json', options: { timeoutMs: 1 } },
          { name: 'two', operation: 'convert', targetFormat: 'yaml' },
        ],
      }),
      { attempts: 1, timeout: 9_000 }
    );
    await completed;

    expect(fake.seen.map((call) => call.options.timeoutMs)).toEqual([9_000, 9_000]);
    for (const call of fake.seen) expect(call.options.signal).toBeInstanceOf(AbortSignal);
  });

  it('leaves a job that carries no timeout without a timeoutMs of its own', async () => {
    const fake = createFakeEngine();
    const { queue, worker } = startWorker('deadline-legacy', fake.engine);
    const completed = nextEvent(worker, 'completed');
    await queue.add('convert', jobData('legacy'), { attempts: 1 });
    await completed;
    expect(fake.seen[0].options.timeoutMs).toBeUndefined();
  });
});

describe('deadlineBoundEngine', () => {
  it('sets the timeout and the signal on every call and keeps a signal the caller already set', async () => {
    const received: Array<Record<string, unknown>> = [];
    const inner: ConversionEnginePort = {
      name: 'inner',
      async convert(_input, _src, _tgt, options) {
        received.push(options as Record<string, unknown>);
        return OK_RESULT;
      },
    };
    const jobSignal = new AbortController().signal;
    const own = new AbortController().signal;
    const bound = deadlineBoundEngine(inner, { signal: jobSignal, opts: { timeout: 1234 } });
    expect(bound.name).toBe('inner');
    await bound.convert(Buffer.alloc(1), 'csv', 'json', { timeoutMs: 5 }, 'a.csv');
    await bound.convert(Buffer.alloc(1), 'csv', 'json', { signal: own }, 'b.csv');
    expect(received[0].timeoutMs).toBe(1234);
    expect(received[0].signal).toBe(jobSignal);
    expect(received[1].timeoutMs).toBe(1234);
    expect(received[1].signal).toBe(own);
  });

  it('passes the options through unchanged for a job without a timeout', async () => {
    const received: Array<Record<string, unknown>> = [];
    const inner: ConversionEnginePort = {
      name: 'inner',
      async convert(_input, _src, _tgt, options) {
        received.push(options as Record<string, unknown>);
        return OK_RESULT;
      },
    };
    const bound = deadlineBoundEngine(inner, { signal: new AbortController().signal, opts: {} });
    await bound.convert(Buffer.alloc(1), 'csv', 'json', { timeoutMs: 5 }, 'a.csv');
    expect(received[0].timeoutMs).toBe(5);
  });
});

describe('a deadline is a verdict on the job, not a transient fault', () => {
  it('is a typed 504 that is not retried on any attempt', () => {
    const err = new JobTimeoutError(1500);
    expect(err).toBeInstanceOf(ConversionFailedError);
    expect(err.name).toBe('JobTimeoutError');
    expect(err.status).toBe(HTTP_GATEWAY_TIMEOUT);
    expect(err.message).toBe('Job timed out after 1500ms');
    expect(classifyJobFailure(err)).toEqual({ code: 'JobTimeoutError', status: HTTP_GATEWAY_TIMEOUT, retryable: false });
    expect(isFinalFailure({ attemptsMade: 1, opts: { attempts: 3 } }, err)).toBe(true);
  });
});
