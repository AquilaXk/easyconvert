import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { Queue, Worker, JobTimeoutError, type Job } from '../src/lib/queue/bullmq-engine';
import { processNodeJob } from '../src/lib/queue/node-processor';
import {
  allConversionQueues,
  attachJobLifecycleListeners,
  conversionQueue,
} from '../src/lib/queue/conversion-queue';
import { enqueueGraphNodeJob } from '../src/lib/queue/graph/node-jobs';
import { graphScheduler } from '../src/lib/queue/graph';
import { legacyJobTimeoutMs } from '../src/lib/queue/enqueue';
import { JOB_DEADLINE_AT, bindJobLimits, clampToJobRemaining, remainingJobMs, stageTimeoutMs } from '../src/lib/conversions/job-time';
import { TIER_PAGE_CAP, withTierPageCap } from '../src/lib/conversions/page-range';
import type { ConversionEnginePort, EngineResult } from '../src/lib/queue/engine-port';
import { executeSandboxedBinary } from '../src/lib/security/process-sandbox';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { s3Storage } from '../src/lib/storage/s3-storage';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';

/**
 * Review findings on the job deadline: the engines keep their own stage limits (clamped to the time the job has
 * left), request options cannot supply the signal or a timeout, a graph node that hits its deadline fails the
 * graph, a processor that ignores the abort keeps its worker slot, a retry never outlives the job's deadline, and
 * a job queued without a timeout gets the maximum of its owner's tier.
 */

const OK_RESULT: EngineResult = {
  buffer: Buffer.from('[]'),
  size: 2,
  mimeType: 'application/json',
  filename: 'ok.json',
  engineUsed: 'fake',
};

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextEvent(emitter: EventEmitter, event: string): Promise<unknown[]> {
  return new Promise((resolve) => emitter.once(event, (...args: unknown[]) => resolve(args)));
}

async function waitUntil(condition: () => boolean | Promise<boolean>, limitMs: number): Promise<boolean> {
  const stop = Date.now() + limitMs;
  while (Date.now() < stop) {
    if (await condition()) return true;
    await pause(25);
  }
  return condition();
}

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

