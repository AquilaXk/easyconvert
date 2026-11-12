import crypto from 'node:crypto';
import Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisIdempotencyStore } from '../src/lib/api/idempotency';
import { DistributedBullMQAdapter } from '../src/lib/queue/bullmq-engine';
import { forgetUserJobs, removeStoredJob, type QueueKeySpace } from '../src/lib/queue/ended-jobs';
import { ownerOf } from '../src/lib/queue/stored-job';
import { RedisGraphScheduler } from '../src/lib/queue/graph';
import { clearKeysMatching } from '../src/lib/redis/clear-keys';

/**
 * The Redis paths that read or delete many records do it in a few round trips: the erasure of a user's jobs and dead letters, the
 * job listing of a queue, the graphs of a user, and the clearing of a keyspace. Each answer equals the one the one-command-at-a-time
 * path gave. Like the other Redis suites it runs when REDIS_URL is set.
 */
const REDIS_URL = process.env.REDIS_URL;

interface Trips {
  names: string[];
  /** One per command sent alone and one per pipeline. */
  trips: number;
  /** The number of keys each EVAL names. */
  evalKeyCounts: number[];
}

// skip-ok: mode selection. The shards run without REDIS_URL; the Redis-mode CI step (npm run test:redis) sets it and runs this file.
describe.skipIf(!REDIS_URL)('the Redis query paths on a real Redis server', () => {
  let admin: Redis;
  let prefix: string;
  const clients: Redis[] = [];

  beforeEach(() => {
    prefix = `query-paths-${crypto.randomBytes(6).toString('hex')}:`;
    admin = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    while (clients.length > 0) await clients.pop()!.quit();
    const keys = await admin.keys(`${prefix}*`);
    if (keys.length > 0) await admin.del(...keys);
    await admin.quit();
  });

  function connect(): Redis {
    const client = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
    clients.push(client);
    return client;
  }

  /** Records the commands every client but the test's own `admin` sends from now on (a scheduler sends its pipelines through a wrapper of its client). */
  function countTrips(): Trips {
    const tally: Trips = { names: [], trips: 0, evalKeyCounts: [] };
    const seen = new WeakSet<object>();
    const prototype = Redis.prototype as unknown as { sendCommand: (this: unknown, command: { name: string; args: unknown[] }, stream?: object, node?: unknown) => unknown };
    const real = prototype.sendCommand;
    vi.spyOn(prototype, 'sendCommand').mockImplementation(function (this: unknown, command, stream, node) {
      if (this !== admin) {
        tally.names.push(command.name);
        if (command.name === 'eval') tally.evalKeyCounts.push(Number(command.args[1]));
        if (stream === undefined) tally.trips += 1;
        else if (!seen.has(stream)) {
          seen.add(stream);
          tally.trips += 1;
        }
      }
      return real.call(this, command, stream, node);
    });
    return tally;
  }

  describe('forgetUserJobs', () => {
    const USER = 'user_erased';
    const OTHER = 'user_kept';

    function keySpace(space: string): QueueKeySpace {
      return {
        jobKey: (id) => `${space}{q}:job:${id}`,
        userJobsKey: (userId) => `${space}{q}:user_jobs:${userId ?? 'none'}`,
        dlqKey: `${space}{q}:dlq`,
        stateKeys: ['waiting', 'delayed', 'active', 'completed', 'failed', 'cancelled'].map((name) => `${space}{q}:${name}`) as unknown as QueueKeySpace['stateKeys'],
      };
    }

    interface Seed {
      /** Index order is the order of the ids. */
      jobs: { id: string; data?: unknown; state?: string; indexed?: boolean }[];
      letters: string[];
    }

    async function seed(keys: QueueKeySpace, { jobs, letters }: Seed): Promise<void> {
      const pipeline = admin.pipeline();
      jobs.forEach(({ id, data, state }, at) => {
        const fields: string[] = ['id', id];
        if (data !== undefined) fields.push('data', JSON.stringify(data));
        if (state !== undefined) fields.push('state', state);
        pipeline.hset(keys.jobKey(id), ...fields);
        if (state === 'active') pipeline.sadd(keys.stateKeys[2], id);
        if (state === 'completed') pipeline.sadd(keys.stateKeys[3], id);
        if (state === 'waiting') pipeline.zadd(keys.stateKeys[0], String(at), id);
      });
      jobs.forEach(({ id, indexed = true }, at) => {
        if (indexed) pipeline.zadd(keys.userJobsKey(USER), String(at), id);
      });
      for (const raw of letters) pipeline.rpush(keys.dlqKey, raw);
      await pipeline.exec();
    }

    const letter = (jobId: string, owner: string | undefined, extra = ''): string =>
      JSON.stringify({ jobId, name: 'convert', data: owner ? { userId: owner } : {}, failedReason: `failed${extra}`, attemptsMade: 1, timestamp: 1, stacktrace: [] });

    /** The behaviour before the batching, one command at a time: the oracle the batched version must equal. */
    async function forgetOneByOne(client: Redis, keys: QueueKeySpace, userId: string, processed: ReadonlySet<string>): Promise<string[]> {
      const parse = (text: string | null): unknown => {
        try {
          return text ? JSON.parse(text) : undefined;
        } catch {
          return undefined;
        }
      };
      const index = keys.userJobsKey(userId);
      const left: string[] = [];
      for (const id of await client.zrange(index, '0', '-1')) {
        const owner = ownerOf(parse(await client.hget(keys.jobKey(id), 'data')));
        if (owner !== userId) await client.zrem(index, id);
        else if (!processed.has(id) || !(await removeStoredJob(client, keys, id, true))) left.push(id);
      }
      for (const raw of await client.lrange(keys.dlqKey, 0, -1)) {
        const entry = parse(raw) as { jobId?: string; data?: unknown } | undefined;
        if (ownerOf(entry?.data) !== userId) continue;
        const jobId = entry?.jobId ?? '';
        if (processed.has(jobId) || (await client.exists(keys.jobKey(jobId))) === 0) await client.lrem(keys.dlqKey, 0, raw);
      }
      if (left.length === 0) await client.del(index);
      return left;
    }

    /** Every key of the space with its content, the space name left out, so two runs on two spaces compare. */
    async function snapshot(space: string): Promise<Record<string, unknown>> {
      const out: Record<string, unknown> = {};
      for (const key of (await admin.keys(`${space}*`)).sort()) {
        const type = await admin.type(key);
        const name = key.slice(space.length);
        if (type === 'hash') out[name] = await admin.hgetall(key);
        else if (type === 'list') out[name] = await admin.lrange(key, 0, -1);
        else if (type === 'zset') out[name] = await admin.zrange(key, '0', '-1', 'WITHSCORES');
        else if (type === 'set') out[name] = (await admin.smembers(key)).sort();
        else out[name] = type;
      }
      return out;
    }

    async function forgetOnBoth(input: Seed, processed: ReadonlySet<string>) {
      const before = keySpace(`${prefix}before:`);
      const after = keySpace(`${prefix}after:`);
      await seed(before, input);
      await seed(after, input);
      const client = connect();
      const expectedLeft = await forgetOneByOne(client, before, USER, processed);
      const trips = countTrips();
      const left = await forgetUserJobs(client, after, USER, processed);
      return { left, expectedLeft, trips, snapshotBefore: await snapshot(`${prefix}before:`), snapshotAfter: await snapshot(`${prefix}after:`), after };
    }

    it('answers and leaves what the one-command-at-a-time run did, for every kind of job and letter', async () => {
      const input: Seed = {
        jobs: [
          { id: 'done1', data: { userId: USER }, state: 'completed' },
          { id: 'done2', data: { userId: USER }, state: 'completed' },
          { id: 'active', data: { userId: USER }, state: 'active' },
          { id: 'beyond', data: { userId: USER }, state: 'waiting' },
          { id: 'foreign', data: { userId: OTHER }, state: 'completed' },
          { id: 'ghost', indexed: true },
          { id: 'nostate', data: { userId: USER } },
          { id: 'damaged', data: undefined, state: 'completed' },
        ],
        letters: [
          letter('done1', USER),
          letter('done1', undefined),
          letter('done2', USER, '-twice'),
          letter('done2', USER, '-twice'),
          letter('vanished', USER),
          letter('vanished', OTHER),
          letter('foreign', OTHER),
          letter('beyond', USER),
          letter('active', USER),
          letter('active', undefined),
          letter('nostate', undefined),
          'not json at all',
          letter('somebody-else', OTHER),
        ],
      };
      // `ghost` has no hash data at all; `damaged` has none that names a user.
      const processed = new Set(['done1', 'done2', 'active', 'foreign', 'ghost', 'nostate', 'damaged']);

      const { left, expectedLeft, snapshotBefore, snapshotAfter } = await forgetOnBoth(input, processed);

      expect(left).toEqual(expectedLeft);
      expect(left).toEqual(['active', 'beyond', 'nostate']);
      expect(snapshotAfter).toEqual(snapshotBefore);
      // The index stays for the jobs left, and the letters that name the user and a job that is processed or gone are gone.
      const remaining = (snapshotAfter['{q}:dlq'] as string[]).map((raw) => {
        try {
          return `${(JSON.parse(raw) as { jobId: string }).jobId}:${ownerOf((JSON.parse(raw) as { data: unknown }).data) ?? '-'}`;
        } catch {
          return raw;
        }
      });
      expect(remaining).toEqual(['vanished:user_kept', 'foreign:user_kept', 'beyond:user_erased', 'active:-', 'not json at all', 'somebody-else:user_kept']);
    });

    it('removes a user whole, across more jobs and letters than one batch, in a handful of round trips', async () => {
      const jobs = Array.from({ length: 1100 }, (_, n) => ({ id: `job${n}`, data: { userId: USER }, state: n % 7 === 0 ? 'active' : 'completed' }));
      const letters = [
        ...jobs.filter((_, n) => n % 3 === 0).map((job) => letter(job.id, USER)),
        ...Array.from({ length: 600 }, (_, n) => letter(`gone${n}`, USER)),
        ...Array.from({ length: 600 }, (_, n) => letter(`other${n}`, `user_${n % 9}`)),
      ];
      const processed = new Set(jobs.map((job) => job.id));

      const { left, expectedLeft, trips, snapshotBefore, snapshotAfter, after } = await forgetOnBoth({ jobs, letters }, processed);

      expect(left).toEqual(expectedLeft);
      expect(left).toEqual(jobs.filter((job) => job.state === 'active').map((job) => job.id));
      expect(snapshotAfter).toEqual(snapshotBefore);
      // No letter of the user is left: every one named a processed or a gone job.
      const letterOwners = (await admin.lrange(after.dlqKey, 0, -1)).map((raw) => ownerOf((JSON.parse(raw) as { data: unknown }).data));
      expect(letterOwners).not.toContain(USER);
      expect(letterOwners).toHaveLength(600);
      // Reads and removals go a batch at a time: no command is sent for a single job or letter.
      expect(trips.trips).toBeLessThanOrEqual(20);
      expect(trips.names).not.toContain('hget');
      expect(trips.names.filter((name) => name === 'lrange')).toHaveLength(1);
    });

    it('deletes the index when no job is left, and keeps the jobs of a user it does not name', async () => {
      const input: Seed = {
        jobs: [{ id: 'only', data: { userId: USER }, state: 'completed' }],
        letters: [letter('only', USER)],
      };
      const { left, snapshotAfter, snapshotBefore } = await forgetOnBoth(input, new Set(['only']));

      expect(left).toEqual([]);
      expect(snapshotAfter).toEqual(snapshotBefore);
      expect(Object.keys(snapshotAfter).filter((name) => name.includes('user_jobs'))).toEqual([]);
    });

    it('does not read the dead-letter list once for each job it removes', async () => {
      const jobs = Array.from({ length: 60 }, (_, n) => ({ id: `job${n}`, data: { userId: USER }, state: 'completed' }));
      const keys = keySpace(`${prefix}scripts:`);
      await seed(keys, { jobs, letters: [letter('job1', USER)] });
      const client = connect();
      const trips = countTrips();

      await forgetUserJobs(client, keys, USER, new Set(jobs.map((job) => job.id)));

      // The removal script gets the job, the six states and the index, not the dead-letter key; the letters of the 60 jobs go in one more
      // script, which gets the dead-letter key alone and the ids of the jobs (the letter of the list is removed by a pipelined LREM).
      expect(trips.evalKeyCounts.filter((count) => count === 8)).toHaveLength(60);
      expect(trips.evalKeyCounts.filter((count) => count !== 8)).toEqual([1]);
    });
  });

  describe('DistributedBullMQAdapter.getJobs', () => {
    it('lists the same jobs in the same order from one pipeline, and leaves out an id whose job is gone', async () => {
      // The adapter closes its client.
      const client = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
      const adapter = new DistributedBullMQAdapter<{ userId: string; n: number }, string>('lists', { redisClient: client, keyPrefix: prefix });
      try {
        const added = [];
        for (let n = 0; n < 30; n += 1) added.push(await adapter.add('convert', { userId: `u${n % 3}`, n }, n % 5 === 0 ? { delay: 60_000 } : {}));
        await adapter.cancelJob(added[1].id);
        await adapter.cancelJob(added[2].id);
        await admin.sadd(`${prefix}{lists}:completed`, 'job_that_is_gone');
        const types = ['waiting', 'delayed', 'cancelled', 'completed'] as const;
        const waiting = await admin.zrange(`${prefix}{lists}:waiting`, '0', '-1');
        const delayed = await admin.zrange(`${prefix}{lists}:delayed`, '0', '-1');
        const cancelled = await admin.smembers(`${prefix}{lists}:cancelled`);
        const expected = [...new Set([...waiting, ...delayed, ...cancelled, 'job_that_is_gone'])];
        expect(expected.length).toBe(31);

        const trips = countTrips();
        const listed = await adapter.getJobs([...types]);

        expect(listed.map((job) => job.id)).toEqual(expected.filter((id) => id !== 'job_that_is_gone'));
        expect(listed).toHaveLength(30);
        expect(listed.every((job) => job !== undefined && job.data.n >= 0)).toBe(true);
        // One read for each state and one pipeline for the hashes, not a round trip for each job.
        expect(trips.trips).toBeLessThanOrEqual(types.length + 2);
        expect(trips.names.filter((name) => name === 'hgetall')).toHaveLength(31);
        const page = await adapter.getJobs([...types], 2, 4);
        expect(page.map((job) => job.id)).toEqual(expected.slice(2, 5).filter((id) => id !== 'job_that_is_gone'));
      } finally {
        await adapter.close();
      }
    });
  });

  describe('RedisGraphScheduler.graphsOfUser', () => {
    it('finds the graphs of the user with one pipeline for each page of the scan', async () => {
      const client = connect();
      const scheduler = new RedisGraphScheduler({ redisClient: client, keyPrefix: prefix });
      const pipeline = admin.pipeline();
      const mine: string[] = [];
      for (let n = 0; n < 700; n += 1) {
        const owner = n % 4 === 0 ? 'user_erased' : `user_${n % 9}`;
        if (owner === 'user_erased') mine.push(`g${n}`);
        pipeline.hset(`${prefix}graph:{g${n}}`, 'owner', owner, 'status', 'running');
        pipeline.hset(`${prefix}graph:{g${n}}:nodes`, 'a', 'x');
      }
      await pipeline.exec();
      const trips = countTrips();

      const found = await scheduler.graphsOfUser('user_erased');

      expect(found).toEqual([...mine].sort((a, b) => a.localeCompare(b)));
      expect(trips.names.filter((name) => name === 'hget')).toHaveLength(700);
      const scans = trips.names.filter((name) => name === 'scan').length;
      expect(trips.trips).toBeLessThanOrEqual(scans * 2);
    });
  });

  describe('clearKeysMatching', () => {
    it('deletes the keys of the patterns in batches with UNLINK, never with KEYS, and no others', async () => {
      const pipeline = admin.pipeline();
      for (let n = 0; n < 1300; n += 1) pipeline.set(`${prefix}idem:${n}`, '1');
      for (let n = 0; n < 5; n += 1) pipeline.set(`${prefix}sec:${n}`, '1');
      for (let n = 0; n < 5; n += 1) pipeline.set(`${prefix}keep:${n}`, '1');
      await pipeline.exec();
      const client = connect();
      const trips = countTrips();

      await clearKeysMatching(client, [`${prefix}idem:*`, `${prefix}sec:*`]);

      expect((await admin.keys(`${prefix}*`)).sort()).toEqual([0, 1, 2, 3, 4].map((n) => `${prefix}keep:${n}`));
      expect(trips.names).not.toContain('keys');
      expect(trips.names).not.toContain('del');
      expect(trips.names.filter((name) => name === 'unlink').length).toBeGreaterThanOrEqual(3);
    });

    it('is what the idempotency store clears its records with', async () => {
      const client = connect();
      const store = new RedisIdempotencyStore({ redisClient: client });
      await admin.set('idem:query-paths-1', '{}');
      await admin.set('idem:query-paths-2', '{}');
      const trips = countTrips();
      try {
        await store.reset();

        expect(await admin.keys('idem:query-paths-*')).toEqual([]);
        expect(trips.names).not.toContain('keys');
      } finally {
        await admin.del('idem:query-paths-1', 'idem:query-paths-2');
      }
    });
  });
});
