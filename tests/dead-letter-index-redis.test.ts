import crypto from 'node:crypto';
import Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DistributedBullMQAdapter, type DlqEntry } from '../src/lib/queue/bullmq-engine';
import { addDeadLetter, deadLetterKeys, migrateDeadLetters } from '../src/lib/queue/dead-letters';
import { forgetUserJobs, removeStoredJob, type QueueKeySpace } from '../src/lib/queue/ended-jobs';
import { ownerOf } from '../src/lib/queue/stored-job';
import { QueueUnavailableError } from '../src/lib/types';

/**
 * The dead letters are a hash per letter under an id, a sorted set of the ids by time and a set of ids per job and per user, so removing
 * a job's letters (by id) does not read the others. Every path that adds or removes a letter keeps those keys equal to what the letters
 * say, a letter that an older build wrote to the list is still removed and is moved by the migration, and a removal removes exactly the
 * letters that the removal which read the whole list removed (the oracle below is a copy of it). Like the other Redis suites it runs
 * when REDIS_URL is set.
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

/** Where a seeded letter is written: the list of the earlier layout, the new layout, or the two in turn. A text that is not a letter object can only be in the list. */
type Layout = 'list' | 'hash' | 'mixed';

interface Seed {
  jobs: { id: string; data?: unknown; state?: string }[];
  /** In write order. */
  letters: { raw: string }[];
}

/** The letters that Lua's `cjson` cannot decode: a lone surrogate escape, and nesting past a thousand levels. The index never decodes a letter. */
const LONE_SURROGATE_LETTER = JSON.stringify({ jobId: 'surrogate', name: 'convert', data: { userId: USER, fileName: 'a\ud800b.png' }, failedReason: 'failed', attemptsMade: 1, timestamp: 1, stacktrace: [] });
const deepLetter = (jobId: string, owner: string): string =>
  `{"jobId":"${jobId}","name":"convert","data":{"userId":"${owner}","nested":${'['.repeat(1100)}${']'.repeat(1100)}},"failedReason":"failed","attemptsMade":1,"timestamp":1,"stacktrace":[]}`;

