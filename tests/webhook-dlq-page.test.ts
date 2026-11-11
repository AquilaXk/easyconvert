import { beforeEach, describe, expect, it } from 'vitest';
import { DLQ_PAGE_DEFAULT, DLQ_PAGE_MAX, WebhookDlqStore } from '../src/lib/api-keys/webhook-dlq-store';
import type { WebhookDlqEntry } from '../src/lib/api-keys/types';

/** The pages of dead letters without Redis (the in-memory store): the same answers as the indexed Redis store gives. */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function entry(id: string, ownerUserId: string | undefined, failedAt: number): WebhookDlqEntry {
  return {
    id,
    originalDeliveryId: `wh_${id}`,
    targetUrl: 'https://93.184.215.14/hooks/easyconvert',
    event: 'job.failed',
    payload: {},
    secret: 'sealed',
    failedAt,
    retryCount: 3,
    status: 'failed',
    ownerUserId,
  };
}

describe('Webhook dead letter pages (in memory)', () => {
  let memory: Map<string, WebhookDlqEntry>;
  let store: WebhookDlqStore;
  const now = Date.now();

  beforeEach(() => {
    memory = new Map();
    store = new WebhookDlqStore(memory, () => null, RETENTION_MS);
  });

  it('pages the entries of one owner newest first and counts all of them', async () => {
    for (let n = 0; n < 5; n += 1) await store.put(entry(`a${n}`, 'alice', now - n * 1000));
    await store.put(entry('b0', 'bob', now));

    const page = await store.page('alice', { limit: 2, offset: 1 }, now);

    expect(page.entries.map((e) => e.id)).toEqual(['a1', 'a2']);
    expect(page.total).toBe(5);
    expect((await store.page('bob', {}, now)).entries.map((e) => e.id)).toEqual(['b0']);
    expect((await store.page('', {}, now)).entries).toEqual([]);
  });

  it('answers a default page of DLQ_PAGE_DEFAULT entries and never more than DLQ_PAGE_MAX', async () => {
    for (let n = 0; n < DLQ_PAGE_MAX + 20; n += 1) await store.put(entry(`a${n}`, 'alice', now - n));

    expect((await store.page('alice', {}, now)).entries).toHaveLength(DLQ_PAGE_DEFAULT);
    expect((await store.page('alice', { limit: 100_000 }, now)).entries).toHaveLength(DLQ_PAGE_MAX);
    expect((await store.page('alice', { limit: 0 }, now)).entries).toHaveLength(1);
    expect((await store.page('alice', {}, now)).total).toBe(DLQ_PAGE_MAX + 20);
  });

  it('leaves out the expired entries unless asked, and purges them with the count', async () => {
    await store.put(entry('old', 'alice', now - RETENTION_MS - 1));
    await store.put(entry('new', 'alice', now));

    expect((await store.page('alice', {}, now)).entries.map((e) => e.id)).toEqual(['new']);
    expect((await store.page('alice', { includeExpired: true }, now)).total).toBe(2);
    expect(await store.purgeExpired(now)).toBe(1);
    expect(memory.has('old')).toBe(false);
  });

  it('purges the entries without an owner when anyone lists, and clears one owner only', async () => {
    await store.put(entry('legacy', undefined, now));
    await store.put(entry('a0', 'alice', now));
    await store.put(entry('b0', 'bob', now));

    expect((await store.page('alice', {}, now)).entries.map((e) => e.id)).toEqual(['a0']);
    expect(memory.has('legacy')).toBe(false);
    await store.clear('alice');
    expect([...memory.keys()]).toEqual(['b0']);
  });

  it('removes entries and answers whether any was there', async () => {
    await store.put(entry('a0', 'alice', now));

    expect(await store.remove([entry('a0', 'alice', now)])).toBe(true);
    expect(await store.remove([entry('a0', 'alice', now)])).toBe(false);
  });
});
