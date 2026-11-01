import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DistributedBullMQAdapter, Worker, subscribeToJobTelemetry, type Job, type JobTelemetryEvent } from '../src/lib/queue/bullmq-engine';
import { graphScheduler } from '../src/lib/queue/graph';
import { processGraphNodeJob } from '../src/lib/queue/graph/node-executor';
import { InputPixelLimitError } from '../src/lib/conversions/image-input-limits';
import { FAIL_JOB_LUA_SCRIPT } from '../src/lib/queue/lua-scripts';
import type { IStorageBackend } from '../src/lib/storage/oci-storage';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';

/**
 * The failure transition is a Lua script, which only a real Redis server runs: this suite follows the other
 * Redis suites and runs when REDIS_URL is set (for example `REDIS_URL=redis://127.0.0.1:6379`).
 */
const REDIS_URL = process.env.REDIS_URL;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const OVER_LIMIT_SIDE = 15_000;
const INPUT_LIMIT = 100_000_000;
/** A program under the temporary directory, one of the roots a failure reason never names. */
const MISSING_PROGRAM = path.join(os.tmpdir(), 'easyconvert-missing', 'bin', 'magick');
const PUBSUB_SUBSCRIBERS = 2;

// skip-ok: mode selection. The shards run without REDIS_URL; the Redis-mode CI step (npm run test:redis) sets it and runs this file.
describe.skipIf(!REDIS_URL)('typed job failures on a real Redis server', () => {
  let keyPrefix: string;
  let admin: Redis;
  const adapters: DistributedBullMQAdapter<{ payload: string }, string>[] = [];

  function connect(queueName: string): DistributedBullMQAdapter<{ payload: string }, string> {
    const client = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
    const adapter = new DistributedBullMQAdapter<{ payload: string }, string>(queueName, { redisClient: client, keyPrefix });
    adapters.push(adapter);
    return adapter;
  }

  beforeEach(() => {
    keyPrefix = `failure-test-${crypto.randomBytes(6).toString('hex')}:`;
    admin = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    while (adapters.length > 0) await adapters.pop()!.close();
    const keys = await admin.keys(`${keyPrefix}*`);
    if (keys.length > 0) await admin.del(...keys);
    await admin.quit();
  });

  it('stores the failure code and status with the failed state in one script, and hydrates them', async () => {
    const api = connect('typed-failure');
    const workerSide = connect('typed-failure');
    const job = await api.add('convert', { payload: 'x' }, { attempts: 1 });
    const popped = await workerSide._popNextWaiting();
    popped!.attemptsMade = 1;
    const error = new InputPixelLimitError(INPUT_LIMIT, OVER_LIMIT_SIDE, OVER_LIMIT_SIDE);
    popped!.failedReason = error.message;
    popped!.failedCode = error.name;
    popped!.failedStatus = error.status;
    popped!.failedRefusalCode = error.refusalCode;

    expect(await workerSide._onJobFailed(popped!, error)).toBe(true);

    const hash = await admin.hgetall(`${keyPrefix}{typed-failure}:job:${job.id}`);
    expect(hash).toMatchObject({ state: 'failed', failedCode: 'InputPixelLimitError', failedStatus: String(HTTP_PAYLOAD_TOO_LARGE), failedRefusalCode: 'input_over_limit' });

    const stored = await api.getJob(job.id);
    expect(stored).toMatchObject({ state: 'failed', failedCode: 'InputPixelLimitError', failedStatus: HTTP_PAYLOAD_TOO_LARGE, failedRefusalCode: 'input_over_limit' });
    expect(stored?.failedReason).toContain(`over the input limit of ${INPUT_LIMIT} pixels`);
  });

  it('persists the failure code in the same script, so a lost second command cannot drop it', async () => {
    const api = connect('atomic-failure');
    const workerSide = connect('atomic-failure');
    const job = await api.add('convert', { payload: 'x' }, { attempts: 1 });
    const popped = await workerSide._popNextWaiting();
    popped!.attemptsMade = 1;
    popped!.failedReason = 'over the limit';
    popped!.failedCode = 'InputPixelLimitError';
    popped!.failedStatus = HTTP_PAYLOAD_TOO_LARGE;
    // Any write after the script would be lost with the connection; only the script itself may store the code.
    const client = workerSide.getRedisClient() as Redis;
    vi.spyOn(client, 'hset').mockRejectedValue(new Error('connection lost'));

    expect(await workerSide._onJobFailed(popped!, new Error('over the limit'))).toBe(true);

    const hash = await admin.hgetall(`${keyPrefix}{atomic-failure}:job:${job.id}`);
    expect(hash).toMatchObject({ state: 'failed', failedCode: 'InputPixelLimitError', failedStatus: String(HTTP_PAYLOAD_TOO_LARGE) });
  });

  it('writes no code for an untyped failure and leaves the status absent after hydration', async () => {
    const api = connect('untyped-failure');
    const workerSide = connect('untyped-failure');
    const job = await api.add('convert', { payload: 'x' }, { attempts: 1 });
    const popped = await workerSide._popNextWaiting();
    popped!.attemptsMade = 1;
    popped!.failedReason = 'socket hang up';

    expect(await workerSide._onJobFailed(popped!, new Error('socket hang up'))).toBe(true);

    const stored = await api.getJob(job.id);
    expect(stored?.state).toBe('failed');
    expect(stored?.failedCode).toBeUndefined();
    expect(stored?.failedStatus).toBeUndefined();
    expect(stored?.failedRefusalCode).toBeUndefined();
  });

  it('fails a job for a caller that sends no refusal code argument, as an engine from before the field does', async () => {
    const api = connect('nine-arguments');
    const workerSide = connect('nine-arguments');
    const job = await api.add('convert', { payload: 'x' }, { attempts: 1 });
    const popped = await workerSide._popNextWaiting();
    const keys = (suffix: string) => `${keyPrefix}{nine-arguments}:${suffix}`;
    const committed = await admin.eval(
      FAIL_JOB_LUA_SCRIPT,
      4,
      keys(`job:${job.id}`),
      keys('active'),
      keys('failed'),
      keys(`heartbeat:${job.id}`),
      job.id,
      String(Date.now()),
      'over the limit',
      '[]',
      '1',
      '0',
      popped!._attemptToken ?? '',
      'InputPixelLimitError',
      String(HTTP_PAYLOAD_TOO_LARGE)
    );

    expect(committed).toBe(1);
    const hash = await admin.hgetall(keys(`job:${job.id}`));
    expect(hash).toMatchObject({ state: 'failed', failedReason: 'over the limit', failedCode: 'InputPixelLimitError' });
    expect((await api.getJob(job.id))?.failedRefusalCode).toBeUndefined();
  });

  it('publishes the stored, masked reason as the live failed event', async () => {
    const api = connect('live-failure');
    const workerSide = connect('live-failure');
    await vi.waitFor(async () => {
      const [, subscribers] = (await admin.pubsub('NUMSUB', `${keyPrefix}live-failure:events`)) as [string, number];
      expect(subscribers).toBe(PUBSUB_SUBSCRIBERS);
    });
    const job = await api.add('convert', { payload: 'x' }, { attempts: 1 });
    const events: JobTelemetryEvent[] = [];
    const unsubscribe = subscribeToJobTelemetry(api, job.id, (event) => events.push(event));
    const worker = new Worker(workerSide, async () => {
      throw new Error(`spawn ${MISSING_PROGRAM} ENOENT`);
    }, { concurrency: 1 });
    try {
      await vi.waitFor(() => expect(events.map((event) => event.event)).toContain('failed'), { timeout: 10_000 });
    } finally {
      unsubscribe();
      await worker.close();
    }

    const stored = await api.getJob(job.id);
    expect(stored?.failedReason).toBe('spawn *** ENOENT');
    expect(events.find((event) => event.event === 'failed')?.data.error).toBe(stored?.failedReason);
  });
});

describe('a graph node failure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports a reason with the server paths masked to the scheduler', async () => {
    const onNodeFailed = vi.spyOn(graphScheduler, 'onNodeFailed').mockResolvedValue({} as never);
    vi.spyOn(graphScheduler, 'onNodeStarted').mockResolvedValue(undefined as never);
    const storage = {
      providerName: 'test-failing',
      stat: async () => {
        throw new Error(`EACCES: permission denied, stat '${path.join(os.tmpdir(), 'ec-graph', 'in.csv')}'`);
      },
    } as unknown as IStorageBackend;
    const job = {
      id: 'graph-node-path',
      data: { graphId: 'g_path', graphNodeId: 'in', graphNode: { op: 'import.upload', storageKey: 'uploads/x/in.csv' }, inputArtifacts: [], options: {} },
      opts: { attempts: 1 },
      attemptsMade: 1,
      signal: new AbortController().signal,
      log: async () => {},
      updateProgress: async () => {},
    } as unknown as Job<ConversionJobData, ConversionJobResult>;

    await expect(processGraphNodeJob(job, undefined, storage)).rejects.toThrow();

    expect(onNodeFailed).toHaveBeenCalledWith('g_path', 'in', "EACCES: permission denied, stat '***'");
  });
});