// skip-ok: mode selection. The shards run without REDIS_URL; the Redis-mode CI step (npm run test:redis) sets it and runs this file.
describe.skipIf(!REDIS_URL)('the dead letters by id on a real Redis server', () => {
  let admin: Redis;
  let prefix: string;
  const clients: Redis[] = [];
  const adapters: DistributedBullMQAdapter<{ userId?: string }, string>[] = [];

  beforeEach(() => {
    prefix = `dlq-hash-${crypto.randomBytes(6).toString('hex')}:`;
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

  const isLetterObject = (raw: string): boolean => {
    const parsed = parseData(raw);
    return typeof parsed === 'object' && parsed !== null;
  };

  async function seed(client: Redis, keys: QueueKeySpace, { jobs, letters }: Seed, layout: Layout): Promise<void> {
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
    for (const [at, { raw }] of letters.entries()) {
      const inHash = layout === 'hash' || (layout === 'mixed' && at % 2 === 0);
      if (inHash && isLetterObject(raw)) await addDeadLetter(client, keys.dlqKey, JSON.parse(raw) as DlqEntry);
      else await admin.rpush(keys.dlqKey, raw);
    }
  }

  /** Every raw letter the queue holds, in the list and in the hashes, sorted: what two layouts of the same letters must agree on. */
  async function remainingRaws(dlqKey: string): Promise<string[]> {
    const { letterPrefix, order } = deadLetterKeys(dlqKey);
    const raws = await admin.lrange(dlqKey, 0, -1);
    for (const id of await admin.zrange(order, '0', '-1')) raws.push((await admin.hget(`${letterPrefix}${id}`, 'raw')) as string);
    return raws.sort();
  }

  /** What the keys of the new layout must hold for the letters in the hashes: the fields, the time, and the sets of ids. */
  async function expectConsistent(dlqKey: string): Promise<void> {
    const { letterPrefix, byJobPrefix, byUserPrefix, order } = deadLetterKeys(dlqKey);
    const ids = await admin.zrange(order, '0', '-1');
    const letterKeys = (await admin.keys(`${letterPrefix}*`)).map((key) => key.slice(letterPrefix.length)).sort();
    expect(letterKeys).toEqual([...ids].sort());
    const expectedByJob: Record<string, string[]> = {};
    const expectedByUser: Record<string, string[]> = {};
    for (const id of ids) {
      const fields = await admin.hgetall(`${letterPrefix}${id}`);
      const parsed = parseData(fields.raw) as { jobId?: unknown; data?: unknown; timestamp?: unknown } | undefined;
      const jobId = typeof parsed?.jobId === 'string' ? parsed.jobId : '';
      const owner = ownerOf(parsed?.data) ?? '';
      const time = typeof parsed?.timestamp === 'number' ? parsed.timestamp : 0;
      expect(Number(await admin.zscore(order, id))).toBe(time);
      if (jobId === '' && owner === '') {
        expect(Object.keys(fields)).toEqual(['raw']);
        continue;
      }
      expect(fields.job).toBe(jobId);
      expect(fields.user).toBe(owner === '' ? undefined : owner);
      (expectedByJob[jobId] ??= []).push(id);
      if (owner !== '') (expectedByUser[owner] ??= []).push(id);
    }
    const actual = async (stem: string): Promise<Record<string, string[]>> => {
      const out: Record<string, string[]> = {};
      for (const key of await admin.keys(`${stem}*`)) out[key.slice(stem.length)] = (await admin.smembers(key)).sort();
      return out;
    };
    const sorted = (map: Record<string, string[]>) => Object.fromEntries(Object.entries(map).map(([key, list]) => [key, [...list].sort()]));
    expect(await actual(byJobPrefix)).toEqual(sorted(expectedByJob));
    expect(await actual(byUserPrefix)).toEqual(sorted(expectedByUser));
  }

  /** Everything under a key space except the dead letters, the space name left out, so two runs on two spaces compare. */
  async function snapshot(space: string): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const key of (await admin.keys(`${space}*`)).sort()) {
      const type = await admin.type(key);
      const name = key.slice(space.length);
      if (name.startsWith('{q}:dlq')) continue;
      if (type === 'hash') out[name] = await admin.hgetall(key);
      else if (type === 'list') out[name] = await admin.lrange(key, 0, -1);
      else if (type === 'zset') out[name] = await admin.zrange(key, '0', '-1', 'WITHSCORES');
      else if (type === 'set') out[name] = (await admin.smembers(key)).sort();
      else out[name] = type;
    }
    return out;
  }

  /** The commands the server has run so far, by name, from its own statistics: this counts the commands a Lua step runs as well. */
  async function serverCalls(name: string): Promise<number> {
    const match = new RegExp(`cmdstat_${name}:calls=(\\d+)`).exec(await admin.info('commandstats'));
    return match ? Number(match[1]) : 0;
  }

  /** The erasure before the index: the jobs through the old script, then one read of the whole list, every letter parsed in the process. */
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
      { raw: LONE_SURROGATE_LETTER },
      { raw: deepLetter('deep', USER) },
    ],
  };
  const MIXED_PROCESSED = new Set(['done1', 'done2', 'active', 'foreign', 'ghost', 'nostate', 'surrogate', 'deep']);
  const LAYOUTS: Layout[] = ['hash', 'list', 'mixed'];

  describe('removing a job', () => {
    /** The removal on the old script over the list, and on the new layout, from the same seed. */
    async function removeBoth(input: Seed, ids: readonly string[], layout: Layout) {
      const oracle = keySpace(`${prefix}oracle:`);
      const head = keySpace(`${prefix}head:`);
      const client = connect();
      await seed(client, oracle, input, 'list');
      await seed(client, head, input, layout);
      for (const id of ids) {
        const userJobsKey = oracle.userJobsKey(ownerOf(parseData(await admin.hget(oracle.jobKey(id), 'data'))));
        const oracleKeys = [oracle.jobKey(id), ...oracle.stateKeys, userJobsKey, oracle.dlqKey];
        const oracleAnswer = Number(await client.eval(OLD_REMOVE_JOB_LUA_SCRIPT, oracleKeys.length, ...oracleKeys, id)) === 1;
        expect(await removeStoredJob(client, head, id, true)).toBe(oracleAnswer);
        expect(await remainingRaws(head.dlqKey)).toEqual(await remainingRaws(oracle.dlqKey));
      }
      return { oracle, head, client };
    }

    // The oracle cannot read a letter that cjson cannot decode, so the letters of the two that Lua cannot read are left out of this seed.
    const READABLE: Seed = { ...MIXED, letters: MIXED.letters.filter(({ raw }) => raw !== LONE_SURROGATE_LETTER && !raw.includes('"jobId":"deep"')) };

    it.each(LAYOUTS)('removes exactly the letters the removal that read the whole list removed, for every kind of letter, letters in the %s layout', async (layout) => {
      const ids = ['done1', 'done2', 'active', 'foreign', 'ghost', 'nostate', 'vanished', 'beyond', 'never-existed'];
      const { head, oracle } = await removeBoth(READABLE, ids, layout);

      expect(await snapshot(`${prefix}head:`)).toEqual(await snapshot(`${prefix}oracle:`));
      expect(await remainingRaws(head.dlqKey)).toEqual(await remainingRaws(oracle.dlqKey));
      await expectConsistent(head.dlqKey);
    });

    it('keeps the letters of an active job, which it does not remove, as the old script did', async () => {
      const { head } = await removeBoth(READABLE, ['active'], 'hash');

      expect((await remainingRaws(head.dlqKey)).filter((raw) => raw.includes('"active"'))).toHaveLength(2);
      await expectConsistent(head.dlqKey);
    });

    it('removes the letters of the list and of the hashes together while the migration has not run', async () => {
      const keys = keySpace(`${prefix}mixed:`);
      const client = connect();
      for (const raw of [letter('job1', USER, '-old-1'), letter('job1', USER, '-old-2'), letter('job2', USER, '-old')]) await admin.rpush(keys.dlqKey, raw);
      await addDeadLetter(client, keys.dlqKey, JSON.parse(letter('job1', USER, '-new')) as DlqEntry);
      await addDeadLetter(client, keys.dlqKey, JSON.parse(letter('job3', USER, '-new')) as DlqEntry);
      await admin.hset(keys.jobKey('job1'), 'state', 'failed', 'data', JSON.stringify({ userId: USER }));

      expect(await removeStoredJob(client, keys, 'job1', true)).toBe(true);

      expect((await remainingRaws(keys.dlqKey)).map((raw) => (JSON.parse(raw) as { failedReason: string }).failedReason).sort()).toEqual(['failed-new', 'failed-old']);
      await expectConsistent(keys.dlqKey);
    });

    it('reads no list and no letter once the list is empty, whatever the hashes hold', async () => {
      const keys = keySpace(`${prefix}covered:`);
      const client = connect();
      const jobs = Array.from({ length: 40 }, (_, n) => ({ id: `job${n}`, data: { userId: USER }, state: 'failed' }));
      await seed(client, keys, { jobs, letters: Array.from({ length: 300 }, (_, n) => ({ raw: letter(`job${n}`, USER) })) }, 'hash');
      const ranges = await serverCalls('lrange');
      const reads = await serverCalls('hget');

      for (const job of jobs) expect(await removeStoredJob(client, keys, job.id, true)).toBe(true);

      expect(await serverCalls('lrange')).toBe(ranges);
      // One HGET of the job's data a job (the owner of its index), and no HGET of a letter.
      expect(await serverCalls('hget')).toBe(reads + jobs.length * 2);
      expect(await admin.zcard(deadLetterKeys(keys.dlqKey).order)).toBe(260);
      await expectConsistent(keys.dlqKey);
    });
  });

  describe('erasing a user', () => {
    async function forgetBoth(input: Seed, processed: ReadonlySet<string>, layout: Layout) {
      const oracle = keySpace(`${prefix}oracle:`);
      const head = keySpace(`${prefix}head:`);
      const client = connect();
      await seed(client, oracle, input, 'list');
      await seed(client, head, input, layout);
      const expectedLeft = await oldForget(client, oracle, USER, processed);
      const left = await forgetUserJobs(client, head, USER, processed);
      return { left, expectedLeft, oracle, head, client };
    }

    it.each(LAYOUTS)('answers and leaves what the erasure that read the whole list did, letters in the %s layout', async (layout) => {
      const { left, expectedLeft, head, oracle } = await forgetBoth(MIXED, MIXED_PROCESSED, layout);

      expect(left).toEqual(expectedLeft);
      expect(await remainingRaws(head.dlqKey)).toEqual(await remainingRaws(oracle.dlqKey));
      expect(await snapshot(`${prefix}head:`)).toEqual(await snapshot(`${prefix}oracle:`));
      await expectConsistent(head.dlqKey);
    });

    it('does the same when the jobs are not processed, are alive, or are another user\'s', async () => {
      const { left, expectedLeft, head, oracle } = await forgetBoth(MIXED, new Set(['done1']), 'mixed');

      expect(left).toEqual(expectedLeft);
      expect(await remainingRaws(head.dlqKey)).toEqual(await remainingRaws(oracle.dlqKey));
      await expectConsistent(head.dlqKey);
    });

    it('leaves no key that names the user when every letter of the user is gone', async () => {
      const input: Seed = {
        jobs: [{ id: 'done1', data: { userId: USER }, state: 'completed' }],
        letters: [{ raw: letter('done1', USER) }, { raw: letter('vanished', USER) }, { raw: letter('kept', OTHER) }],
      };
      const { head } = await forgetBoth(input, new Set(['done1']), 'hash');

      expect(await admin.keys(`${head.dlqKey}:*${USER}*`)).toEqual([]);
      expect(await admin.keys(`${head.dlqKey}:*vanished*`)).toEqual([]);
      expect((await remainingRaws(head.dlqKey)).map((raw) => ownerOf((JSON.parse(raw) as { data: unknown }).data))).toEqual([OTHER]);
      expect(await admin.keys(`${prefix}head:*`)).not.toContain(expect.stringContaining(USER));
      await expectConsistent(head.dlqKey);
    });

    it('reads no list, no letter of another user and sends the same few round trips for a user with many jobs and letters', async () => {
      const jobs = Array.from({ length: 1100 }, (_, n) => ({ id: `job${n}`, data: { userId: USER }, state: 'completed' }));
      const letters = [
        ...jobs.map((job) => ({ raw: letter(job.id, USER) })),
        ...Array.from({ length: 600 }, (_, n) => ({ raw: letter(`gone${n}`, USER) })),
        ...Array.from({ length: 600 }, (_, n) => ({ raw: letter(`other${n}`, `user_${n % 9}`) })),
      ];
      const keys = keySpace(`${prefix}big:`);
      const client = connect();
      await seed(client, keys, { jobs, letters }, 'hash');
      const ranges = await serverCalls('lrange');
      const reads = await serverCalls('hget');

      const left = await forgetUserJobs(client, keys, USER, new Set(jobs.map((job) => job.id)));

      expect(left).toEqual([]);
      expect(await serverCalls('lrange')).toBe(ranges);
      // The state of each of the 1,100 jobs is read by the removal script, and the job of each of the 600 letters of the user that are left after it; nothing of the other users' 600.
      expect(await serverCalls('hget')).toBe(reads + 1100 + 600);
      expect(await admin.zcard(deadLetterKeys(keys.dlqKey).order)).toBe(600);
      await expectConsistent(keys.dlqKey);
    });

    it('drops the id of a letter that is gone from the set of the user, and the set of a job that has lost its hash letters', async () => {
      const keys = keySpace(`${prefix}stale:`);
      const client = connect();
      await seed(client, keys, { jobs: [], letters: [{ raw: letter('job1', USER) }, { raw: letter('job2', USER) }] }, 'hash');
      const { letterPrefix, byUserPrefix } = deadLetterKeys(keys.dlqKey);
      // Damage: the hash of one letter is lost, the sets still name it.
      const [lost] = await admin.smembers(`${byUserPrefix}${USER}`);
      await admin.del(`${letterPrefix}${lost}`);

      await forgetUserJobs(client, keys, USER, new Set());

      expect(await admin.keys(`${byUserPrefix}*`)).toEqual([]);
      expect(await admin.zcard(deadLetterKeys(keys.dlqKey).order)).toBe(0);
    });
  });

  describe('the paths of the queue that add or remove a letter', () => {
    const job = (id: string, userId: string) => ({ id, name: 'convert', data: { userId }, attemptsMade: 1, stacktrace: ['at here'], opts: {} }) as never;

    it('stores a letter as a hash under an id, scored by its time, indexed by its job and its user, and writes no list', async () => {
      const { adapter } = await adapterOn('written');
      const now = vi.spyOn(Date, 'now');
      now.mockReturnValue(5_000);
      await adapter.moveToDlq(job('job1', USER), 'first');
      now.mockReturnValue(6_000);
      await adapter.moveToDlq(job('job1', USER), 'second');
      await adapter.moveToDlq(job('job2', OTHER), 'third');
      now.mockRestore();

      const dlqKey = `${prefix}{written}:dlq`;
      const { letterPrefix, order, byJobPrefix, byUserPrefix } = deadLetterKeys(dlqKey);
      expect(await admin.exists(dlqKey)).toBe(0);
      const ids = await admin.zrange(order, '0', '-1', 'WITHSCORES');
      expect(ids.filter((_, at) => at % 2 === 1)).toEqual(['5000', '6000', '6000']);
      expect(await admin.hmget(`${letterPrefix}${ids[0]}`, 'job', 'user')).toEqual(['job1', USER]);
      expect(await admin.scard(`${byJobPrefix}job1`)).toBe(2);
      expect(await admin.scard(`${byUserPrefix}${USER}`)).toBe(2);
      expect(await admin.scard(`${byUserPrefix}${OTHER}`)).toBe(1);
      await expectConsistent(dlqKey);
    });

    it('lists the letters oldest first, those of one millisecond in the order they were written, the list of the earlier layout before them', async () => {
      const { adapter } = await adapterOn('listed');
      await admin.rpush(`${prefix}{listed}:dlq`, letter('listed-old', USER, '-old', 1));
      const now = vi.spyOn(Date, 'now');
      now.mockReturnValue(9_000);
      for (let n = 0; n < 12; n += 1) await adapter.moveToDlq(job(`job${n}`, USER), `reason ${n}`);
      now.mockReturnValue(8_000);
      await adapter.moveToDlq(job('earlier', USER), 'earlier');
      now.mockRestore();

      expect((await adapter.getDlqEntries()).map((entry) => entry.jobId)).toEqual(['listed-old', 'earlier', ...Array.from({ length: 12 }, (_, n) => `job${n}`)]);
    });

    it('lists more letters than a page', async () => {
      const { adapter, client } = await adapterOn('paged');
      const dlqKey = `${prefix}{paged}:dlq`;
      for (let n = 0; n < 1100; n += 1) await addDeadLetter(client, dlqKey, JSON.parse(letter(`job${n}`, USER, '', n + 1)) as DlqEntry);

      const entries = await adapter.getDlqEntries();

      expect(entries).toHaveLength(1100);
      expect(entries.map((entry) => entry.timestamp)).toEqual(Array.from({ length: 1100 }, (_, n) => n + 1));
    });

    it('takes a letter out of every key when the sweep trims it by age, whichever layout holds it', async () => {
      const { adapter } = await adapterOn('trim');
      const dlqKey = `${prefix}{trim}:dlq`;
      await admin.rpush(dlqKey, letter('listed-old', USER, '', 500), letter('listed-fresh', OTHER, '', 4_000_000_000_000));
      const now = vi.spyOn(Date, 'now');
      now.mockReturnValue(1_000);
      await adapter.moveToDlq(job('old1', USER), 'old');
      await adapter.moveToDlq(job('old2', OTHER), 'old');
      now.mockReturnValue(4_000_000_000_000);
      await adapter.moveToDlq(job('fresh', USER), 'fresh');
      now.mockRestore();

      await adapter.clean(60_000, 100, 'failed');

      expect((await adapter.getDlqEntries()).map((entry) => entry.jobId).sort()).toEqual(['fresh', 'listed-fresh']);
      expect(await admin.keys(`${dlqKey}:by-job:*`)).toEqual([`${dlqKey}:by-job:fresh`]);
      expect(await admin.scard(`${dlqKey}:by-user:${USER}`)).toBe(1);
      expect(await admin.exists(`${dlqKey}:by-user:${OTHER}`)).toBe(0);
      await expectConsistent(dlqKey);
    });

    it('trims letters that are not at the head of the order: it reads the order by time, not by position', async () => {
      const { adapter, client } = await adapterOn('trim-order');
      const dlqKey = `${prefix}{trim-order}:dlq`;
      // Written fresh first and old after, as two workers with different clocks would.
      await addDeadLetter(client, dlqKey, JSON.parse(letter('fresh', USER, '', 4_000_000_000_000)) as DlqEntry);
      await addDeadLetter(client, dlqKey, JSON.parse(letter('old', USER, '', 1_000)) as DlqEntry);

      await adapter.clean(60_000, 100, 'failed');

      expect((await adapter.getDlqEntries()).map((entry) => entry.jobId)).toEqual(['fresh']);
      await expectConsistent(dlqKey);
    });

    it('trims in bounded steps: more letters than one step holds all go', async () => {
      const { adapter, client } = await adapterOn('trim-steps');
      const dlqKey = `${prefix}{trim-steps}:dlq`;
      for (let n = 0; n < 2_300; n += 1) await addDeadLetter(client, dlqKey, JSON.parse(letter(`job${n}`, `user_${n % 7}`, '', 10 + n)) as DlqEntry);
      await addDeadLetter(client, dlqKey, JSON.parse(letter('fresh', USER, '', 4_000_000_000_000)) as DlqEntry);
      const scripts = await serverCalls('eval');

      await adapter.clean(60_000, 100, 'failed');

      expect((await adapter.getDlqEntries()).map((entry) => entry.jobId)).toEqual(['fresh']);
      expect((await serverCalls('eval')) - scripts).toBe(3);
      await expectConsistent(dlqKey);
    });

    it('removes every letter of both layouts when the dead letters are purged, and leaves no key', async () => {
      const dlqKey = `${prefix}{purge}:dlq`;
      await admin.rpush(dlqKey, letter('job0', USER, '-old'));
      const { adapter, client } = await adapterOn('purge');
      await adapter.moveToDlq(job('job1', USER), 'new');
      await addDeadLetter(client, dlqKey, JSON.parse(LONE_SURROGATE_LETTER) as DlqEntry);

      expect(await adapter.purgeDlq()).toBe(3);

      expect(await admin.keys(`${dlqKey}*`)).toEqual([]);
      await adapter.moveToDlq(job('job2', USER), 'later');
      expect(await adapter.purgeDlq()).toBe(1);
      expect(await admin.keys(`${dlqKey}*`)).toEqual([]);
    });

    it('takes the letters of a removed job out through the queue', async () => {
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

  describe('a letter that JSON.parse reads and the Lua scripts do not', () => {
    const GHOST_LETTERS = [
      { name: 'a lone surrogate escape', raw: LONE_SURROGATE_LETTER, jobId: 'surrogate' },
      { name: 'nesting past a thousand levels', raw: deepLetter('deep', USER), jobId: 'deep' },
    ];

    async function covered(keys: QueueKeySpace, jobs: Seed['jobs'], layout: Layout) {
      const client = connect();
      await seed(client, keys, { jobs, letters: [...GHOST_LETTERS.map(({ raw }) => ({ raw })), { raw: letter('kept', OTHER) }, { raw: letter('mine', USER) }] }, layout);
      return client;
    }

    it('is indexed by its job and its user like any other letter, and no key is kept for letters that are unreadable', async () => {
      const keys = keySpace(`${prefix}ghost:`);
      await covered(keys, [], 'hash');

      expect(await admin.keys(`${keys.dlqKey}:unparsed`)).toEqual([]);
      expect(await admin.scard(`${keys.dlqKey}:by-user:${USER}`)).toBe(3);
      await expectConsistent(keys.dlqKey);
    });

    it.each(LAYOUTS.flatMap((layout) => GHOST_LETTERS.map((ghost) => ({ layout, ...ghost }))))('is removed by the erasure of its user when its job is gone, with $name, in the $layout layout', async ({ layout }) => {
      const keys = keySpace(`${prefix}ghost-gone:`);
      const client = await covered(keys, [], layout);

      await forgetUserJobs(client, keys, USER, new Set());

      expect(await remainingRaws(keys.dlqKey)).toEqual([letter('kept', OTHER)]);
      await expectConsistent(keys.dlqKey);
    });

    it.each(LAYOUTS.flatMap((layout) => GHOST_LETTERS.map((ghost) => ({ layout, ...ghost }))))('is removed by the erasure of its user when its job is processed, with $name, in the $layout layout', async ({ jobId, layout }) => {
      const keys = keySpace(`${prefix}ghost-done:`);
      const client = await covered(keys, [{ id: jobId, data: { userId: USER }, state: 'completed' }], layout);

      expect(await forgetUserJobs(client, keys, USER, new Set([jobId]))).toEqual([]);

      expect((await remainingRaws(keys.dlqKey)).filter((raw) => raw.includes(jobId))).toEqual([]);
    });

    it('is left when its user is another one, and when its job is alive and not processed', async () => {
      const keys = keySpace(`${prefix}ghost-kept:`);
      const client = await covered(keys, [{ id: 'surrogate', data: { userId: USER }, state: 'waiting' }], 'hash');

      expect(await forgetUserJobs(client, keys, OTHER, new Set())).toEqual([]);
      expect(await forgetUserJobs(client, keys, USER, new Set())).toEqual(['surrogate']);

      const left = await remainingRaws(keys.dlqKey);
      expect(left).toContain(LONE_SURROGATE_LETTER);
      expect(left).not.toContain(deepLetter('deep', USER));
      await expectConsistent(keys.dlqKey);
    });

    it.each(LAYOUTS.flatMap((layout) => GHOST_LETTERS.map((ghost) => ({ layout, ...ghost }))))('is removed with its job by remove(id), with $name, in the $layout layout', async ({ jobId, layout }) => {
      const keys = keySpace(`${prefix}ghost-remove:`);
      const client = await covered(keys, [{ id: jobId, data: { userId: USER }, state: 'completed' }], layout);

      expect(await removeStoredJob(client, keys, jobId, true)).toBe(true);

      // The index finds a letter of the hashes, whatever it holds. A letter of the list that cjson cannot decode is not found by this step (it
      // was not before either): the erasure, which parses in the process, and the migration take it.
      const left = (await remainingRaws(keys.dlqKey)).filter((raw) => raw.includes(`"jobId":"${jobId}"`));
      if (layout === 'hash') expect(left).toEqual([]);
      await expectConsistent(keys.dlqKey);
    });

    it('goes when the sweep trims it by age', async () => {
      const { adapter, client } = await adapterOn('ghost-trim');
      const dlqKey = `${prefix}{ghost-trim}:dlq`;
      await addDeadLetter(client, dlqKey, JSON.parse(LONE_SURROGATE_LETTER) as DlqEntry);
      await addDeadLetter(client, dlqKey, JSON.parse(deepLetter('deep', OTHER)) as DlqEntry);

      await adapter.clean(60_000, 100, 'failed');

      expect(await admin.keys(`${dlqKey}*`)).toEqual([`${dlqKey}:seq`]);
    });

    it('is read by no step of the erasure of another user', async () => {
      const keys = keySpace(`${prefix}ghost-other:`);
      const client = await covered(keys, [], 'hash');
      const reads = await serverCalls('hget');

      await forgetUserJobs(client, keys, 'nobody', new Set());

      expect(await serverCalls('hget')).toBe(reads);
    });
  });

  describe('the migration of a list written by an older build', () => {
    const RAWS = [letter('job1', USER, '', 100), letter('job1', USER, '-b', 100), letter('job2', OTHER, '', 50), 'not json', letter(undefined, USER, '', 70), letter('', undefined, '-nobody', 60), '"a json string"'];

    it('counts and writes nothing without --apply', async () => {
      const dlqKey = `${prefix}{legacy}:dlq`;
      await admin.rpush(dlqKey, ...RAWS, LONE_SURROGATE_LETTER);
      const { adapter } = await adapterOn('legacy');

      const dry = await adapter.migrateDeadLetters!(false);

      expect(dry).toEqual({ letters: 8, indexed: 5, unindexed: 3, unreadable: 1, moved: 0, applied: false });
      expect(await admin.keys(`${dlqKey}*`)).toEqual([dlqKey]);
      expect(await admin.lrange(dlqKey, 0, -1)).toEqual([...RAWS, LONE_SURROGATE_LETTER]);
    });

    it('moves every letter with its time, indexed by job and user, and a second run moves nothing', async () => {
      const dlqKey = `${prefix}{legacy}:dlq`;
      await admin.rpush(dlqKey, ...RAWS, LONE_SURROGATE_LETTER, deepLetter('deep', USER));
      const { adapter } = await adapterOn('legacy');

      const applied = await adapter.migrateDeadLetters!(true);

      expect(applied).toEqual({ letters: 9, indexed: 6, unindexed: 3, unreadable: 1, moved: 9, applied: true });
      expect(await admin.exists(dlqKey)).toBe(0);
      expect(await remainingRaws(dlqKey)).toEqual([...RAWS, LONE_SURROGATE_LETTER, deepLetter('deep', USER)].sort());
      await expectConsistent(dlqKey);
      // Oldest first by the time of the letter, a text that is not JSON as the oldest (a JSON string has no time of its own).
      expect((await adapter.getDlqEntries()).map((entry) => entry.timestamp)).toEqual([0, undefined, 1, 1, 50, 60, 70, 100, 100]);

      expect(await adapter.migrateDeadLetters!(true)).toEqual({ letters: 0, indexed: 0, unindexed: 0, unreadable: 0, moved: 0, applied: true });
      await expectConsistent(dlqKey);
    });

    it('moves a list of many steps, and a run that stopped between two steps is finished by the next run', async () => {
      const dlqKey = `${prefix}{legacy-steps}:dlq`;
      for (let at = 0; at < 1300; at += 100) await admin.rpush(dlqKey, ...Array.from({ length: 100 }, (_, n) => letter(`job${at + n}`, `user_${n % 5}`, '', at + n + 1)));
      const { client } = await adapterOn('legacy-steps');
      const realEval = client.eval.bind(client) as (...args: unknown[]) => Promise<unknown>;
      let steps = 0;
      vi.spyOn(client, 'eval').mockImplementation(((...args: unknown[]) => {
        steps += 1;
        if (steps === 2) return Promise.reject(new Error('connection lost'));
        return realEval(...args);
      }) as never);

      await expect(migrateDeadLetters(client, dlqKey, true)).rejects.toThrow('connection lost');
      expect(await admin.llen(dlqKey)).toBe(800);
      vi.restoreAllMocks();

      const rest = await migrateDeadLetters(client, dlqKey, true);

      expect(rest.moved).toBe(800);
      expect(await admin.exists(dlqKey)).toBe(0);
      expect(await admin.zcard(deadLetterKeys(dlqKey).order)).toBe(1300);
      await expectConsistent(dlqKey);
    });

    it('does not store a letter that another process removed between the read of the batch and the step', async () => {
      const dlqKey = `${prefix}{legacy-race}:dlq`;
      await admin.rpush(dlqKey, letter('job1', USER, '-a'), letter('job2', USER, '-b'), letter('job3', OTHER, '-c'));
      const { client } = await adapterOn('legacy-race');
      const realRange = client.lrange.bind(client) as (...args: unknown[]) => Promise<string[]>;
      vi.spyOn(client, 'lrange').mockImplementationOnce((async (...args: unknown[]) => {
        const raws = await realRange(...args);
        await admin.lrem(dlqKey, 0, letter('job2', USER, '-b'));
        return raws;
      }) as never);

      const moved = await migrateDeadLetters(client, dlqKey, true);

      expect(moved.moved).toBe(2);
      expect((await remainingRaws(dlqKey)).sort()).toEqual([letter('job1', USER, '-a'), letter('job3', OTHER, '-c')].sort());
      await expectConsistent(dlqKey);
    });

    it('moves a letter that an older build appends after a run on the next run', async () => {
      const dlqKey = `${prefix}{legacy-late}:dlq`;
      const { adapter } = await adapterOn('legacy-late');
      await admin.rpush(dlqKey, letter('job1', USER));
      await adapter.migrateDeadLetters!(true);

      await admin.rpush(dlqKey, letter('job2', USER));
      expect(await adapter.migrateDeadLetters!(true)).toMatchObject({ letters: 1, moved: 1 });

      expect(await admin.exists(dlqKey)).toBe(0);
      await expectConsistent(dlqKey);
    });

    it('is not missed by an erasure that runs alongside it: the whole migration runs after the erasure read the list', async () => {
      const keys = keySpace(`${prefix}alongside:`);
      const oracle = keySpace(`${prefix}oracle:`);
      const client = connect();
      await seed(client, keys, MIXED, 'list');
      await seed(client, oracle, MIXED, 'list');
      const realRange = client.lrange.bind(client) as (...args: unknown[]) => Promise<string[]>;
      // The list is read; the whole migration runs; then the erasure goes on to remove what it read from the list.
      vi.spyOn(client, 'lrange').mockImplementationOnce((async (...args: unknown[]) => {
        const raws = await realRange(...args);
        await migrateDeadLetters(connect(), keys.dlqKey, true);
        return raws;
      }) as never);

      const left = await forgetUserJobs(client, keys, USER, MIXED_PROCESSED);

      expect(left).toEqual(await oldForget(connect(), oracle, USER, MIXED_PROCESSED));
      expect(await admin.exists(keys.dlqKey)).toBe(0);
      expect(await remainingRaws(keys.dlqKey)).toEqual(await remainingRaws(oracle.dlqKey));
      await expectConsistent(keys.dlqKey);
    });

    it('erases every letter of a user after the migration that it erased before it', async () => {
      const before = keySpace(`${prefix}before:`);
      const after = keySpace(`${prefix}after:`);
      const client = connect();
      await seed(client, before, MIXED, 'list');
      await seed(client, after, MIXED, 'list');

      const erasedBefore = await forgetUserJobs(client, before, USER, MIXED_PROCESSED);
      await migrateDeadLetters(client, after.dlqKey, true);
      const erasedAfter = await forgetUserJobs(client, after, USER, MIXED_PROCESSED);

      expect(erasedAfter).toEqual(erasedBefore);
      expect(await remainingRaws(after.dlqKey)).toEqual(await remainingRaws(before.dlqKey));
      await expectConsistent(after.dlqKey);
    });

    it('keeps its time ordering and trims a moved letter by age', async () => {
      const { adapter } = await adapterOn('legacy-trim');
      const dlqKey = `${prefix}{legacy-trim}:dlq`;
      await admin.rpush(dlqKey, letter('old', USER, '', 1_000), letter('fresh', USER, '', 4_000_000_000_000), 'not json');
      await adapter.migrateDeadLetters!(true);

      await adapter.clean(60_000, 100, 'failed');

      expect((await adapter.getDlqEntries()).map((entry) => entry.jobId)).toEqual(['fresh']);
      await expectConsistent(dlqKey);
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
      await addDeadLetter(client, dlqKey, JSON.parse(letter('job1', USER)) as DlqEntry);
      failScripts(client);

      await expect(adapter.remove('job1')).rejects.toBeInstanceOf(QueueUnavailableError);

      expect(await remainingRaws(dlqKey)).toEqual([letter('job1', USER)]);
    });

    it('fails the erasure of a user and leaves its letters, in either layout', async () => {
      const { adapter, client } = await adapterOn('failing');
      const dlqKey = `${prefix}{failing}:dlq`;
      await admin.zadd(`${prefix}{failing}:user_jobs:${USER}`, '1', 'job1');
      await admin.hset(`${prefix}{failing}:job:job1`, 'state', 'failed', 'data', JSON.stringify({ userId: USER }));
      await addDeadLetter(client, dlqKey, JSON.parse(letter('job1', USER)) as DlqEntry);
      await addDeadLetter(client, dlqKey, JSON.parse(letter('gone', USER)) as DlqEntry);
      await admin.rpush(dlqKey, letter('gone-listed', USER));
      failScripts(client);

      await expect(adapter.forgetUser(USER, new Set(['job1']))).rejects.toBeInstanceOf(QueueUnavailableError);

      expect(await remainingRaws(dlqKey)).toHaveLength(3);
    });

    it('fails the migration and leaves the letters in the list', async () => {
      const { adapter, client } = await adapterOn('failing');
      const dlqKey = `${prefix}{failing}:dlq`;
      await admin.rpush(dlqKey, letter('job1', USER));
      failScripts(client);

      await expect(adapter.migrateDeadLetters!(true)).rejects.toBeInstanceOf(QueueUnavailableError);

      expect(await admin.lrange(dlqKey, 0, -1)).toEqual([letter('job1', USER)]);
    });
  });
});
