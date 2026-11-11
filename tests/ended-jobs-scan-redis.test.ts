import crypto from 'node:crypto';
import Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DistributedBullMQAdapter, type JobOptions } from '../src/lib/queue/bullmq-engine';
import { removeEndedBefore, type QueueKeySpace } from '../src/lib/queue/ended-jobs';

/**
 * Removing the jobs that ended more than their age ago reads the ended set a chunk at a time and, at the end of a job, only when a job
 * can have aged out: a pass at every job end read the whole set for each job. Like the other Redis suites it runs when REDIS_URL is set.
 */
const REDIS_URL = process.env.REDIS_URL;
const AGE_SECONDS = 60;
const AGE_MS = AGE_SECONDS * 1000;
const OPTS: JobOptions = { attempts: 1, removeOnComplete: { age: AGE_SECONDS }, removeOnFail: { age: AGE_SECONDS } };

// skip-ok: mode selection. The shards run without REDIS_URL; the Redis-mode CI step (npm run test:redis) sets it and runs this file.
describe.skipIf(!REDIS_URL)('the removal of aged ended jobs on a real Redis server', () => {
  let keyPrefix: string;
  let admin: Redis;
  const adapters: DistributedBullMQAdapter<{ userId?: string; name: string }, string>[] = [];

  beforeEach(() => {
    keyPrefix = `ended-scan-${crypto.randomBytes(6).toString('hex')}:`;
    admin = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    while (adapters.length > 0) await adapters.pop()!.close();
    const keys = await admin.keys(`${keyPrefix}*`);
    if (keys.length > 0) await admin.del(...keys);
    await admin.quit();
  });

  function connect(name: string) {
    const client = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
    const adapter = new DistributedBullMQAdapter<{ userId?: string; name: string }, string>(name, { redisClient: client, keyPrefix });
    adapters.push(adapter);
    return { client, adapter };
  }

  async function endJob(adapter: DistributedBullMQAdapter<{ userId?: string; name: string }, string>, name: string, finishedOn?: number) {
    const job = await adapter.add('convert', { userId: 'u1', name }, OPTS);
    const popped = await adapter._popNextWaiting();
    expect(popped?.id).toBe(job.id);
    popped!.attemptsMade = 1;
    if (finishedOn !== undefined) popped!.finishedOn = finishedOn;
    await adapter._onJobCompleted(popped!, name);
    return job.id;
  }

  function commandNames(client: Redis): string[] {
    const names: string[] = [];
    const prototype = Redis.prototype as unknown as { sendCommand: (this: unknown, command: { name: string }, ...rest: unknown[]) => unknown };
    const real = prototype.sendCommand;
    vi.spyOn(prototype, 'sendCommand').mockImplementation(function (this: unknown, command, ...rest) {
      if (this === client) names.push(command.name);
      return real.call(this, command, ...rest);
    });
    return names;
  }

  it('does not read the whole ended set again at each job end', async () => {
    const { client, adapter } = connect('ended-many');
    const names = commandNames(client);

    for (let n = 0; n < 12; n += 1) await endJob(adapter, `job-${n}`);

    expect(names.filter((name) => name === 'smembers')).toEqual([]);
    // One pass reads the set (a chunk is one SSCAN); the following ends find that no job can have aged out.
    expect(names.filter((name) => name === 'sscan').length).toBeLessThanOrEqual(2);
  });

  it('removes a job once it has aged out, at the first job end after that', async () => {
    const { adapter } = connect('ended-due');
    const start = Date.now();
    const first = await endJob(adapter, 'first');
    await endJob(adapter, 'second');
    expect(await adapter.getJob(first)).toBeDefined();

    vi.spyOn(Date, 'now').mockReturnValue(start + AGE_MS + 1_000);
    await endJob(adapter, 'third');

    expect(await adapter.getJob(first)).toBeUndefined();
    // The second job ended a moment after the first, so it aged out too.
    expect((await adapter.getJobsByUser('u1')).map((job) => job.data.name)).toEqual(['third']);
  });

  it('removes a job that was already past its age when it ended, and keeps one that is not', async () => {
    const { adapter } = connect('ended-late');
    const old = await endJob(adapter, 'old', Date.now() - AGE_MS - 5);
    const young = await endJob(adapter, 'young', Date.now() - AGE_MS + 30_000);

    expect(await adapter.getJob(old)).toBeUndefined();
    expect(await adapter.getJob(young)).toBeDefined();

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
    await endJob(adapter, 'later');
    expect(await adapter.getJob(young)).toBeUndefined();
  });

  it('removes every aged job of a set longer than one chunk with no SMEMBERS, and stops at the limit it is given', async () => {
    const name = 'ended-long';
    const set = `${keyPrefix}{${name}}:completed`;
    const keys: QueueKeySpace = {
      jobKey: (id) => `${keyPrefix}{${name}}:job:${id}`,
      userJobsKey: (userId) => `${keyPrefix}{${name}}:user_jobs:${userId ?? 'none'}`,
      dlqKey: `${keyPrefix}{${name}}:dlq`,
      stateKeys: ['waiting', 'delayed', 'active', 'completed', 'failed', 'cancelled'].map((state) => `${keyPrefix}{${name}}:${state}`) as unknown as QueueKeySpace['stateKeys'],
    };
    const now = Date.now();
    const pipeline = admin.pipeline();
    for (let n = 0; n < 1_300; n += 1) {
      pipeline.sadd(set, `old-${n}`).hset(keys.jobKey(`old-${n}`), { state: 'completed', finishedOn: String(now - 10 * AGE_MS), data: '{"userId":"u1"}' });
    }
    for (let n = 0; n < 20; n += 1) {
      pipeline.sadd(set, `new-${n}`).hset(keys.jobKey(`new-${n}`), { state: 'completed', finishedOn: String(now), data: '{"userId":"u1"}' });
    }
    await pipeline.exec();
    const client = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
    const names = commandNames(client);

    expect(await removeEndedBefore(client, keys, set, now - AGE_MS, 100, false)).toHaveLength(100);
    expect((await removeEndedBefore(client, keys, set, now - AGE_MS, Number.POSITIVE_INFINITY, false)).length).toBe(1_200);
    vi.restoreAllMocks();

    expect(names).not.toContain('smembers');
    expect(await admin.scard(set)).toBe(20);
    await client.quit();
  });
});
