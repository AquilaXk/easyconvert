import crypto from 'node:crypto';
import Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DistributedBullMQAdapter } from '../src/lib/queue/bullmq-engine';
import { addDeadLetter } from '../src/lib/queue/dead-letters';
import { forgetUserJobs, ownerOf, removeStoredJob, type QueueKeySpace } from '../src/lib/queue/ended-jobs';
import { QueueUnavailableError } from '../src/lib/types';

/**
 * The dead-letter list keeps an index beside it (a set of the raw letters of each job, a set of the jobs of each user that have a
 * letter, and a flag that says the index covers the whole list), so removing a job's letters does not read the list. Every path that
 * adds or removes a letter keeps the index equal to what the list holds, a letter written before the index existed is still removed,
 * and a job's removal removes exactly the letters the removal that read the whole list removed. Like the other Redis suites it runs when
 * REDIS_URL is set.
 */
const REDIS_URL = process.env.REDIS_URL;
const USER = 'user_erased';
const OTHER = 'user_kept';

/** The script of `removeStoredJob` before the index: it reads the whole list for the job it removes (the oracle of the removal). */
const OLD_REMOVE_JOB_LUA_SCRIPT = `
local state = redis.call('HGET', KEYS[1], 'state')
if state == 'active' then
  return 0
end
if KEYS[9] and KEYS[9] ~= '' then
  for _, raw in ipairs(redis.call('LRANGE', KEYS[9], 0, -1)) do
    local ok, letter = pcall(cjson.decode, raw)
    if ok and type(letter) == 'table' and letter.jobId == ARGV[1] then
      redis.call('LREM', KEYS[9], 0, raw)
    end
  end
end
if not state then
  return 0
end
local t = redis.call('TYPE', KEYS[2])
local typeName = (type(t) == 'table' and t.ok) or t
if typeName == 'list' then
  redis.call('LREM', KEYS[2], 0, ARGV[1])
else
  redis.call('ZREM', KEYS[2], ARGV[1])
end
redis.call('ZREM', KEYS[3], ARGV[1])
for i = 4, 7 do
  redis.call('SREM', KEYS[i], ARGV[1])
end
redis.call('ZREM', KEYS[8], ARGV[1])
redis.call('DEL', KEYS[1])
return 1
`;

