import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import Redis from 'ioredis';
import { RedisRetentionLedger, setRetentionLedger } from '../src/lib/storage/retention-ledger';
import { recordServed, registerResult, resultAvailability, sweepRetention } from '../src/lib/storage/retention-service';
import { resolveRetentionPolicy } from '../src/lib/storage/result-retention';

/**
 * The retention records of a scaled-out deployment live in Redis, so every web instance and worker sees the
 * same delivery. Runs only when REDIS_URL is set (see npm run test:redis).
 */

const REDIS_URL = process.env.REDIS_URL;
const POLICY = resolveRetentionPolicy({});
const SECOND_MS = 1000;

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
});
