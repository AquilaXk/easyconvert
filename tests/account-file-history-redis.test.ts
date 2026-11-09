import crypto from 'node:crypto';
import Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { MAX_FILE_HISTORY_PER_USER, RedisUserFileHistory } from '../src/lib/api-keys/user-file-history';

/**
 * The history of converted files is kept in Redis, next to the other account data: every process sees a record the others
 * wrote, a delete removes it for all of them, and the record expires with the result it names. Like the other Redis suites it
 * runs when REDIS_URL is set.
 */
const REDIS_URL = process.env.REDIS_URL;

function file(userId: string, name: string, extra: { id?: string; ttlMs?: number } = {}) {
  return {
    userId,
    fileName: name,
    fromFormat: 'csv',
    toFormat: 'json',
    size: 4,
    downloadUrl: `/api/storage/file/${encodeURIComponent(`results/${name}`)}`,
    storageKey: `results/${name}`,
    ...extra,
  };
}

// skip-ok: mode selection. The shards run without REDIS_URL; the Redis-mode CI step (npm run test:redis) sets it and runs this file.
describe.skipIf(!REDIS_URL)('the history of converted files in Redis', () => {
  let keyPrefix: string;
  let admin: Redis;
  const stores: RedisKeyStore[] = [];
  let userId: string;

  /** A store as another process would hold it: its own memory and connection, the same Redis. */
  function processStore(): RedisKeyStore {
    const store = new RedisKeyStore({ keyPrefix, isolated: true, redisClient: new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 }) });
    stores.push(store);
    return store;
  }

  beforeEach(() => {
    keyPrefix = `file-history-${crypto.randomBytes(6).toString('hex')}:`;
    userId = `user-${crypto.randomUUID()}`;
    admin = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    while (stores.length > 0) await stores.pop()!.close();
    const keys = await admin.keys(`${keyPrefix}*`);
    if (keys.length > 0) await admin.del(...keys);
    await admin.quit();
  });

  it('lists in one process a record another process wrote, newest first, and finds it by id', async () => {
    const web = processStore();
    const worker = processStore();
    const first = await worker.recordUserFile(file(userId, 'one.json'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await worker.recordUserFile(file(userId, 'two.json'));

    expect((await web.listUserFiles(userId)).map((entry) => entry.id)).toEqual([second.id, first.id]);
    expect(await web.findUserFile(userId, first.id)).toEqual(first);
  });

  it('deletes a record for every process, and only for its owner', async () => {
    const web = processStore();
    const worker = processStore();
    const record = await worker.recordUserFile(file(userId, 'gone.json'));
    const other = `user-${crypto.randomUUID()}`;

    expect(await web.deleteUserFile(other, record.id)).toBe(false);
    expect(await web.findUserFile(other, record.id)).toBeUndefined();
    expect(await web.deleteUserFile(userId, record.id)).toBe(true);
    expect(await worker.listUserFiles(userId)).toEqual([]);
    expect(await web.deleteUserFile(userId, record.id)).toBe(false);
  });

  it('keeps the records of one user apart from those of another', async () => {
    const store = processStore();
    const other = `user-${crypto.randomUUID()}`;
    await store.recordUserFile(file(userId, 'mine.json'));
    await store.recordUserFile(file(other, 'theirs.json'));

    expect((await store.listUserFiles(userId)).map((entry) => entry.fileName)).toEqual(['mine.json']);
  });

  it('expires a record with the result: the key lives as long as the retention says and the list leaves it out after', async () => {
    const store = processStore();
    const record = await store.recordUserFile(file(userId, 'short.json', { ttlMs: 400 }));
    const longer = await store.recordUserFile(file(userId, 'long.json', { ttlMs: 60_000 }));

    const ttl = await admin.pttl(`${keyPrefix}user_file:{${userId}}:${record.id}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(400);
    expect(await admin.pttl(`${keyPrefix}user_files:{${userId}}`)).toBeGreaterThan(400);

    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((await store.listUserFiles(userId)).map((entry) => entry.id)).toEqual([longer.id]);
    expect(await store.findUserFile(userId, record.id)).toBeUndefined();
    const newest = await store.recordUserFile(file(userId, 'next.json', { ttlMs: 60_000 }));
    expect(new Set(await admin.zrange(`${keyPrefix}user_files:{${userId}}`, '0', '-1'))).toEqual(new Set([longer.id, newest.id]));
  });

  it('records a job result once whatever the number of times it is recorded', async () => {
    const store = processStore();
    await store.recordUserFile(file(userId, 'job.json', { id: 'job_1' }));
    await store.recordUserFile(file(userId, 'job.json', { id: 'job_1' }));

    expect(await store.listUserFiles(userId)).toHaveLength(1);
    expect(await admin.zcard(`${keyPrefix}user_files:{${userId}}`)).toBe(1);
  });

  it('keeps at most the cap, dropping the records that expire first together with their keys', async () => {
    const history = new RedisUserFileHistory(admin, keyPrefix, 3);
    const now = Date.now();
    const files = [1, 2, 3, 4].map((n) => ({ ...file(userId, `f${n}.json`, { id: `f${n}` }), id: `f${n}`, createdAt: now + n, expiresAt: now + 60_000 + n }));
    for (const entry of files) await history.record(entry, now);

    expect((await history.list(userId, now)).map((entry) => entry.id)).toEqual(['f4', 'f3', 'f2']);
    expect(await admin.exists(`${keyPrefix}user_file:{${userId}}:f1`)).toBe(0);
    expect(MAX_FILE_HISTORY_PER_USER).toBeGreaterThan(3);
  });

  it('forgets every record of a user, in Redis and in this process, and counts them', async () => {
    const store = processStore();
    const other = `user-${crypto.randomUUID()}`;
    await store.recordUserFile(file(userId, 'a.json'));
    await store.recordUserFile(file(userId, 'b.json'));
    const kept = await store.recordUserFile(file(other, 'kept.json'));

    expect(await store.forgetUsage(userId)).toBe(2);

    expect(await store.listUserFiles(userId)).toEqual([]);
    expect(await admin.keys(`${keyPrefix}*{${userId}}*`)).toEqual([]);
    expect((await store.listUserFiles(other)).map((entry) => entry.id)).toEqual([kept.id]);
  });

  it('keeps a record in this process when Redis does not answer, and still lists it', async () => {
    const store = processStore();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(RedisUserFileHistory.prototype, 'record').mockRejectedValueOnce(new Error('connection lost'));

    const record = await store.recordUserFile(file(userId, 'local.json'));

    expect((await store.listUserFiles(userId)).map((entry) => entry.id)).toEqual([record.id]);
    expect(await store.deleteUserFile(userId, record.id)).toBe(true);
  });

  it('lists a record once and deletes it from both stores when the same id is in this process and in Redis', async () => {
    const store = processStore();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // The outage: the record stays in this process; the same job then completes again into Redis under the same id.
    vi.spyOn(RedisUserFileHistory.prototype, 'record').mockRejectedValueOnce(new Error('connection lost'));
    await store.recordUserFile(file(userId, 'twice.json', { id: 'job_twice' }));
    await store.recordUserFile(file(userId, 'twice.json', { id: 'job_twice' }));

    expect((await store.listUserFiles(userId)).map((entry) => entry.id)).toEqual(['job_twice']);
    expect(await store.deleteUserFile(userId, 'job_twice')).toBe(true);

    expect(await store.listUserFiles(userId)).toEqual([]);
    expect(await store.findUserFile(userId, 'job_twice')).toBeUndefined();
    expect(await processStore().listUserFiles(userId)).toEqual([]);
  });

  it('gives Redis an integer expiry when the retention comes out fractional', async () => {
    const store = processStore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const record = await store.recordUserFile(file(userId, 'fraction.json', { ttlMs: 1500.5 }));

    expect(warn).not.toHaveBeenCalled();
    const ttl = await admin.pttl(`${keyPrefix}user_file:{${userId}}:${record.id}`);
    expect(ttl).toBeGreaterThan(1000);
    expect(ttl).toBeLessThanOrEqual(1501);
    expect((await processStore().listUserFiles(userId)).map((entry) => entry.id)).toEqual([record.id]);
  });
});
