import crypto from 'node:crypto';
import Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DistributedBullMQAdapter, Queue } from '../src/lib/queue/bullmq-engine';

/**
 * The jobs of a user are listed from the ids of the user's index in windows, newest first: the hash of a job that is not wanted (another
 * state, or left out by the caller) is never transferred, the read stops once the page is full, and an id whose job is gone leaves
 * the index in the same step. The in-memory queue answers the same lists. Like the other Redis suites it runs when REDIS_URL is set.
 */
const REDIS_URL = process.env.REDIS_URL;

interface Data {
  userId: string;
  name: string;
  graphId?: string;
}
/** `node`: a graph node job (an id of the form `<graph>:<node>`); `bare`: a job that carries a graph id under an id without a colon. */
type Plan = { name: string; state: 'waiting' | 'active' | 'completed' | 'failed'; graph?: 'node' | 'bare' };

// skip-ok: mode selection. The shards run without REDIS_URL; the Redis-mode CI step (npm run test:redis) sets it and runs this file.
describe.skipIf(!REDIS_URL)('the windowed list of a user\'s jobs in Redis', () => {
  let keyPrefix: string;
  let admin: Redis;
  let client: Redis;
  let queue: DistributedBullMQAdapter<Data, string>;
  let user: string;

  beforeEach(() => {
    keyPrefix = `user-job-list-${crypto.randomBytes(6).toString('hex')}:`;
    user = `user-${crypto.randomUUID()}`;
    admin = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
    client = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
    queue = new DistributedBullMQAdapter<Data, string>('lists', { redisClient: client, keyPrefix });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const keys = await admin.keys(`${keyPrefix}*`);
    if (keys.length > 0) await admin.del(...keys);
    await admin.quit();
    await client.quit();
  });

  const jobKey = (id: string) => `${keyPrefix}{lists}:job:${id}`;

  /** Adds the jobs oldest first and puts each in the state the plan says, in Redis and in a memory queue that gets the same jobs. */
  async function seed(plan: Plan[], owner = user): Promise<{ ids: string[]; memory: Queue<Data, string> }> {
    const memory = new Queue<Data, string>('memory');
    const ids: string[] = [];
    for (const [n, step] of plan.entries()) {
      const data: Data = { userId: owner, name: step.name, ...(step.graph ? { graphId: `graph-${n}` } : {}) };
      const job = await queue.add('convert', data, { jobId: `job-${owner.slice(-6)}-${String(n).padStart(4, '0')}${step.graph === 'node' ? ':convert' : ''}` });
      await admin.hset(jobKey(job.id), 'state', step.state);
      const mirror = await memory.add('convert', data, { jobId: job.id });
      mirror.state = step.state;
      mirror.timestamp = n + 1;
      ids.push(job.id);
      // The score of a job is its creation time: space them so the order is the order of adding.
      await admin.zadd(queue.getUserJobsKey(owner), n + 1, job.id);
    }
    return { ids, memory };
  }

  const names = (jobs: { data: Data }[]) => jobs.map((job) => job.data.name);

  it('answers the same lists as the in-memory queue for any states, page and exclusion', async () => {
    const plan: Plan[] = Array.from({ length: 40 }, (_, n) => ({
      name: `j${n}`,
      state: (['completed', 'waiting', 'failed', 'active'] as const)[n % 4],
      graph: n % 5 === 0 ? (n % 10 === 0 ? 'node' : 'bare') : undefined,
    }));
    const { memory } = await seed(plan);

    for (const states of [undefined, ['waiting'], ['waiting', 'active'], ['completed', 'failed']] as const) {
      for (const [limit, offset] of [[5, 0], [7, 3], [100, 0], [3, 30]] as const) {
        for (const exclude of [undefined, { excludeGraphNodes: true }]) {
          const expected = await memory.getJobsByUser(user, states as never, limit, offset, exclude);
          const actual = await queue.getJobsByUser(user, states as never, limit, offset, exclude);
          expect(names(actual)).toEqual(names(expected));
        }
      }
    }
  });

  it('leaves the node jobs of graphs out on the server when the caller asks, and counts the page without them', async () => {
    await seed(Array.from({ length: 120 }, (_, n) => ({ name: `j${n}`, state: 'completed', graph: n % 3 !== 0 ? 'node' : undefined })));
    const replies: number[] = [];
    const evalOf = client.eval.bind(client) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(client, 'eval').mockImplementation(async (...args: unknown[]) => {
      const reply = (await evalOf(...args)) as unknown[];
      replies.push(reply.length);
      return reply as never;
    });

    const page = await queue.getJobsByUser(user, undefined, 10, 0, { excludeGraphNodes: true });

    expect(page).toHaveLength(10);
    expect(page.every((job) => !job.data.graphId)).toBe(true);
    // The first window is 50 ids, of which a third are plain jobs: the others were not transferred.
    expect(replies[0]).toBeLessThanOrEqual(17);
    expect(await queue.getJobsByUser(user, undefined, 200, 0)).toHaveLength(120);
  });

  it('reads the ids once and one window of jobs for a page that fits in it, and sends no job of another state', async () => {
    await seed(Array.from({ length: 300 }, (_, n) => ({ name: `j${n}`, state: n % 10 === 0 ? 'waiting' : 'completed' })));
    const names: string[] = [];
    const evalArgs: unknown[][] = [];
    const prototype = Redis.prototype as unknown as { sendCommand: (this: unknown, command: { name: string; args: unknown[] }, ...rest: unknown[]) => unknown };
    const real = prototype.sendCommand;
    vi.spyOn(prototype, 'sendCommand').mockImplementation(function (this: unknown, command, ...rest) {
      names.push(command.name);
      if (command.name === 'eval') evalArgs.push(command.args);
      return real.call(this, command, ...rest);
    });

    const page = await queue.getJobsByUser(user, undefined, 5, 0);
    expect(page).toHaveLength(5);
    expect(names.filter((name) => name !== 'hgetall')).toEqual(['zrevrange', 'eval']);
    expect(evalArgs[0].length).toBeLessThan(70);

    names.length = 0;
    const waiting = await queue.getJobsByUser(user, ['waiting'], 5, 0);
    expect(waiting).toHaveLength(5);
    expect(names).toEqual(['zrevrange', 'eval']);
  });

  it('never lists the job of another user, not even one that a damaged index names', async () => {
    const other = `user-${crypto.randomUUID()}`;
    const { ids } = await seed([{ name: 'mine', state: 'completed' }]);
    const { ids: theirs } = await seed([{ name: 'theirs', state: 'completed' }], other);
    await admin.zadd(queue.getUserJobsKey(user), 1000, theirs[0]);

    expect(names(await queue.getJobsByUser(user))).toEqual(['mine']);
    expect(names(await queue.getJobsByUser(other))).toEqual(['theirs']);
    expect(ids).toHaveLength(1);
  });

  it('drops the id of a gone job from the index and keeps a job that has no state field as waiting', async () => {
    const { ids } = await seed([
      { name: 'kept', state: 'completed' },
      { name: 'gone', state: 'completed' },
      { name: 'legacy', state: 'completed' },
    ]);
    await admin.del(jobKey(ids[1]));
    await admin.hdel(jobKey(ids[2]), 'state');

    expect(names(await queue.getJobsByUser(user, ['waiting']))).toEqual(['legacy']);
    expect(names(await queue.getJobsByUser(user))).toEqual(['legacy', 'kept']);
    expect(await admin.zscore(queue.getUserJobsKey(user), ids[1])).toBeNull();
  });

  it('keeps an id whose job a new add put back, since the check is made in the step that drops', async () => {
    const { ids } = await seed([{ name: 'again', state: 'completed' }]);
    await admin.del(jobKey(ids[0]));
    await queue.add('convert', { userId: user, name: 'again' }, { jobId: ids[0] });

    expect(names(await queue.getJobsByUser(user))).toEqual(['again']);
    expect(await admin.zscore(queue.getUserJobsKey(user), ids[0])).not.toBeNull();
  });
});
