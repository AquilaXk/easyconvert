import crypto from 'node:crypto';
import Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readyGatedRedis } from '../src/lib/redis/when-ready';
import { WebhookDlqStore } from '../src/lib/api-keys/webhook-dlq-store';
import type { WebhookDlqEntry } from '../src/lib/api-keys/types';

/**
 * The webhook dead letters of a user are read from a sorted set of their ids, scored by the time they failed, so a request reads
 * the page it shows and never the whole queue; the entries stay one JSON value each in a hash. Entries an older build wrote
 * without the index are indexed when the hash holds more entries than the expiry set. Like the other Redis suites it runs when
 * REDIS_URL is set. The keys are shared with the rest of the application, so each case uses owners of its own and removes
 * only what it wrote.
 */
const REDIS_URL = process.env.REDIS_URL;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const HASH = 'easyconvert:webhook:dlq';

function entry(id: string, ownerUserId: string | undefined, failedAt: number): WebhookDlqEntry {
  return {
    id,
    originalDeliveryId: `wh_${id}`,
    targetUrl: 'https://93.184.215.14/hooks/easyconvert',
    event: 'job.failed',
    payload: { jobId: id },
    secret: 'sealed',
    failedAt,
    retryCount: 3,
    status: 'failed',
    ownerUserId,
  };
}

