import crypto from 'node:crypto';
import Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebhookDlqStore } from '../src/lib/api-keys/webhook-dlq-store';
import type { WebhookDlqEntry } from '../src/lib/api-keys/types';

/**
 * A page of the webhook dead letters is always as full as the owner's entries allow (an id whose entry is gone fills no place), the
 * total is counted after those ids leave, and the pass that indexes the entries of an older build runs behind the request, a bounded
 * number of batches at a time. Like the other Redis suites it runs when REDIS_URL is set; each case uses an owner of its own.
 */
const REDIS_URL = process.env.REDIS_URL;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const HASH = 'easyconvert:webhook:dlq';

function entry(id: string, ownerUserId: string, failedAt: number): WebhookDlqEntry {
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
describe.skipIf(!REDIS_URL)('a page of webhook dead letters in Redis', () => {
  let admin: Redis;
  let client: Redis;
  let alice: string;
  const written: string[] = [];

  const ownerKey = (owner: string) => `${HASH}:owner:{${owner}}`;
  const storeOf = (batchesPerPass?: number) => new WebhookDlqStore(new Map(), () => client, RETENTION_MS, batchesPerPass);

  beforeEach(() => {
    alice = `dlq-fill-${crypto.randomBytes(6).toString('hex')}`;
    admin = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
    client = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await storeOf().clear(alice);
    if (written.length > 0) {
      await admin.hdel(HASH, ...written);
      await admin.zrem(`${HASH}:expiry`, ...written);
    }
    written.length = 0;
    await admin.del(ownerKey(alice));
    await admin.quit();
    await client.quit();
  });

  it('is filled past ids whose entries are gone, and counts the total without them', async () => {
    const store = storeOf();
    const now = Date.now();
    // Five ids at the newest places of the index have no entry (a write that stopped between the index and the hash).
    for (let n = 0; n < 5; n += 1) await admin.zadd(ownerKey(alice), now - n, `${alice}-ghost-${n}`);
    for (let n = 0; n < 3; n += 1) {
      written.push(`${alice}-real-${n}`);
      await store.put(entry(`${alice}-real-${n}`, alice, now - 10_000 - n));
    }

    const page = await store.page(alice, { limit: 3 });

    expect(page.entries.map((e) => e.id)).toEqual([`${alice}-real-0`, `${alice}-real-1`, `${alice}-real-2`]);
    expect(page.total).toBe(3);
    expect(await admin.zcard(ownerKey(alice))).toBe(3);
  });

  it('answers the next page after ids of the first were gone, by the places of the entries that are there', async () => {
    const store = storeOf();
    const now = Date.now();
    await admin.zadd(ownerKey(alice), now, `${alice}-ghost`);
    for (let n = 0; n < 4; n += 1) {
      written.push(`${alice}-real-${n}`);
      await store.put(entry(`${alice}-real-${n}`, alice, now - 1_000 * (n + 1)));
    }

    const first = await store.page(alice, { limit: 2 });
    const second = await store.page(alice, { limit: 2, offset: 2 });

    expect(first.entries.map((e) => e.id)).toEqual([`${alice}-real-0`, `${alice}-real-1`]);
    expect(second.entries.map((e) => e.id)).toEqual([`${alice}-real-2`, `${alice}-real-3`]);
  });

  it('answers a listing without waiting for the pass that indexes the entries an older build wrote', async () => {
    const store = storeOf();
    written.push(`${alice}-legacy`);
    await admin.hset(HASH, `${alice}-legacy`, JSON.stringify(entry(`${alice}-legacy`, alice, Date.now() - 5)));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const realScan = client.hscan.bind(client) as (...args: unknown[]) => Promise<[string, string[]]>;
    vi.spyOn(client, 'hscan').mockImplementation((async (...args: unknown[]) => {
      await gate;
      return realScan(...args);
    }) as never);

    const answered = await Promise.race([store.page(alice), new Promise<'waited'>((resolve) => setTimeout(() => resolve('waited'), 3_000))]);
    expect(answered).not.toBe('waited');

    release();
    await vi.waitFor(async () => expect((await store.page(alice)).entries.map((e) => e.id)).toEqual([`${alice}-legacy`]));
  });

  it('reads a bounded number of batches in a pass and resumes where it stopped, indexing every entry in the end', async () => {
    const store = storeOf(1);
    const now = Date.now();
    const pipeline = admin.pipeline();
    for (let n = 0; n < 1_300; n += 1) {
      written.push(`${alice}-bulk-${n}`);
      pipeline.hset(HASH, `${alice}-bulk-${n}`, JSON.stringify(entry(`${alice}-bulk-${n}`, alice, now - n)));
    }
    await pipeline.exec();
    const hscans = vi.spyOn(client, 'hscan');
    const clock = vi.spyOn(Date, 'now');
    let at = now;
    clock.mockImplementation(() => at);

    for (let pass = 0; pass < 12 && (await admin.zcard(`${HASH}:expiry`)) < (await admin.hlen(HASH)); pass += 1) {
      await store.page(alice);
      const before = hscans.mock.calls.length;
      await vi.waitFor(() => expect(hscans.mock.calls.length).toBeGreaterThan(0));
      // The pass is bounded: one batch for each page asked.
      expect(hscans.mock.calls.length - before).toBeLessThanOrEqual(1);
      at += 11_000;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(await admin.zcard(ownerKey(alice))).toBe(1_300);
    expect(hscans.mock.calls.length).toBeGreaterThan(1);
    clock.mockRestore();
  }, 30_000);
});
