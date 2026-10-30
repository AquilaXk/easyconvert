import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import Redis from 'ioredis';
import {
  RETENTION_REDIS_PREFIX,
  RedisRetentionLedger,
  getRetentionLedger,
  setRetentionLedger,
} from '../src/lib/storage/retention-ledger';
import {
  recordServed,
  registerResult,
  resultAvailability,
  startRetentionSweep,
  stopRetentionSweep,
  sweepRetention,
} from '../src/lib/storage/retention-service';
import { recordServedRange, resolveRetentionPolicy } from '../src/lib/storage/result-retention';

/**
 * The retention records of a scaled-out deployment live in Redis, so every web instance and worker sees the
 * same delivery. Runs only when REDIS_URL is set (see npm run test:redis).
 */

const REDIS_URL = process.env.REDIS_URL;
const POLICY = resolveRetentionPolicy({});
const SECOND_MS = 1000;

// skip-ok: needs a Redis server; `npm run test:redis` provides one and tests/redis-suites-registered.test.ts holds this file in that script.
describe.skipIf(!REDIS_URL)('retention records in Redis', () => {
  let redis: Redis;
  const deleted: string[] = [];
  const storage = { deleteObject: async (key: string) => (deleted.push(key), true) };

  beforeAll(() => {
    redis = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 2 });
    setRetentionLedger(new RedisRetentionLedger(redis));
  });

  afterEach(() => {
    deleted.length = 0;
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    setRetentionLedger(undefined);
    await redis.quit();
  });

  function newKey(): string {
    return `conversions/user-redis/${Date.now()}_${crypto.randomBytes(4).toString('hex')}.bin`;
  }

  it('deletes a delivered result after the grace period and then reports it as deleted', async () => {
    const key = newKey();
    await registerResult(key);
    await recordServed(key, { first: 0, last: 9, size: 10 });

    await sweepRetention(storage, Date.now() + POLICY.deliveredGraceMs - SECOND_MS);
    expect(deleted).not.toContain(key);
    await sweepRetention(storage, Date.now() + POLICY.deliveredGraceMs + SECOND_MS);
    expect(deleted).toContain(key);
    expect(await resultAvailability(key, Date.now() + POLICY.deliveredGraceMs + SECOND_MS)).toMatchObject({ state: 'deleted', reason: 'delivered' });
  });

  it('deletes a result nobody fetched after the undelivered time', async () => {
    const key = newKey();
    await registerResult(key);

    await sweepRetention(storage, Date.now() + POLICY.undeliveredTtlMs - SECOND_MS);
    expect(deleted).not.toContain(key);
    await sweepRetention(storage, Date.now() + POLICY.undeliveredTtlMs + SECOND_MS);
    expect(deleted).toContain(key);
  });

  it('keeps the ranges that were sent across calls', async () => {
    const key = newKey();
    await registerResult(key);
    await recordServed(key, { first: 0, last: 4, size: 10 });
    expect((await resultAvailability(key))?.deliveredAt).toBeUndefined();
    await recordServed(key, { first: 5, last: 9, size: 10 });
    expect((await resultAvailability(key))?.deliveredAt).toBeTypeOf('number');
  });

  it('keeps every range when two instances record pieces of one file at the same moment', async () => {
    const key = newKey();
    await registerResult(key);
    const second = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 2 });
    const instances = [new RedisRetentionLedger(redis), new RedisRetentionLedger(second)];
    const now = Date.now();
    await Promise.all(
      Array.from({ length: 10 }, (_, offset) =>
        instances[offset % 2].update(key, (current) => current && recordServedRange(current, { first: offset, last: offset, size: 10 }, now, POLICY))
      )
    );
    expect((await instances[1].get(key))?.received).toEqual([[0, 9]]);
    expect((await resultAvailability(key))?.deliveredAt).toBe(now);
    await second.quit();
  });

  it('keeps every range when 32 updates from four instances race on one record', async () => {
    const UPDATES = 32;
    const instances = Array.from({ length: 4 }, () => new Redis(REDIS_URL as string, { maxRetriesPerRequest: 2 }));
    const ledgers = instances.map((client) => new RedisRetentionLedger(client));
    const key = newKey();
    await registerResult(key);
    const now = Date.now();
    try {
      const results = await Promise.allSettled(
        Array.from({ length: UPDATES }, (_, i) =>
          ledgers[i % ledgers.length].update(key, (current) => current && recordServedRange(current, { first: i, last: i, size: UPDATES }, now, POLICY))
        )
      );
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(0);
      expect((await ledgers[0].get(key))?.received).toEqual([[0, UPDATES - 1]]);
    } finally {
      for (const client of instances) client.disconnect();
    }
  });

  it('drops a due key whose record is gone and still deletes the keys behind it', async () => {
    const orphan = newKey();
    const due = `${RETENTION_REDIS_PREFIX}due`;
    await redis.zadd(due, 1, orphan);
    const key = newKey();
    await registerResult(key);

    await sweepRetention(storage, Date.now() + POLICY.undeliveredTtlMs + SECOND_MS);
    expect(deleted).toContain(key);
    expect(await redis.zscore(due, orphan)).toBeNull();
  });

  it('moves a result whose deletion failed behind the others', async () => {
    const poison = newKey();
    const fresh = newKey();
    await registerResult(poison);
    await registerResult(fresh);
    const failing = {
      deleteObject: async (key: string) => {
        if (key === poison) throw new Error('object store refused');
        return storage.deleteObject(key);
      },
    };
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const due = Date.now() + POLICY.undeliveredTtlMs + SECOND_MS;

    await sweepRetention(failing, due);
    expect(deleted).toContain(fresh);
    expect(Number(await redis.zscore(`${RETENTION_REDIS_PREFIX}due`, poison))).toBeGreaterThan(due);
  });

  it('runs the start-up sweep once the connection the environment selects is ready', async () => {
    const key = newKey();
    await registerResult(key);
    await new RedisRetentionLedger(redis).update(key, (current) => current && { ...current, deleteAt: Date.now() - SECOND_MS });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setRetentionLedger(undefined);
    const selected = getRetentionLedger();
    try {
      startRetentionSweep(storage);
      await vi.waitFor(() => expect(deleted).toContain(key), { timeout: 2_000 });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      stopRetentionSweep();
      (selected as unknown as { redis: Redis }).redis.disconnect();
      setRetentionLedger(new RedisRetentionLedger(redis));
    }
  });
});