// skip-ok: mode selection. The shards run without REDIS_URL; the Redis-mode CI step (npm run test:redis) sets it and runs this file.
describe.skipIf(!REDIS_URL)('the per-owner index of webhook dead letters in Redis', () => {
  let admin: Redis;
  let client: Redis;
  let store: WebhookDlqStore;
  let alice: string;
  let bob: string;
  const written: string[] = [];

  const ownerKey = (owner: string) => `${HASH}:owner:{${owner}}`;
  const save = async (id: string, owner: string | undefined, failedAt = Date.now()) => {
    written.push(id);
    await store.put(entry(id, owner, failedAt));
  };
  const idsOf = async (owner: string, options?: Parameters<WebhookDlqStore['page']>[1]) => (await store.page(owner, options)).entries.map((e) => e.id);

  beforeEach(() => {
    const suffix = crypto.randomBytes(6).toString('hex');
    alice = `dlq-alice-${suffix}`;
    bob = `dlq-bob-${suffix}`;
    admin = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
    client = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
    store = new WebhookDlqStore(new Map(), () => client, RETENTION_MS);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const owner of [alice, bob]) await store.clear(owner);
    if (written.length > 0) {
      await admin.hdel(HASH, ...written);
      await admin.zrem(`${HASH}:expiry`, ...written);
      await admin.zrem(`${HASH}:ownerless`, ...written);
    }
    written.length = 0;
    await admin.quit();
    await client.quit();
  });

  it('lists a page of one owner newest first with the total, and never an entry of another owner', async () => {
    const now = Date.now();
    for (let n = 0; n < 5; n += 1) await save(`${alice}-${n}`, alice, now - n * 1000);
    await save(`${bob}-0`, bob, now);

    const first = await store.page(alice, { limit: 2 });
    expect(first.entries.map((e) => e.id)).toEqual([`${alice}-0`, `${alice}-1`]);
    expect(first.total).toBe(5);
    expect(await idsOf(alice, { limit: 2, offset: 2 })).toEqual([`${alice}-2`, `${alice}-3`]);
    expect(await idsOf(bob)).toEqual([`${bob}-0`]);
    expect(await idsOf(`dlq-nobody-${alice}`)).toEqual([]);
  });

  it('reads the index and the entries of the page only: no scan of the hash or the keyspace', async () => {
    for (let n = 0; n < 30; n += 1) await save(`${alice}-${n}`, alice, Date.now() - n);
    for (let n = 0; n < 30; n += 1) await save(`${bob}-${n}`, bob, Date.now() - n);
    const names: string[] = [];
    const prototype = Redis.prototype as unknown as { sendCommand: (this: unknown, command: { name: string }, ...rest: unknown[]) => unknown };
    const real = prototype.sendCommand;
    const send = vi.spyOn(prototype, 'sendCommand').mockImplementation(function (this: unknown, command, ...rest) {
      names.push(command.name);
      return real.call(this, command, ...rest);
    });
    await store.page(alice, { limit: 10 });
    send.mockRestore();

    expect(names.filter((name) => ['hgetall', 'hscan', 'scan', 'keys'].includes(name))).toEqual([]);
    expect(names.length).toBeLessThanOrEqual(7);
  });

  it('does not list or delete an entry another owner holds when an index names it', async () => {
    await save(`${alice}-0`, alice);
    await save(`${bob}-0`, bob);
    await admin.zadd(ownerKey(alice), Date.now(), `${bob}-0`);

    expect(await idsOf(alice)).toEqual([`${alice}-0`]);
    expect(await admin.zscore(ownerKey(alice), `${bob}-0`)).toBeNull();
    await admin.zadd(ownerKey(alice), Date.now(), `${bob}-0`);
    await store.clear(alice);
    expect(await idsOf(bob)).toEqual([`${bob}-0`]);
  });

  it('indexes entries an older build wrote without an index, drops what nobody can read, and purges the ownerless ones', async () => {
    const now = Date.now();
    await admin.hset(HASH, `${alice}-legacy`, JSON.stringify(entry(`${alice}-legacy`, alice, now - 5)));
    await admin.hset(HASH, `${bob}-legacy`, JSON.stringify(entry(`${bob}-legacy`, bob, now - 4)));
    await admin.hset(HASH, `${alice}-ownerless`, JSON.stringify(entry(`${alice}-ownerless`, undefined, now - 3)));
    await admin.hset(HASH, `${alice}-garbage`, '{not json');
    written.push(`${alice}-legacy`, `${bob}-legacy`, `${alice}-ownerless`, `${alice}-garbage`);

    // The first listing starts the pass and does not wait for it; the listings that follow find the entries indexed.
    await idsOf(alice);
    await vi.waitFor(async () => expect(await idsOf(alice)).toEqual([`${alice}-legacy`]));
    expect(await idsOf(bob)).toEqual([`${bob}-legacy`]);
    expect(await admin.hexists(HASH, `${alice}-ownerless`)).toBe(0);
    expect(await admin.hexists(HASH, `${alice}-garbage`)).toBe(0);
  });

  it('removes the expired entries from the hash and from the index, and keeps the younger ones', async () => {
    const now = Date.now();
    await save(`${alice}-old`, alice, now - RETENTION_MS - 1000);
    await save(`${alice}-new`, alice, now - RETENTION_MS + 60_000);

    expect(await idsOf(alice)).toEqual([`${alice}-new`]);
    expect(await idsOf(alice, { includeExpired: true })).toEqual([`${alice}-new`, `${alice}-old`]);
    expect(await store.purgeExpired(now)).toBeGreaterThanOrEqual(1);
    expect(await admin.hexists(HASH, `${alice}-old`)).toBe(0);
    expect(await admin.zscore(ownerKey(alice), `${alice}-old`)).toBeNull();
    expect(await idsOf(alice)).toEqual([`${alice}-new`]);
  });

  it('removes every entry of an owner in batches, leaves other owners alone, and leaves no key of the owner behind', async () => {
    const pipeline = client.pipeline();
    for (let n = 0; n < 620; n += 1) {
      written.push(`${alice}-${n}`);
      const e = entry(`${alice}-${n}`, alice, Date.now() - n);
      pipeline.zadd(`${HASH}:expiry`, e.failedAt, e.id).zadd(ownerKey(alice), e.failedAt, e.id).hset(HASH, e.id, JSON.stringify(e));
    }
    await pipeline.exec();
    await save(`${bob}-0`, bob);

    await store.clear(alice);

    expect(await admin.exists(ownerKey(alice))).toBe(0);
    expect(await admin.hexists(HASH, `${alice}-619`)).toBe(0);
    expect(await idsOf(bob)).toEqual([`${bob}-0`]);
  });

  it('clears the entries after a whole batch of strays that another owner holds, and the index key goes', async () => {
    const strays = client.pipeline();
    for (let n = 0; n < 520; n += 1) {
      const e = entry(`${bob}-${n}`, bob, Date.now() - 100_000 - n);
      written.push(e.id);
      strays.zadd(`${HASH}:expiry`, e.failedAt, e.id).zadd(ownerKey(bob), e.failedAt, e.id).hset(HASH, e.id, JSON.stringify(e));
      // The index of alice names them too, with older scores than her own entries, so the first batch of 500 holds only strays.
      strays.zadd(ownerKey(alice), e.failedAt, e.id);
    }
    await strays.exec();
    for (let n = 0; n < 3; n += 1) await save(`${alice}-${n}`, alice, Date.now() - n);

    await store.clear(alice);

    expect(await admin.exists(ownerKey(alice))).toBe(0);
    for (let n = 0; n < 3; n += 1) expect(await admin.hexists(HASH, `${alice}-${n}`)).toBe(0);
    expect(await admin.zscore(`${HASH}:expiry`, `${alice}-0`)).toBeNull();
    expect(await admin.hexists(HASH, `${bob}-0`)).toBe(1);
    expect(await admin.zcard(ownerKey(bob))).toBe(520);
  });

  it('keeps an index key that `erase-account` finds by the user tag, and lets it expire', async () => {
    await save(`${alice}-0`, alice);

    const keys = await admin.keys(`*{${alice}}*`);
    expect(keys).toEqual([ownerKey(alice)]);
    expect(await admin.pttl(ownerKey(alice))).toBeGreaterThan(RETENTION_MS);
  });

  it('drops an id from the index when its entry is gone', async () => {
    await save(`${alice}-0`, alice);
    await save(`${alice}-1`, alice);
    await admin.hdel(HASH, `${alice}-1`);

    expect(await idsOf(alice)).toEqual([`${alice}-0`]);
    expect(await admin.zscore(ownerKey(alice), `${alice}-1`)).toBeNull();
  });

  it('removes one entry from the hash and every index', async () => {
    await save(`${alice}-0`, alice);

    expect(await store.remove([entry(`${alice}-0`, alice, 0)])).toBe(true);
    expect(await store.remove([entry(`${alice}-0`, alice, 0)])).toBe(false);
    expect(await admin.zscore(`${HASH}:expiry`, `${alice}-0`)).toBeNull();
    expect(await idsOf(alice)).toEqual([]);
  });

  it('writes and lists through a client that has not finished connecting, as the first request after a start does', async () => {
    const fresh = readyGatedRedis(new Redis(REDIS_URL as string, { enableOfflineQueue: false, maxRetriesPerRequest: 1 }));
    const early = new WebhookDlqStore(new Map(), () => fresh, RETENTION_MS);
    written.push(`${alice}-0`);

    await early.put(entry(`${alice}-0`, alice, Date.now()));

    expect(await admin.hexists(HASH, `${alice}-0`)).toBe(1);
    expect((await early.page(alice)).entries.map((e) => e.id)).toEqual([`${alice}-0`]);
    await fresh.quit();
  });
});
