import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisKeyStore, redisKeyStore } from '../src/lib/api-keys/redis-key-store';

const BURST = { capacity: 3, refillRate: 1 };

async function drain(store: RedisKeyStore, bucketId: string): Promise<void> {
  for (let i = 0; i < BURST.capacity; i++) {
    expect((await store.checkTokenBucketRateLimit(bucketId, BURST)).allowed).toBe(true);
  }
  expect((await store.checkTokenBucketRateLimit(bucketId, BURST)).allowed).toBe(false);
}

describe('RedisKeyStore.resetStore clears the in-memory token buckets', () => {
  beforeEach(() => {
    // A frozen clock removes the refill that a later millisecond would add, so a leaked bucket stays empty.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-18T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives a drained shared-store bucket a full burst again after a reset at the same instant', async () => {
    const bucketId = 'rate:anon:198.51.100.7';
    await drain(redisKeyStore, bucketId);

    redisKeyStore.resetStore();

    const afterReset = await redisKeyStore.checkTokenBucketRateLimit(bucketId, BURST);
    expect(afterReset.allowed).toBe(true);
    expect(afterReset.remainingTokens).toBe(BURST.capacity - 1);
  });

  it('clears buckets that another shared-store instance drained', async () => {
    const bucketId = 'rate:anon:198.51.100.8';
    const sibling = new RedisKeyStore();
    await drain(sibling, bucketId);

    redisKeyStore.resetStore();

    const afterReset = await sibling.checkTokenBucketRateLimit(bucketId, BURST);
    expect(afterReset.allowed).toBe(true);
    expect(afterReset.remainingTokens).toBe(BURST.capacity - 1);
  });

  it('resets an isolated store without touching the shared buckets', async () => {
    const bucketId = 'rate:anon:198.51.100.9';
    const isolated = new RedisKeyStore('easyconvert:', true);
    await drain(isolated, bucketId);
    await drain(redisKeyStore, bucketId);

    isolated.resetStore();

    expect((await isolated.checkTokenBucketRateLimit(bucketId, BURST)).allowed).toBe(true);
    expect((await redisKeyStore.checkTokenBucketRateLimit(bucketId, BURST)).allowed).toBe(false);
  });
});
