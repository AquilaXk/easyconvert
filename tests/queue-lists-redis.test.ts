import crypto from 'node:crypto';
import Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DistributedBullMQAdapter } from '../src/lib/queue/bullmq-engine';

/**
 * The dead-letter list and the per-user job index of a Redis queue change while other instances write them: a purge counts
 * exactly what it removed, and a listing that drops an id whose job is gone never drops a job queued under that id meanwhile.
 * Each case lets another connection write right after a command of the call under test answers, the moment a second
 * instance could: after the first command of a purge, and after the read of the job of a listing. Like the other Redis suites it runs when REDIS_URL is set.
 */
const REDIS_URL = process.env.REDIS_URL;

/** A connection that, once armed, runs `between` right after the `nth` command from then answers. */
function interleaved(connection: Redis): { client: Redis; arm: (nth: number, between: () => Promise<unknown>) => void } {
  let armed: { left: number; between: () => Promise<unknown> } | undefined;
  const client = new Proxy(connection, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const answer: unknown = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (!armed || !(answer instanceof Promise)) return answer;
        armed.left -= 1;
        if (armed.left > 0) return answer;
        const { between } = armed;
        armed = undefined;
        return answer.then(async (result: unknown) => {
          await between();
          return result;
        });
      };
    },
  });
  return { client, arm: (nth, between) => (armed = { left: nth, between }) };
}

// skip-ok: mode selection. The shards run without REDIS_URL; the Redis-mode CI step (npm run test:redis) sets it and runs this file.
describe.skipIf(!REDIS_URL)('the lists of a Redis queue that other instances write', () => {
  let keyPrefix: string;
  let admin: Redis;
  const connections: Redis[] = [];

  function connection(): Redis {
    const client = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
    connections.push(client);
    return client;
  }

  beforeEach(() => {
    keyPrefix = `queue-lists-${crypto.randomBytes(6).toString('hex')}:`;
    admin = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
  });

  afterEach(async () => {
    while (connections.length > 0) await connections.pop()!.quit();
    const keys = await admin.keys(`${keyPrefix}*`);
    if (keys.length > 0) await admin.del(...keys);
    await admin.quit();
  });

  it('purges the dead letters and answers how many it removed when another instance adds one meanwhile', async () => {
    const writer = new DistributedBullMQAdapter<{ payload: string }, string>('lists', { redisClient: connection(), keyPrefix });
    const job = await writer.add('convert', { payload: 'x' });
    await writer.moveToDlq(job, 'the first failure');
    const purging = interleaved(connection());
    const purger = new DistributedBullMQAdapter<{ payload: string }, string>('lists', { redisClient: purging.client, keyPrefix });

    purging.arm(1, () => writer.moveToDlq(job, 'a failure while the purge runs'));
    const purged = await purger.purgeDlq();

    expect(purged + (await writer.getDlqEntries()).length).toBe(2);
  });

  it('keeps a job queued under the id of a gone job while a listing drops that id', async () => {
    const userId = 'user_lists';
    const writer = new DistributedBullMQAdapter<{ payload: string; userId: string }, string>('lists', { redisClient: connection(), keyPrefix });
    const reusedId = `job_${crypto.randomBytes(4).toString('hex')}`;
    await admin.zadd(writer.getUserJobsKey(userId), Date.now(), reusedId);
    const listing = interleaved(connection());
    const lister = new DistributedBullMQAdapter<{ payload: string; userId: string }, string>('lists', { redisClient: listing.client, keyPrefix });

    listing.arm(2, () => writer.add('convert', { payload: 'again', userId }, { jobId: reusedId }));
    await lister.getJobsByUser(userId);

    expect((await writer.getJobsByUser(userId)).map((job) => job.id)).toEqual([reusedId]);
  });
});