const queues: Array<Queue<ConversionJobData, ConversionJobResult>> = [];
const workers: Worker<ConversionJobData, ConversionJobResult>[] = [];

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.close();
  for (const queue of queues.splice(0)) await queue.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('stage limits keep their defaults and are clamped to the time the job has left', () => {
  const NOW = 1_000_000;
  const FORTY_FIVE_S = 45_000;

  it('is exactly the stage default when the conversion has no job deadline', () => {
    expect(stageTimeoutMs({}, FORTY_FIVE_S, NOW)).toBe(FORTY_FIVE_S);
    expect(stageTimeoutMs(undefined, FORTY_FIVE_S, NOW)).toBe(FORTY_FIVE_S);
  });

  it('keeps the stage default while the job has more time left than the stage needs', () => {
    expect(stageTimeoutMs({ [JOB_DEADLINE_AT]: NOW + 3_600_000 }, FORTY_FIVE_S, NOW)).toBe(FORTY_FIVE_S);
    expect(stageTimeoutMs({ [JOB_DEADLINE_AT]: NOW + FORTY_FIVE_S }, FORTY_FIVE_S, NOW)).toBe(FORTY_FIVE_S);
  });

  it('is the remaining job time when that is shorter than the stage default', () => {
    expect(stageTimeoutMs({ [JOB_DEADLINE_AT]: NOW + 12_000 }, FORTY_FIVE_S, NOW)).toBe(12_000);
    expect(stageTimeoutMs({ [JOB_DEADLINE_AT]: NOW + FORTY_FIVE_S - 1 }, FORTY_FIVE_S, NOW)).toBe(FORTY_FIVE_S - 1);
  });

  it('is one millisecond, never zero or negative, once the deadline has passed', () => {
    expect(stageTimeoutMs({ [JOB_DEADLINE_AT]: NOW }, FORTY_FIVE_S, NOW)).toBe(1);
    expect(stageTimeoutMs({ [JOB_DEADLINE_AT]: NOW - 500 }, FORTY_FIVE_S, NOW)).toBe(1);
  });

  it('honours a server-set stage override and clamps it too', () => {
    expect(stageTimeoutMs({ timeoutMs: 5_000 }, FORTY_FIVE_S, NOW)).toBe(5_000);
    expect(stageTimeoutMs({ timeoutMs: 5_000, [JOB_DEADLINE_AT]: NOW + 2_000 }, FORTY_FIVE_S, NOW)).toBe(2_000);
  });

  it('clamps any limit the same way and reports the remaining time', () => {
    expect(clampToJobRemaining({ [JOB_DEADLINE_AT]: NOW + 30_000 }, 60_000, NOW)).toBe(30_000);
    expect(clampToJobRemaining({}, 60_000, NOW)).toBe(60_000);
    expect(remainingJobMs({ [JOB_DEADLINE_AT]: NOW + 7 }, NOW)).toBe(7);
    expect(remainingJobMs({}, NOW)).toBeUndefined();
  });

  it('leaves no engine reading the job deadline as a stage limit: every stage default goes through stageTimeoutMs', () => {
    const root = path.resolve(__dirname, '..', 'src');
    const files = ['worker/engines.ts', 'worker/libreoffice-pool.ts', 'lib/conversions/archive.ts', 'lib/conversions/media.ts'];
    const raw = /options\.timeoutMs\s*(\|\||\?\?)|,\s*options\.timeoutMs\s*\)/;
    for (const file of files) {
      const text = fs.readFileSync(path.join(root, file), 'utf8');
      const offenders = text.split('\n').filter((line) => raw.test(line));
      expect(offenders, file).toEqual([]);
    }
  });
});

describe('request options cannot supply the signal, a timeout or a deadline', () => {
  const jobSignal = new AbortController().signal;

  it.each([
    ['a JSON object as signal', { signal: {} }],
    ['an object that looks like a signal', { signal: { aborted: false } }],
    ['a string as signal', { signal: 'abort' }],
    ['a client timeoutMs', { timeoutMs: 999_999_999 }],
    ['a deadlineAt', { deadlineAt: 1 }],
    ['other deadline keys in any case', { deadline: 1, DeadlineMs: 2, deadline_at: 3 }],
  ])('drops %s and installs the job signal', (_label, request) => {
    const bound = bindJobLimits({ ...request, quality: 80 } as object, { signal: jobSignal, deadlineAt: 123 }) as Record<
      PropertyKey,
      unknown
    >;
    expect(bound.signal).toBe(jobSignal);
    for (const key of ['timeoutMs', 'deadlineAt', 'deadline', 'DeadlineMs', 'deadline_at']) {
      expect(Object.hasOwn(bound, key), key).toBe(false);
    }
    expect(bound.quality).toBe(80);
    expect(bound[JOB_DEADLINE_AT]).toBe(123);
  });

  it('keeps the symbol-keyed tier page cap that server code set', () => {
    const bound = bindJobLimits(withTierPageCap({ quality: 80 }, 50), { signal: jobSignal }) as unknown as Record<PropertyKey, unknown>;
    expect(bound[TIER_PAGE_CAP]).toBe(50);
  });

  it('combines a genuine AbortSignal from server code with the job signal', () => {
    const own = new AbortController();
    const job = new AbortController();
    const bound = bindJobLimits({ signal: own.signal }, { signal: job.signal });
    expect(bound.signal).not.toBe(own.signal);
    expect(bound.signal.aborted).toBe(false);
    job.abort(new Error('job'));
    expect(bound.signal.aborted).toBe(true);

    const own2 = new AbortController();
    const job2 = new AbortController();
    const bound2 = bindJobLimits({ signal: own2.signal }, { signal: job2.signal });
    own2.abort(new Error('own'));
    expect(bound2.signal.aborted).toBe(true);
  });

  it('uses the job signal as it is when the caller passes the same signal', () => {
    const job = new AbortController();
    expect(bindJobLimits({ signal: job.signal }, { signal: job.signal }).signal).toBe(job.signal);
  });

  it('does not mutate the request options', () => {
    const request = { signal: {}, timeoutMs: 5, quality: 1 };
    bindJobLimits(request, { signal: jobSignal });
    expect(request).toEqual({ signal: {}, timeoutMs: 5, quality: 1 });
  });
});

