import crypto from 'node:crypto';
import Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DistributedBullMQAdapter } from '../src/lib/queue/bullmq-engine';

/**
 * The wait of the oldest waiting job of a Redis queue (the age gauge of docs/slo.md). The waiting set is ordered by priority first,
 * so its head is the best-ranked job, not the one that has waited longest: a job of a low priority that waits behind a stream of
 * better ones is the one to report. Like the other Redis suites it runs when REDIS_URL is set.
 */
const REDIS_URL = process.env.REDIS_URL;
const HIGH_PRIORITY = 1;
const PAUSE_MS = 60;
const SLACK_MS = 40;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// skip-ok: mode selection. The shards run without REDIS_URL; the Redis-mode CI step (npm run test:redis) sets it and runs this file.
describe.skipIf(!REDIS_URL)('the oldest waiting job of a Redis queue', () => {
  let keyPrefix: string;
  let admin: Redis;
  let queue: DistributedBullMQAdapter<{ payload: string }, string>;

  beforeEach(() => {
    keyPrefix = `oldest-waiting-${crypto.randomBytes(6).toString('hex')}:`;
    admin = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
    queue = new DistributedBullMQAdapter('oldest', { redisClient: new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 }), keyPrefix });
  });

  afterEach(async () => {
    await queue.close();
    const keys = await admin.keys(`${keyPrefix}*`);
    if (keys.length > 0) await admin.del(...keys);
    await admin.quit();
  });

  it('is undefined while nothing waits', async () => {
    expect(await queue.oldestWaitingSince()).toBeUndefined();
  });

  it('is when the first job began to wait, in a queue of one priority', async () => {
    const first = await queue.add('convert', { payload: 'a' });
    await pause(PAUSE_MS);
    await queue.add('convert', { payload: 'b' });

    const since = await queue.oldestWaitingSince();

    expect(since).toBeGreaterThanOrEqual(first.timestamp - SLACK_MS);
    expect(since).toBeLessThanOrEqual(first.timestamp + SLACK_MS);
  });

  it('is the job that waited longest, also when a better-ranked job that came later heads the waiting set', async () => {
    const old = await queue.add('convert', { payload: 'old, default priority' });
    await pause(PAUSE_MS);
    const newer = await queue.add('convert', { payload: 'new, high priority' }, { priority: HIGH_PRIORITY });
    expect((await queue.getJobs(['waiting'])).map((job) => job.id)).toEqual([newer.id, old.id]);

    const since = await queue.oldestWaitingSince();

    expect(since).toBeLessThan(newer.timestamp - PAUSE_MS / 2);
    expect(since).toBeGreaterThanOrEqual(old.timestamp - SLACK_MS);
  });

  it('does not count a delayed job', async () => {
    await queue.add('convert', { payload: 'later' }, { delay: 60_000 });

    expect(await queue.oldestWaitingSince()).toBeUndefined();
  });
});
