import crypto from 'node:crypto';
import Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DistributedBullMQAdapter } from '../src/lib/queue/bullmq-engine';
import { InputPixelLimitError } from '../src/lib/conversions/image-input-limits';

/**
 * The failure transition is a Lua script, which only a real Redis server runs: this suite follows the other
 * Redis suites and runs when REDIS_URL is set (for example `REDIS_URL=redis://127.0.0.1:6379`).
 */
const REDIS_URL = process.env.REDIS_URL;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const OVER_LIMIT_SIDE = 15_000;
const INPUT_LIMIT = 100_000_000;

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

    expect(await workerSide._onJobFailed(popped!, error)).toBe(true);

    const hash = await admin.hgetall(`${keyPrefix}{typed-failure}:job:${job.id}`);
    expect(hash).toMatchObject({ state: 'failed', failedCode: 'InputPixelLimitError', failedStatus: String(HTTP_PAYLOAD_TOO_LARGE) });

    const stored = await api.getJob(job.id);
    expect(stored).toMatchObject({ state: 'failed', failedCode: 'InputPixelLimitError', failedStatus: HTTP_PAYLOAD_TOO_LARGE });
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
  });
});