/** An engine that runs a real child (shell plus sleeper) under the options' signal, or ignores everything. */
function hangingEngine(mode: 'child' | 'deaf', seen: Array<Record<string, unknown>> = [], pids: number[][] = []): ConversionEnginePort {
  return {
    name: `hang-${mode}`,
    async convert(_input, _src, _tgt, options, originalFilename) {
      seen.push({ filename: originalFilename, ...(options as Record<string, unknown>) });
      if (!originalFilename.startsWith('hang-')) return OK_RESULT;
      if (mode === 'deaf') return new Promise<EngineResult>(() => undefined);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-deadline-review-'));
      try {
        const run = executeSandboxedBinary(
          '/bin/sh',
          ['-c', '/bin/sleep 600 & echo $! > sleeper.pid; echo $$ > shell.pid; wait'],
          { cwd: dir, timeoutMs: 600_000, networkIsolated: false, signal: options.signal }
        );
        await waitUntil(() => fs.existsSync(path.join(dir, 'sleeper.pid')) && fs.existsSync(path.join(dir, 'shell.pid')), 5_000);
        const read = (file: string) => Number(fs.readFileSync(path.join(dir, file), 'utf8').trim());
        pids.push([read('shell.pid'), read('sleeper.pid')]);
        return await run.then(() => OK_RESULT);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

function startWorker(name: string, engine: ConversionEnginePort, opts: Record<string, unknown> = {}) {
  const queue = new Queue<ConversionJobData, ConversionJobResult>(name);
  const worker = new Worker<ConversionJobData, ConversionJobResult>(
    queue,
    (job: Job<ConversionJobData, ConversionJobResult>) => processNodeJob(job, engine, s3Storage),
    { concurrency: 1, ...opts }
  );
  queues.push(queue);
  workers.push(worker);
  return { queue, worker };
}

describe('a job whose request options carry a signal is still stopped at its deadline', () => {
  it.each([
    ['an empty object', {}],
    ['an object with aborted false', { aborted: false }],
  ])('with %s as the signal option', async (_label, fakeSignal) => {
    const seen: Array<Record<string, unknown>> = [];
    const pids: number[][] = [];
    const { queue, worker } = startWorker('review-signal', hangingEngine('child', seen, pids));
    const failed = nextEvent(worker, 'failed');
    await queue.add(
      'convert',
      jobData('hang-1', { options: { signal: fakeSignal, timeoutMs: 999_999_999 } as never }),
      { attempts: 1, timeout: 400 }
    );
    const [, err] = (await failed) as [unknown, unknown];
    expect(err).toBeInstanceOf(JobTimeoutError);
    expect(seen).toHaveLength(1);
    expect(seen[0].signal).toBeInstanceOf(AbortSignal);
    expect(seen[0].timeoutMs).toBeUndefined();
    expect(typeof seen[0][JOB_DEADLINE_AT as unknown as string]).toBe('number');
    expect(pids).toHaveLength(1);
    expect(await waitUntil(() => pids[0].every((pid) => !isAlive(pid)), 4_000)).toBe(true);
  }, 15_000);

  it('gives every engine call a job deadline and no timeoutMs', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { queue, worker } = startWorker('review-no-timeoutms', hangingEngine('child', seen));
    const done = nextEvent(worker, 'completed');
    const before = Date.now();
    await queue.add('convert', jobData('plain'), { attempts: 1, timeout: 9_000 });
    await done;
    expect(seen[0].timeoutMs).toBeUndefined();
    const deadlineAt = seen[0][JOB_DEADLINE_AT as unknown as string] as number;
    expect(deadlineAt).toBeGreaterThanOrEqual(before + 9_000 - 50);
    expect(deadlineAt).toBeLessThanOrEqual(Date.now() + 9_000);
  });
});

describe('a processor that ignores the abort keeps its worker slot', () => {
  it('does not start the next job until the aborted processor settles', async () => {
    const release: { fn?: () => void } = {};
    const order: string[] = [];
    const engine: ConversionEnginePort = {
      name: 'stuck',
      async convert(_input, _src, _tgt, _options, originalFilename) {
        order.push(`start:${originalFilename}`);
        if (originalFilename.startsWith('hang-')) {
          await new Promise<void>((resolve) => {
            release.fn = resolve;
          });
        }
        return OK_RESULT;
      },
    };
    const { queue, worker } = startWorker('review-straggler', engine);
    const failed = nextEvent(worker, 'failed');
    await queue.add('convert', jobData('hang-2'), { attempts: 1, timeout: 150 });
    const next = await queue.add('convert', jobData('after-2'), { attempts: 1, timeout: 5_000 });
    await failed;
    await pause(400);
    // The queue job failed, but the processor still runs, so the single slot is still taken.
    expect(order).toEqual(['start:hang-2.csv']);
    expect((await queue.getJob(next.id))?.state).toBe('waiting');

    const completed = nextEvent(worker, 'completed');
    release.fn?.();
    await completed;
    expect(order).toEqual(['start:hang-2.csv', 'start:after-2.csv']);
  }, 15_000);

  it('emits stuck once the processor is still unsettled after the configured time, and not before', async () => {
    const engine: ConversionEnginePort = {
      name: 'never',
      convert: () => new Promise<EngineResult>(() => undefined),
    };
    const { queue, worker } = startWorker('review-stuck', engine, { stuckProcessorMs: 300 });
    const stuck: number[] = [];
    const startedAt = Date.now();
    worker.on('stuck', () => stuck.push(Date.now() - startedAt));
    const failed = nextEvent(worker, 'failed');
    await queue.add('convert', jobData('hang-3'), { attempts: 1, timeout: 100 });
    await failed;
    await pause(150);
    expect(stuck).toEqual([]);
    expect(await waitUntil(() => stuck.length === 1, 2_000)).toBe(true);
    expect(stuck[0]).toBeGreaterThanOrEqual(100 + 300 - 50);
  }, 10_000);

  it('does not emit stuck for a processor that settles after the abort', async () => {
    const release: { fn?: () => void } = {};
    const engine: ConversionEnginePort = {
      name: 'late',
      convert: () => new Promise<EngineResult>((resolve) => {
        release.fn = () => resolve(OK_RESULT);
      }),
    };
    const { queue, worker } = startWorker('review-late', engine, { stuckProcessorMs: 400 });
    const stuck: unknown[] = [];
    worker.on('stuck', (job) => stuck.push(job));
    const failed = nextEvent(worker, 'failed');
    await queue.add('convert', jobData('hang-4'), { attempts: 1, timeout: 100 });
    await failed;
    release.fn?.();
    await pause(700);
    expect(stuck).toEqual([]);
  }, 10_000);
});

describe('a retry never outlives the deadline of the job', () => {
  it('fails at once, without running the processor, when the deadline has passed by the time of the retry', async () => {
    let calls = 0;
    const queue = new Queue<ConversionJobData, ConversionJobResult>('review-retry-past');
    queues.push(queue);
    const worker = new Worker<ConversionJobData, ConversionJobResult>(
      queue,
      async () => {
        calls++;
        await pause(150);
        throw new Error('transient');
      },
      { concurrency: 1 }
    );
    workers.push(worker);
    const failed = nextEvent(worker, 'failed');
    const job = await queue.add('convert', jobData('retry'), { attempts: 3, backoff: { type: 'fixed', delay: 200 }, timeout: 250 });
    const [, err] = (await failed) as [unknown, unknown];
    expect(err).toBeInstanceOf(JobTimeoutError);
    expect(calls).toBe(1);
    const final = await queue.getJob(job.id);
    expect(final?.state).toBe('failed');
    expect(final?.failedCode).toBe('JobTimeoutError');
  }, 10_000);

  it('runs the retry with only the time that is left', async () => {
    const budgets: number[] = [];
    const queue = new Queue<ConversionJobData, ConversionJobResult>('review-retry-left');
    queues.push(queue);
    const worker = new Worker<ConversionJobData, ConversionJobResult>(
      queue,
      async (job) => {
        budgets.push((job.opts.deadlineAt as number) - Date.now());
        if (budgets.length === 1) {
          await pause(300);
          throw new Error('transient');
        }
        return { jobId: job.id, status: 'completed' } as ConversionJobResult;
      },
      { concurrency: 1 }
    );
    workers.push(worker);
    const done = nextEvent(worker, 'completed');
    await queue.add('convert', jobData('retry2'), { attempts: 2, backoff: { type: 'fixed', delay: 20 }, timeout: 5_000 });
    await done;
    expect(budgets).toHaveLength(2);
    expect(budgets[0]).toBeLessThanOrEqual(5_000);
    expect(budgets[0]).toBeGreaterThan(4_500);
    expect(budgets[1]).toBeLessThan(budgets[0] - 250);
  }, 10_000);

  it('does not count the time a job waits in the queue', async () => {
    const queue = new Queue<ConversionJobData, ConversionJobResult>('review-wait');
    queues.push(queue);
    const job = await queue.add('convert', jobData('waiting'), { attempts: 1, timeout: 300 });
    await pause(450);
    const worker = new Worker<ConversionJobData, ConversionJobResult>(queue, async (j) => ({ jobId: j.id, status: 'completed' } as ConversionJobResult), {
      concurrency: 1,
    });
    workers.push(worker);
    await nextEvent(worker, 'completed');
    expect((await queue.getJob(job.id))?.state).toBe('completed');
  });
});

describe('a job queued without a timeout gets the maximum of its owner tier', () => {
  beforeEach(() => {
    vi.stubEnv('REDIS_URL', '');
    vi.stubEnv('REDIS_HOST', '');
  });

  it('is the tier maximum for an owner of each tier, and the free maximum for an anonymous or unknown owner', async () => {
    const pro = await redisUserStore.createUser({
      email: `legacy_${Date.now()}_${Math.random().toString(36).slice(2, 8)}@deadline.test`,
      name: 'Legacy Pro',
      tier: 'pro',
      provider: 'email',
      passwordHash: 'h',
      salt: 's',
    });
    const forOwner = (userId?: string) => legacyJobTimeoutMs({ data: jobData('x', { userId }) } as never);
    expect(await forOwner(pro.id)).toBe(1_800_000);
    expect(await forOwner('anon:1.2.3.4')).toBe(300_000);
    expect(await forOwner('nobody')).toBe(300_000);
    expect(await forOwner(undefined)).toBe(300_000);
  });

  it('is applied by a worker to a job that was queued before deadlines existed', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const queue = new Queue<ConversionJobData, ConversionJobResult>('review-legacy');
    queues.push(queue);
    const worker = new Worker<ConversionJobData, ConversionJobResult>(
      queue,
      (job) => processNodeJob(job, hangingEngine('deaf', seen), s3Storage),
      { concurrency: 1, defaultTimeoutMs: () => 250 }
    );
    workers.push(worker);
    const failed = nextEvent(worker, 'failed');
    const job = await queue.add('convert', jobData('hang-5'), { attempts: 1 });
    const [, err] = (await failed) as [unknown, unknown];
    expect(err).toBeInstanceOf(JobTimeoutError);
    expect(job.opts.timeout).toBe(250);
    expect(typeof seen[0][JOB_DEADLINE_AT as unknown as string]).toBe('number');
  }, 10_000);
});

describe('a graph node that hits its deadline fails the graph', () => {
  const CSV = 'a,b\n1,2\n';
  let storageKey: string;

  beforeEach(() => {
    vi.stubEnv('REDIS_URL', '');
    vi.stubEnv('REDIS_HOST', '');
    vi.stubEnv('JOB_DEADLINE_BASE_MS_FREE', '100');
    vi.stubEnv('JOB_DEADLINE_MAX_MS_FREE', '400');
    storageKey = `uploads/graph-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.csv`;
    s3Storage.saveObject(storageKey, Buffer.from(CSV), 'text/csv', 'in.csv');
  });

  function startGraphWorker(engine: ConversionEnginePort) {
    const worker = new Worker<ConversionJobData, ConversionJobResult>(
      allConversionQueues as never,
      (job: Job<ConversionJobData, ConversionJobResult>) => processNodeJob(job, engine, s3Storage),
      { concurrency: 2 }
    );
    attachJobLifecycleListeners(worker);
    workers.push(worker);
    return worker;
  }

  async function startGraph(policy: 'fail_fast' | 'continue' = 'fail_fast') {
    const graphId = `deadline_graph_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await graphScheduler.initGraph(
      graphId,
      {
        failurePolicy: policy,
        nodes: {
          up: { op: 'import.upload', storageKey },
          conv: { op: 'convert', input: 'up', targetFormat: 'json' },
          out: { op: 'export.internal', input: 'conv' },
        },
      } as never,
      { originalFilename: 'in.csv' }
    );
    return graphId;
  }

  it('records the node failed and settles the graph even when the engine never returns', async () => {
    const engine: ConversionEnginePort = { name: 'deaf-graph', convert: () => new Promise<EngineResult>(() => undefined) };
    startGraphWorker(engine);
    const failedSpy = vi.spyOn(graphScheduler, 'onNodeFailed');
    const graphId = await startGraph();

    expect(await waitUntil(async () => (await graphScheduler.getGraphState(graphId))?.status === 'failed', 5_000)).toBe(true);
    const state = await graphScheduler.getGraphState(graphId);
    expect(state?.nodes.conv.status).toBe('failed');
    expect(state?.nodes.conv.error).toContain('timed out');
    expect(failedSpy.mock.calls.filter(([, nodeId]) => nodeId === 'conv').length).toBeGreaterThanOrEqual(1);
  }, 15_000);

  it('never marks a node completed when its engine returns after the abort', async () => {
    const release: { fn?: () => void } = {};
    const engine: ConversionEnginePort = {
      name: 'late-graph',
      convert: () =>
        new Promise<EngineResult>((resolve) => {
          release.fn = () => resolve(OK_RESULT);
        }),
    };
    startGraphWorker(engine);
    const completedSpy = vi.spyOn(graphScheduler, 'onNodeCompleted');
    const graphId = await startGraph('continue');

    expect(await waitUntil(async () => (await graphScheduler.getGraphState(graphId))?.nodes.conv?.status === 'failed', 5_000)).toBe(true);
    release.fn?.();
    await pause(500);
    expect(completedSpy.mock.calls.filter(([, nodeId]) => nodeId === 'conv')).toEqual([]);
    expect((await graphScheduler.getGraphState(graphId))?.nodes.conv.status).toBe('failed');
  }, 15_000);

  it('hands a node engine the job signal even when the node options carry a signal and a timeout', async () => {
    const seen: Array<Record<string, unknown>> = [];
    startGraphWorker({
      name: 'capture-graph',
      convert: async (_input, _src, _tgt, options) => {
        seen.push(options as Record<string, unknown>);
        return OK_RESULT;
      },
    });
    const graphId = `deadline_graph_opts_${Date.now()}`;
    await graphScheduler.initGraph(
      graphId,
      {
        failurePolicy: 'fail_fast',
        nodes: {
          up: { op: 'import.upload', storageKey },
          conv: { op: 'convert', input: 'up', targetFormat: 'json', options: { signal: {}, timeoutMs: 999_999_999, deadline: 1 } },
          out: { op: 'export.internal', input: 'conv' },
        },
      } as never,
      { originalFilename: 'in.csv' }
    );
    expect(await waitUntil(() => seen.length === 1, 5_000)).toBe(true);
    expect(seen[0].signal).toBeInstanceOf(AbortSignal);
    expect(seen[0].timeoutMs).toBeUndefined();
    expect(Object.hasOwn(seen[0], 'deadline')).toBe(false);
    expect(typeof seen[0][JOB_DEADLINE_AT as unknown as string]).toBe('number');
  }, 15_000);

  it('bounds the whole graph by the tier maximum counted from the graph start, not per node', async () => {
    vi.stubEnv('JOB_DEADLINE_MAX_MS_FREE', '600000');
    const startedAt = Date.now() - 100_000;
    await enqueueGraphNodeJob(
      'graph_clock',
      'a',
      { op: 'convert', input: 'up', targetFormat: 'json' } as never,
      { createdAt: startedAt },
      []
    );
    const job = await conversionQueue.getJob('graph_clock:a');
    expect(job?.opts.timeout).toBe(600_000);
    expect(job?.opts.deadlineAt).toBe(startedAt + 600_000);
  });

  it('fails a node at once when the graph deadline has already passed', async () => {
    vi.stubEnv('JOB_DEADLINE_MAX_MS_FREE', '600000');
    let calls = 0;
    startGraphWorker({
      name: 'count',
      convert: async () => {
        calls++;
        return OK_RESULT;
      },
    });
    await enqueueGraphNodeJob(
      'graph_expired',
      'a',
      { op: 'convert', input: 'up', targetFormat: 'json' } as never,
      { createdAt: Date.now() - 700_000 },
      []
    );
    expect(await waitUntil(async () => (await conversionQueue.getJob('graph_expired:a'))?.state === 'failed', 5_000)).toBe(true);
    expect((await conversionQueue.getJob('graph_expired:a'))?.failedCode).toBe('JobTimeoutError');
    expect(calls).toBe(0);
  }, 10_000);
});

describe('quota of a job that ran past its deadline (QA decision 2026-10-10: only successful conversions are charged)', () => {
  function fakeWorker(): EventEmitter {
    const worker = new EventEmitter();
    attachJobLifecycleListeners(worker as never);
    return worker;
  }

  async function failWith(error: unknown): Promise<{ committed: string[]; rolledBack: string[] }> {
    const committed: string[] = [];
    const rolledBack: string[] = [];
    vi.spyOn(redisKeyStore, 'commitQuota').mockImplementation(async (id: string) => {
      committed.push(id);
      return true;
    });
    vi.spyOn(redisKeyStore, 'rollbackQuota').mockImplementation(async (id: string) => {
      rolledBack.push(id);
      return true;
    });
    const worker = fakeWorker();
    const done = new Promise((resolve) => setTimeout(resolve, 100));
    worker.emit('failed', { id: 'j1', data: { reservationId: 'res_1' }, attemptsMade: 1, opts: { attempts: 1 } }, error);
    await done;
    return { committed, rolledBack };
  }

  it('is refunded: the deadline rolls the reservation back and commits nothing', async () => {
    expect(await failWith(new JobTimeoutError(1000))).toEqual({ committed: [], rolledBack: ['res_1'] });
  });

  it('is refunded for any other failure too', async () => {
    expect(await failWith(new Error('boom'))).toEqual({ committed: [], rolledBack: ['res_1'] });
  });
});
