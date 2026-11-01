import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { InMemoryIdempotencyStore, RedisIdempotencyStore, type IdempotencyStore } from '../src/lib/api/idempotency';

const DEFAULT_REDIS_URL = 'redis://127.0.0.1:6379';
const FINGERPRINT = 'fp-1';
const RESPONSE = { status: 200, headers: {}, body: '{}' };
const LOCK_MS = 30_000;
const MINUTE_MS = 60_000;

describe.each([
  { name: 'InMemoryIdempotencyStore', isRedis: false },
  { name: 'RedisIdempotencyStore', isRedis: true },
])('the release of an idempotency lock by the token of the run that took it: $name', ({ isRedis }) => {
  let store: IdempotencyStore;
  let redis: Redis | undefined;
  let now: number;
  let scopedKey: string;
  let counter = 0;

  beforeEach(async (ctx) => {
    now = Date.now();
    scopedKey = `idem:{lock-token}:/test:${process.pid}-${Date.now()}-${counter++}`;
    if (!isRedis) {
      store = new InMemoryIdempotencyStore({ clock: () => now });
      return;
    }
    const url = process.env.REDIS_URL || DEFAULT_REDIS_URL;
    redis = new Redis(url, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1 });
    redis.on('error', () => undefined);
    try {
      await redis.connect();
      await redis.ping();
    } catch (error) {
      redis.disconnect();
      redis = undefined;
      if (process.env.ORACLE_STRICT_MODE === '1' || process.env.REDIS_URL) throw new Error(`Redis is unreachable at ${url}: ${String(error)}`);
      ctx.skip();
      return;
    }
    store = new RedisIdempotencyStore({ redisClient: redis, clock: () => now });
  });

  afterEach(async () => {
    if (redis) {
      await redis.del(scopedKey).catch(() => undefined);
      await redis.quit().catch(() => undefined);
    }
  });

  it('removes the lock when the token is the one the lock was taken with', async () => {
    await store.acquire(scopedKey, FINGERPRINT, LOCK_MS, 'run-a');

    expect(await store.releaseLock(scopedKey, 'run-a')).toBe(true);
    expect((await store.acquire(scopedKey, FINGERPRINT, LOCK_MS, 'run-b')).status).toBe('acquired');
  });

  it('leaves the lock of another run, so a run that outlived its lock cannot release the lock of the run that took the key after it', async () => {
    await store.acquire(scopedKey, FINGERPRINT, LOCK_MS, 'run-a');

    expect(await store.releaseLock(scopedKey, 'run-b')).toBe(false);
    expect((await store.acquire(scopedKey, FINGERPRINT, LOCK_MS, 'run-c')).status).toBe('in_flight');
  });

  it('leaves a recorded answer in place, whatever the token', async () => {
    await store.acquire(scopedKey, FINGERPRINT, LOCK_MS, 'run-a');
    await store.complete(scopedKey, FINGERPRINT, RESPONSE);

    expect(await store.releaseLock(scopedKey, 'run-a')).toBe(false);
    expect((await store.acquire(scopedKey, FINGERPRINT, LOCK_MS, 'run-b')).status).toBe('completed');
  });

  it('releases nothing for a key that holds no lock', async () => {
    expect(await store.releaseLock(scopedKey, 'run-a')).toBe(false);
  });

  it('tells a repeat that meets a running request to try again in a second', async () => {
    await store.acquire(scopedKey, FINGERPRINT, LOCK_MS, 'run-a');

    expect(await store.acquire(scopedKey, FINGERPRINT, LOCK_MS, 'run-b')).toEqual({ status: 'in_flight', retryAfterSeconds: 1 });
  });

  it('tells a repeat that meets a kept lock to try again when the lock ends', async () => {
    await store.acquire(scopedKey, FINGERPRINT, MINUTE_MS, 'run-a');

    expect(await store.keepLock(scopedKey, 'run-a')).toBe(true);
    const repeat = await store.acquire(scopedKey, FINGERPRINT, MINUTE_MS, 'run-b');

    expect(repeat.status).toBe('in_flight');
    const retryAfter = repeat.status === 'in_flight' ? repeat.retryAfterSeconds : 0;
    expect(retryAfter).toBeGreaterThanOrEqual(58);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it('keeps the lock only for the run that took it', async () => {
    await store.acquire(scopedKey, FINGERPRINT, LOCK_MS, 'run-a');

    expect(await store.keepLock(scopedKey, 'run-b')).toBe(false);
    expect(await store.acquire(scopedKey, FINGERPRINT, LOCK_MS, 'run-c')).toEqual({ status: 'in_flight', retryAfterSeconds: 1 });
  });
});