function parseData(text: string | null): unknown {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

const letter = (jobId: string | undefined, owner: string | undefined, extra = '', timestamp = 1): string =>
  JSON.stringify({ ...(jobId === undefined ? {} : { jobId }), name: 'convert', data: owner ? { userId: owner } : {}, failedReason: `failed${extra}`, attemptsMade: 1, timestamp, stacktrace: [] });

interface Seed {
  jobs: { id: string; data?: unknown; state?: string }[];
  /** In list order. A letter in `preIndex` is written with a plain RPUSH, as before the index existed. */
  letters: { raw: string; preIndex?: boolean }[];
}

// skip-ok: mode selection. The shards run without REDIS_URL; the Redis-mode CI step (npm run test:redis) sets it and runs this file.
describe.skipIf(!REDIS_URL)('the index of the dead letters on a real Redis server', () => {
  let admin: Redis;
  let prefix: string;
  const clients: Redis[] = [];
  const adapters: DistributedBullMQAdapter<{ userId?: string }, string>[] = [];

  beforeEach(() => {
    prefix = `dlq-index-${crypto.randomBytes(6).toString('hex')}:`;
    admin = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    while (adapters.length > 0) await adapters.pop()!.close();
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

  /** An adapter whose connection is ready: a letter is written to Redis only then. The adapter closes its client. */
  async function adapterOn(name: string, space = prefix) {
    const client = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
    const adapter = new DistributedBullMQAdapter<{ userId?: string }, string>(name, { redisClient: client, keyPrefix: space });
    adapters.push(adapter);
    await adapter.getDlqEntries();
    return { adapter, client };
  }

  function keySpace(space: string): QueueKeySpace {
    return {
      jobKey: (id) => `${space}{q}:job:${id}`,
      userJobsKey: (userId) => `${space}{q}:user_jobs:${userId ?? 'none'}`,
      dlqKey: `${space}{q}:dlq`,
      stateKeys: ['waiting', 'delayed', 'active', 'completed', 'failed', 'cancelled'].map((name) => `${space}{q}:${name}`) as unknown as QueueKeySpace['stateKeys'],
    };
  }

  async function seed(client: Redis, keys: QueueKeySpace, { jobs, letters }: Seed, indexed: boolean): Promise<void> {
    const pipeline = admin.pipeline();
    jobs.forEach(({ id, data, state }, at) => {
      const fields: string[] = ['id', id];
      if (data !== undefined) fields.push('data', JSON.stringify(data));
      if (state !== undefined) fields.push('state', state);
      pipeline.hset(keys.jobKey(id), ...fields);
      if (state === 'active') pipeline.sadd(keys.stateKeys[2], id);
      if (state === 'completed') pipeline.sadd(keys.stateKeys[3], id);
      if (state === 'waiting') pipeline.zadd(keys.stateKeys[0], String(at), id);
      pipeline.zadd(keys.userJobsKey(USER), String(at), id);
    });
    await pipeline.exec();
    for (const { raw, preIndex } of letters) {
      if (indexed && !preIndex) await addDeadLetter(client, keys.dlqKey, raw);
      else await admin.rpush(keys.dlqKey, raw);
    }
  }

  /** What the index must hold for the letters in the list: jobs to their raws, users to their jobs. */
  async function expectedIndex(dlqKey: string): Promise<{ jobs: Record<string, string[]>; users: Record<string, string[]> }> {
    const jobs: Record<string, Set<string>> = {};
    const users: Record<string, Set<string>> = {};
    for (const raw of await admin.lrange(dlqKey, 0, -1)) {
      let parsed: { jobId?: unknown; data?: unknown } | undefined;
      try {
        parsed = JSON.parse(raw) as { jobId?: unknown; data?: unknown };
      } catch {
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null) continue;
      const jobId = typeof parsed.jobId === 'string' ? parsed.jobId : '';
      const owner = ownerOf(parsed.data);
      if (jobId === '' && owner === undefined) continue;
      (jobs[jobId] ??= new Set()).add(raw);
      if (owner !== undefined) (users[owner] ??= new Set()).add(jobId);
    }
    const sorted = (map: Record<string, Set<string>>) => Object.fromEntries(Object.entries(map).map(([key, set]) => [key, [...set].sort()]));
    return { jobs: sorted(jobs), users: sorted(users) };
  }

  async function actualIndex(dlqKey: string): Promise<{ jobs: Record<string, string[]>; users: Record<string, string[]> }> {
    const read = async (kind: 'job' | 'user') => {
      const stem = `${dlqKey}:${kind}:`;
      const out: Record<string, string[]> = {};
      for (const key of await admin.keys(`${stem}*`)) out[key.slice(stem.length)] = (await admin.smembers(key)).sort();
      return out;
    };
    return { jobs: await read('job'), users: await read('user') };
  }

  /**
   * The index equals what the list holds when the flag says it covers the list. Before that it may lack letters (those written before
   * the index) and must not hold a letter that the list does not.
   */
  async function expectConsistent(dlqKey: string): Promise<void> {
    const actual = await actualIndex(dlqKey);
    const expected = await expectedIndex(dlqKey);
    if ((await admin.exists(`${dlqKey}:indexed`)) === 1) {
      expect(actual).toEqual(expected);
      return;
    }
    const inList = new Set(await admin.lrange(dlqKey, 0, -1));
    for (const raws of Object.values(actual.jobs)) for (const raw of raws) expect(inList.has(raw)).toBe(true);
    for (const jobIds of Object.values(actual.users)) for (const jobId of jobIds) expect(actual.jobs[jobId]).toBeDefined();
  }

  /** Everything under a key space, the space name left out, so two runs on two spaces compare. */
  async function snapshot(space: string): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const key of (await admin.keys(`${space}*`)).sort()) {
      const type = await admin.type(key);
      const name = key.slice(space.length);
      if (name.includes(':dlq:')) continue;
      if (type === 'hash') out[name] = await admin.hgetall(key);
      else if (type === 'list') out[name] = await admin.lrange(key, 0, -1);
      else if (type === 'zset') out[name] = await admin.zrange(key, '0', '-1', 'WITHSCORES');
      else if (type === 'set') out[name] = (await admin.smembers(key)).sort();
      else out[name] = type;
    }
    return out;
  }

  /** The commands the client sends from now on. */
  function commandsOf(client: Redis): string[] {
    const names: string[] = [];
    const prototype = Redis.prototype as unknown as { sendCommand: (this: unknown, command: { name: string }, ...rest: unknown[]) => unknown };
    const real = prototype.sendCommand;
    vi.spyOn(prototype, 'sendCommand').mockImplementation(function (this: unknown, command, ...rest) {
      if (this === client) names.push(command.name);
      return real.call(this, command, ...rest);
    });
    return names;
  }

  const MIXED: Seed = {
    jobs: [
      { id: 'done1', data: { userId: USER }, state: 'completed' },
      { id: 'done2', data: { userId: USER }, state: 'completed' },
      { id: 'active', data: { userId: USER }, state: 'active' },
      { id: 'beyond', data: { userId: USER }, state: 'waiting' },
      { id: 'foreign', data: { userId: OTHER }, state: 'completed' },
      { id: 'ghost' },
      { id: 'nostate', data: { userId: USER } },
    ],
    letters: [
      { raw: letter('done1', USER) },
      { raw: letter('done1', undefined) },
      { raw: letter('done2', USER, '-twice') },
      { raw: letter('done2', USER, '-twice') },
      { raw: letter('vanished', USER) },
      { raw: letter('vanished', OTHER) },
      { raw: letter('foreign', OTHER) },
      { raw: letter('beyond', USER) },
      { raw: letter('active', USER) },
      { raw: letter('active', undefined) },
      { raw: letter('nostate', undefined) },
      { raw: letter(undefined, USER, '-no-job-id') },
      { raw: letter('', undefined, '-empty-job-id') },
      { raw: 'not json at all' },
      { raw: '"a json string"' },
      { raw: letter('somebody-else', OTHER) },
    ],
  };
  const MIXED_PROCESSED = new Set(['done1', 'done2', 'active', 'foreign', 'ghost', 'nostate']);

  describe('removing a job', () => {
    /** The removal on the old script and on the index, from the same seed. */
    async function removeBoth(input: Seed, ids: readonly string[], preIndexEverything = false) {
      const oracle = keySpace(`${prefix}oracle:`);
      const head = keySpace(`${prefix}head:`);
      const client = connect();
      await seed(client, oracle, input, false);
      await seed(client, head, input, !preIndexEverything);
      for (const id of ids) {
        const userJobsKey = oracle.userJobsKey(ownerOf(parseData(await admin.hget(oracle.jobKey(id), 'data'))));
        const oracleKeys = [oracle.jobKey(id), ...oracle.stateKeys, userJobsKey, oracle.dlqKey];
        const oracleAnswer = Number(await client.eval(OLD_REMOVE_JOB_LUA_SCRIPT, oracleKeys.length, ...oracleKeys, id)) === 1;
        expect(await removeStoredJob(client, head, id, true)).toBe(oracleAnswer);
        expect(await admin.lrange(head.dlqKey, 0, -1)).toEqual(await admin.lrange(oracle.dlqKey, 0, -1));
      }
      return { oracle, head, client };
    }

    it('removes exactly the letters the removal that read the whole list removed, for every kind of letter', async () => {
      const ids = ['done1', 'done2', 'active', 'foreign', 'ghost', 'nostate', 'vanished', 'beyond', 'never-existed'];
      const { head, oracle } = await removeBoth(MIXED, ids);

      expect(await snapshot(`${prefix}head:`)).toEqual(await snapshot(`${prefix}oracle:`));
      expect(await admin.lrange(head.dlqKey, 0, -1)).toEqual(await admin.lrange(oracle.dlqKey, 0, -1));
      await expectConsistent(head.dlqKey);
    });

    it('keeps the letters of an active job, which it does not remove, as the old script did', async () => {
      const { head } = await removeBoth(MIXED, ['active']);

      const left = (await admin.lrange(head.dlqKey, 0, -1)).filter((raw) => raw.includes('"active"'));
      expect(left).toHaveLength(2);
      await expectConsistent(head.dlqKey);
    });

    it('removes a letter written before the index existed, and leaves the index as it was', async () => {
      const { head } = await removeBoth(MIXED, ['done1', 'done2', 'vanished'], true);

      expect(await admin.exists(`${head.dlqKey}:indexed`)).toBe(0);
      expect((await admin.lrange(head.dlqKey, 0, -1)).some((raw) => raw.includes('"done1"') || raw.includes('"vanished"'))).toBe(false);
      await expectConsistent(head.dlqKey);
    });

    it('removes both the letters before the index and the letters after it, while the index does not yet cover the list', async () => {
      const keys = keySpace(`${prefix}mixed:`);
      const client = connect();
      const before = [letter('job1', USER, '-old-1'), letter('job1', USER, '-old-2'), letter('job2', USER, '-old')];
      for (const raw of before) await admin.rpush(keys.dlqKey, raw);
      await addDeadLetter(client, keys.dlqKey, letter('job1', USER, '-new'));
      await addDeadLetter(client, keys.dlqKey, letter('job3', USER, '-new'));
      expect(await admin.exists(`${keys.dlqKey}:indexed`)).toBe(0);
      await admin.hset(keys.jobKey('job1'), 'state', 'failed', 'data', JSON.stringify({ userId: USER }));

      expect(await removeStoredJob(client, keys, 'job1', true)).toBe(true);

      expect((await admin.lrange(keys.dlqKey, 0, -1)).map((raw) => (JSON.parse(raw) as { failedReason: string }).failedReason)).toEqual(['failed-old', 'failed-new']);
      await expectConsistent(keys.dlqKey);
    });

    it('does not read the dead-letter list once the index covers it, whatever the list holds', async () => {
      const keys = keySpace(`${prefix}covered:`);
      const client = connect();
      const jobs = Array.from({ length: 40 }, (_, n) => ({ id: `job${n}`, data: { userId: USER }, state: 'failed' }));
      await seed(client, keys, { jobs, letters: Array.from({ length: 300 }, (_, n) => ({ raw: letter(`job${n}`, USER) })) }, true);
      expect(await admin.get(`${keys.dlqKey}:indexed`)).toBe('1');
      const names = commandsOf(client);

      for (const job of jobs) expect(await removeStoredJob(client, keys, job.id, true)).toBe(true);

      expect(names).not.toContain('lrange');
      expect(await admin.llen(keys.dlqKey)).toBe(260);
      await expectConsistent(keys.dlqKey);
    });
  });

  describe('erasing a user', () => {
    async function forgetBoth(input: Seed, processed: ReadonlySet<string>, preIndexEverything = false) {
      const oracle = keySpace(`${prefix}oracle:`);
      const head = keySpace(`${prefix}head:`);
      const client = connect();
      await seed(client, oracle, input, false);
      await seed(client, head, input, !preIndexEverything);
      const expectedLeft = await oldForget(client, oracle, USER, processed);
      const left = await forgetUserJobs(client, head, USER, processed);
      return { left, expectedLeft, oracle, head, client };
    }

    /** The erasure before the index: the jobs through the old script, then one read of the whole list. */
    async function oldForget(client: Redis, keys: QueueKeySpace, userId: string, processed: ReadonlySet<string>): Promise<string[]> {
      const parse = (text: string | null): { jobId?: string; data?: unknown } | undefined => {
        try {
          return text ? (JSON.parse(text) as { jobId?: string; data?: unknown }) : undefined;
        } catch {
          return undefined;
        }
      };
      const index = keys.userJobsKey(userId);
      const left: string[] = [];
      const cleared = new Set<string>();
      for (const id of await client.zrange(index, '0', '-1')) {
        const data = await client.hget(keys.jobKey(id), 'data');
        const state = await client.hget(keys.jobKey(id), 'state');
        if (ownerOf(parse(data)) !== userId) {
          await client.zrem(index, id);
          continue;
        }
        if (!processed.has(id)) {
          left.push(id);
          continue;
        }
        const scriptKeys = [keys.jobKey(id), ...keys.stateKeys, index];
        const removed = Number(await client.eval(OLD_REMOVE_JOB_LUA_SCRIPT, scriptKeys.length, ...scriptKeys, id)) === 1;
        if (removed || state === null) cleared.add(id);
        if (!removed) left.push(id);
      }
      for (const raw of await client.lrange(keys.dlqKey, 0, -1)) {
        const entry = parse(raw);
        const jobId = entry?.jobId ?? '';
        const owned = ownerOf(entry?.data) === userId;
        if (cleared.has(jobId) || (owned && (processed.has(jobId) || (await client.exists(keys.jobKey(jobId))) === 0))) await client.lrem(keys.dlqKey, 0, raw);
      }
      if (left.length === 0) await client.del(index);
      return left;
    }

    it('answers and leaves what the erasure that read the whole list did', async () => {
      const { left, expectedLeft, head, oracle } = await forgetBoth(MIXED, MIXED_PROCESSED);

      expect(left).toEqual(expectedLeft);
      expect(await admin.lrange(head.dlqKey, 0, -1)).toEqual(await admin.lrange(oracle.dlqKey, 0, -1));
      expect(await snapshot(`${prefix}head:`)).toEqual(await snapshot(`${prefix}oracle:`));
      await expectConsistent(head.dlqKey);
    });

    it('does the same for letters that all come from before the index', async () => {
      const { left, expectedLeft, head, oracle } = await forgetBoth(MIXED, MIXED_PROCESSED, true);

      expect(left).toEqual(expectedLeft);
      expect(await admin.lrange(head.dlqKey, 0, -1)).toEqual(await admin.lrange(oracle.dlqKey, 0, -1));
      expect(await admin.exists(`${head.dlqKey}:indexed`)).toBe(0);
      await expectConsistent(head.dlqKey);
    });

    it('leaves no key that names the user when every letter of the user is gone', async () => {
      const input: Seed = {
        jobs: [{ id: 'done1', data: { userId: USER }, state: 'completed' }],
        letters: [{ raw: letter('done1', USER) }, { raw: letter('vanished', USER) }, { raw: letter('kept', OTHER) }],
      };
      const { head } = await forgetBoth(input, new Set(['done1']));

      expect(await admin.keys(`${head.dlqKey}:*${USER}*`)).toEqual([]);
      expect(await admin.keys(`${head.dlqKey}:*vanished*`)).toEqual([]);
      expect((await admin.lrange(head.dlqKey, 0, -1)).map((raw) => ownerOf((JSON.parse(raw) as { data: unknown }).data))).toEqual([OTHER]);
      await expectConsistent(head.dlqKey);
    });

    it('reads no list and sends the same few round trips for a user with many jobs and letters', async () => {
      const jobs = Array.from({ length: 1100 }, (_, n) => ({ id: `job${n}`, data: { userId: USER }, state: 'completed' }));
      const letters = [
        ...jobs.map((job) => ({ raw: letter(job.id, USER) })),
        ...Array.from({ length: 600 }, (_, n) => ({ raw: letter(`gone${n}`, USER) })),
        ...Array.from({ length: 600 }, (_, n) => ({ raw: letter(`other${n}`, `user_${n % 9}`) })),
      ];
      const keys = keySpace(`${prefix}big:`);
      const client = connect();
      await seed(client, keys, { jobs, letters }, true);
      const names = commandsOf(client);

      const left = await forgetUserJobs(client, keys, USER, new Set(jobs.map((job) => job.id)));

      expect(left).toEqual([]);
      expect(names).not.toContain('lrange');
      expect(await admin.llen(keys.dlqKey)).toBe(600);
      await expectConsistent(keys.dlqKey);
    });

    it('drops the id of a job whose letters are gone from the index of the user', async () => {
      const keys = keySpace(`${prefix}stale:`);
      const client = connect();
      await seed(client, keys, { jobs: [], letters: [{ raw: letter('job1', USER) }, { raw: letter('job2', USER) }] }, true);
      // Damage: the job's set is lost, the user's set still names it.
      await admin.del(`${keys.dlqKey}:job:job1`);

      await forgetUserJobs(client, keys, USER, new Set());

      expect(await admin.keys(`${keys.dlqKey}:user:*`)).toEqual([]);
      expect(await admin.lrange(keys.dlqKey, 0, -1)).toEqual([letter('job1', USER)]);
    });
  });

  describe('the paths of the queue that add or remove a letter', () => {
    const job = (id: string, userId: string) => ({ id, name: 'convert', data: { userId }, attemptsMade: 1, stacktrace: ['at here'], opts: {} }) as never;

    it('indexes a letter as it is written, and sets the flag on an empty list', async () => {
      const { adapter } = await adapterOn('written');
      await adapter.moveToDlq(job('job1', USER), 'first');
      await adapter.moveToDlq(job('job1', USER), 'second');
      await adapter.moveToDlq(job('job2', OTHER), 'third');

      const dlqKey = `${prefix}{written}:dlq`;
      expect(await admin.get(`${dlqKey}:indexed`)).toBe('1');
      expect(await admin.smembers(`${dlqKey}:user:${USER}`)).toEqual(['job1']);
      expect(await admin.scard(`${dlqKey}:job:job1`)).toBe(2);
      await expectConsistent(dlqKey);
    });

    it('does not set the flag when the list already held letters, and keeps indexing the new ones', async () => {
      const dlqKey = `${prefix}{older}:dlq`;
      await admin.rpush(dlqKey, letter('job0', USER, '-old'));
      const { adapter } = await adapterOn('older');
      await adapter.moveToDlq(job('job1', USER), 'new');

      expect(await admin.exists(`${dlqKey}:indexed`)).toBe(0);
      expect(await admin.smembers(`${dlqKey}:job:job1`)).toHaveLength(1);
      expect(await admin.exists(`${dlqKey}:job:job0`)).toBe(0);
    });

    it('takes the index of a letter out when the sweep trims it by age', async () => {
      const { adapter } = await adapterOn('trim');
      const dlqKey = `${prefix}{trim}:dlq`;
      const now = vi.spyOn(Date, 'now');
      now.mockReturnValue(1_000);
      await adapter.moveToDlq(job('old1', USER), 'old');
      await adapter.moveToDlq(job('old2', OTHER), 'old');
      now.mockReturnValue(4_000_000_000_000);
      await adapter.moveToDlq(job('fresh', USER), 'fresh');
      now.mockRestore();

      await adapter.clean(60_000, 100, 'failed');

      expect((await adapter.getDlqEntries()).map((entry) => entry.jobId)).toEqual(['fresh']);
      expect(await admin.keys(`${dlqKey}:job:*`)).toEqual([`${dlqKey}:job:fresh`]);
      expect(await admin.smembers(`${dlqKey}:user:${USER}`)).toEqual(['fresh']);
      expect(await admin.exists(`${dlqKey}:user:${OTHER}`)).toBe(0);
      await expectConsistent(dlqKey);
    });

    it('empties the index when the list is purged, and covers the empty list again', async () => {
      const dlqKey = `${prefix}{purge}:dlq`;
      await admin.rpush(dlqKey, letter('job0', USER, '-old'));
      const { adapter } = await adapterOn('purge');
      await adapter.moveToDlq(job('job1', USER), 'new');

      expect(await adapter.purgeDlq()).toBe(2);

      expect(await admin.keys(`${dlqKey}*`)).toEqual([`${dlqKey}:indexed`]);
    });

    it('takes the letters of a removed job out of the list and the index through the queue', async () => {
      const { adapter } = await adapterOn('removed');
      const dlqKey = `${prefix}{removed}:dlq`;
      const added = await adapter.add('convert', { userId: USER }, { attempts: 1 });
      await adapter.moveToDlq(job(added.id, USER), 'boom');
      await adapter.moveToDlq(job('keep', OTHER), 'boom');
      await admin.hset(`${prefix}{removed}:job:${added.id}`, 'state', 'failed');
      await admin.zrem(`${prefix}{removed}:waiting`, added.id);

      expect(await adapter.remove(added.id)).toBe(true);

      expect((await adapter.getDlqEntries()).map((entry) => entry.jobId)).toEqual(['keep']);
      await expectConsistent(dlqKey);
    });
  });

  describe('a list written before the index', () => {
    it('is listed, left alone and covered by a dry run, and indexed once by the backfill', async () => {
      const dlqKey = `${prefix}{legacy}:dlq`;
      const raws = [letter('job1', USER), letter('job1', USER, '-b'), letter('job2', OTHER), 'not json', letter(undefined, USER)];
      for (const raw of raws) await admin.rpush(dlqKey, raw);
      const { adapter } = await adapterOn('legacy');

      const dry = await adapter.backfillDeadLetterIndex!(false);
      expect(dry).toEqual({ letters: 5, indexable: 4, alreadyCovered: false, applied: false });
      expect(await admin.keys(`${dlqKey}:*`)).toEqual([]);

      const applied = await adapter.backfillDeadLetterIndex!(true);
      expect(applied).toEqual({ letters: 5, indexable: 4, alreadyCovered: false, applied: true });
      expect(await admin.get(`${dlqKey}:indexed`)).toBe('1');
      expect(await admin.lrange(dlqKey, 0, -1)).toEqual(raws);
      await expectConsistent(dlqKey);

      const again = await adapter.backfillDeadLetterIndex!(true);
      expect(again).toEqual({ letters: 5, indexable: 0, alreadyCovered: true, applied: false });
      await expectConsistent(dlqKey);
    });

    it('erases every letter of a user after the backfill that it erased before it', async () => {
      const before = keySpace(`${prefix}before:`);
      const after = keySpace(`${prefix}after:`);
      const client = connect();
      await seed(client, before, MIXED, false);
      await seed(client, after, MIXED, false);
      const processed = MIXED_PROCESSED;

      const erasedBefore = await forgetUserJobs(client, before, USER, processed);
      expect(await admin.exists(`${before.dlqKey}:indexed`)).toBe(0);
      const { adapter } = await adapterOn('q', `${prefix}after:`);
      await adapter.backfillDeadLetterIndex!(true);
      const erasedAfter = await forgetUserJobs(client, after, USER, processed);

      expect(erasedAfter).toEqual(erasedBefore);
      expect(await admin.lrange(after.dlqKey, 0, -1)).toEqual(await admin.lrange(before.dlqKey, 0, -1));
      await expectConsistent(after.dlqKey);
    });
  });

  describe('a Redis that fails', () => {
    function failScripts(client: Redis): void {
      const prototype = Redis.prototype as unknown as { sendCommand: (this: unknown, command: { name: string; reject: (error: Error) => void }, ...rest: unknown[]) => unknown };
      const real = prototype.sendCommand;
      vi.spyOn(prototype, 'sendCommand').mockImplementation(function (this: unknown, command, ...rest) {
        if (this === client && (command.name === 'eval' || command.name === 'evalsha')) {
          const failure = new Error("READONLY You can't write against a read only replica.");
          // A command of a pipeline answers through its own promise; a command sent alone, through what `sendCommand` returns.
          if (rest[0] === undefined) return Promise.reject(failure);
          command.reject(failure);
          return undefined;
        }
        return real.call(this, command, ...rest);
      });
    }

    it('fails the removal of a job and leaves its letters, instead of answering that it is gone', async () => {
      const { adapter, client } = await adapterOn('failing');
      const dlqKey = `${prefix}{failing}:dlq`;
      await admin.hset(`${prefix}{failing}:job:job1`, 'state', 'failed', 'data', JSON.stringify({ userId: USER }));
      await addDeadLetter(client, dlqKey, letter('job1', USER));
      failScripts(client);

      await expect(adapter.remove('job1')).rejects.toBeInstanceOf(QueueUnavailableError);

      expect(await admin.lrange(dlqKey, 0, -1)).toEqual([letter('job1', USER)]);
    });

    it('fails the erasure of a user and leaves its letters', async () => {
      const { adapter, client } = await adapterOn('failing');
      const dlqKey = `${prefix}{failing}:dlq`;
      await admin.zadd(`${prefix}{failing}:user_jobs:${USER}`, '1', 'job1');
      await admin.hset(`${prefix}{failing}:job:job1`, 'state', 'failed', 'data', JSON.stringify({ userId: USER }));
      await addDeadLetter(client, dlqKey, letter('job1', USER));
      await addDeadLetter(client, dlqKey, letter('gone', USER));
      failScripts(client);

      await expect(adapter.forgetUser(USER, new Set(['job1']))).rejects.toBeInstanceOf(QueueUnavailableError);

      expect(await admin.llen(dlqKey)).toBe(2);
    });
  });
});
