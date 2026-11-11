import crypto from 'node:crypto';
import Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisRetentionLedger, setRetentionLedger } from '../src/lib/storage/retention-ledger';
import { resultAvailabilities, resultAvailability } from '../src/lib/storage/retention-service';
import { markGone, newRecord, resolveRetentionPolicy } from '../src/lib/storage/result-retention';

/**
 * The availability of a list of results (the dashboard's files) is read with a few `MGET`, one for every hundred keys, and answers
 * what `resultAvailability` answers key by key. Like the other Redis suites it runs when REDIS_URL is set.
 */
const REDIS_URL = process.env.REDIS_URL;
const POLICY = resolveRetentionPolicy({});

// skip-ok: mode selection. The shards run without REDIS_URL; the Redis-mode CI step (npm run test:redis) sets it and runs this file.
describe.skipIf(!REDIS_URL)('batched result availability over the Redis retention ledger', () => {
  let redis: Redis;
  let ledger: RedisRetentionLedger;
  let owner: string;
  const keys: string[] = [];

  beforeEach(() => {
    owner = `batch-${crypto.randomBytes(6).toString('hex')}`;
    redis = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
    ledger = new RedisRetentionLedger(redis);
    setRetentionLedger(ledger);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setRetentionLedger(undefined);
    for (const key of keys) await ledger.forget(key);
    keys.length = 0;
    await redis.quit();
  });

  async function record(name: string, gone = false): Promise<string> {
    const key = `conversions/${owner}/${name}`;
    keys.push(key);
    const now = Date.now();
    await ledger.update(key, () => (gone ? markGone(newRecord(key, now, POLICY), now, 'capacity') : newRecord(key, now, POLICY)));
    return key;
  }

  it('answers what resultAvailability answers for each key, in order, for kept, deleted, unknown and unretained keys', async () => {
    const kept = await record('kept.json');
    const gone = await record('gone.json', true);
    const unknown = `conversions/${owner}/unknown.json`;
    const unretained = 'uploads/not-retained.bin';

    const keysAsked = [kept, undefined, gone, unknown, unretained, kept];
    const batch = await resultAvailabilities(keysAsked);

    expect(batch).toEqual(await Promise.all(keysAsked.map((key) => (key ? resultAvailability(key) : undefined))));
    expect(batch[0]?.state).toBe('available');
    expect(batch[2]?.state).toBe('deleted');
    expect(batch[3]).toBeUndefined();
  });

  it('reads 250 keys with three MGET and no GET', async () => {
    const asked: string[] = [];
    for (let n = 0; n < 250; n += 1) asked.push(await record(`f${n}.json`));
    const names: string[] = [];
    const prototype = Redis.prototype as unknown as { sendCommand: (this: unknown, command: { name: string }, ...rest: unknown[]) => unknown };
    const real = prototype.sendCommand;
    vi.spyOn(prototype, 'sendCommand').mockImplementation(function (this: unknown, command, ...rest) {
      names.push(command.name);
      return real.call(this, command, ...rest);
    });

    const batch = await resultAvailabilities(asked);

    expect(batch.every((availability) => availability?.state === 'available')).toBe(true);
    expect(names).toEqual(['mget', 'mget', 'mget']);
  });

  it('leaves every state unknown, and does not throw, while the ledger cannot be read', async () => {
    const kept = await record('kept.json');
    vi.spyOn(ledger, 'getMany').mockRejectedValue(new Error('redis down'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(await resultAvailabilities([kept, kept])).toEqual([undefined, undefined]);
  });
});
