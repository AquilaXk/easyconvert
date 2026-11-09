import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareAndSetWithRetry, type CompareAndSetAttempt } from '../src/lib/redis/compare-and-set';
import { RedisBudgetStore } from '../src/lib/api-keys/upload-budget-store';
import type { UploadBudgetRecord } from '../src/lib/api-keys/anonymous-upload-budget';

afterEach(() => vi.restoreAllMocks());

/** An attempt that meets `conflicts` writers before it writes `value`. */
function attemptsWith<T>(conflicts: number, value: T): () => Promise<CompareAndSetAttempt<T>> {
  let calls = 0;
  return async () => (calls++ < conflicts ? 'conflict' : { written: value });
}

describe('the compare-and-set loop', () => {
  it('writes on the first attempt that meets no other writer, and answers what it wrote', async () => {
    const attempt = vi.fn(attemptsWith(2, 'third'));
    vi.spyOn(crypto, 'randomInt').mockReturnValue(0 as never);

    await expect(compareAndSetWithRetry(attempt, { maxAttempts: 4, subject: 'The record' })).resolves.toBe('third');
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('waits a random time after each conflict, up to a bound that doubles from 2 ms and stops at 100 ms', async () => {
    const bounds: number[] = [];
    vi.spyOn(crypto, 'randomInt').mockImplementation(((max: number) => {
      bounds.push(max);
      return 0;
    }) as never);

    await compareAndSetWithRetry(attemptsWith(8, 'done'), { maxAttempts: 9, subject: 'The record' });

    expect(bounds).toEqual([3, 5, 9, 17, 33, 65, 101, 101]);
  });

  it('gives up after the most attempts and names what kept changing', async () => {
    const attempt = vi.fn(attemptsWith(Number.POSITIVE_INFINITY, 'never'));
    vi.spyOn(crypto, 'randomInt').mockReturnValue(0 as never);

    await expect(compareAndSetWithRetry(attempt, { maxAttempts: 3, subject: 'The record' })).rejects.toThrow(
      'The record changed 3 times while it was being updated'
    );
    expect(attempt).toHaveBeenCalledTimes(3);
  });
});

/** The Redis commands the budget store sends, with the compare-and-set script run as Redis runs it. */
function fakeRedis(beforeWrite: (values: Map<string, string>) => void = () => undefined) {
  const values = new Map<string, string>();
  const ttls = new Map<string, number>();
  return {
    values,
    ttls,
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string, _px: 'PX', ttl: number) => {
      values.set(key, value);
      ttls.set(key, ttl);
      return 'OK';
    },
    eval: async (_script: string, _keys: number, key: string, expected: string, next: string, ttl: string) => {
      beforeWrite(values);
      if ((values.get(key) ?? '') !== expected) return 0;
      values.set(key, next);
      ttls.set(key, Number(ttl));
      return 1;
    },
  };
}

const record = (bytes: number, open: UploadBudgetRecord['open'] = {}): UploadBudgetRecord => ({ day: '2026-11-01', bytes, open });

describe('the budget store in Redis', () => {
  const KEY = 'ec:upload-budget:{anon:203.0.113.0}';

  it('writes a change on top of one another instance wrote between the read and the write', async () => {
    let raced = false;
    const redis = fakeRedis((values) => {
      if (raced) return;
      raced = true;
      values.set(KEY, JSON.stringify(record(100)));
    });
    vi.spyOn(crypto, 'randomInt').mockReturnValue(0 as never);
    const store = new RedisBudgetStore(redis as never, 'ec:');

    await store.update('anon:203.0.113.0', (current) => record((current?.bytes ?? 0) + 5));

    expect(JSON.parse(redis.values.get(KEY)!)).toEqual(record(105));
    expect(redis.ttls.get(KEY)).toBe(2 * 24 * 60 * 60 * 1000);
  });

  it('writes nothing when the change says so, and reads a damaged record as none', async () => {
    const redis = fakeRedis();
    redis.values.set(KEY, '{not json');
    const store = new RedisBudgetStore(redis as never, 'ec:');
    const seen: Array<UploadBudgetRecord | undefined> = [];

    await store.update('anon:203.0.113.0', (current) => {
      seen.push(current);
      return undefined;
    });

    expect(seen).toEqual([undefined]);
    expect(redis.values.get(KEY)).toBe('{not json');
  });

  it('gives up after eight writers in a row, so a request does not wait forever', async () => {
    const redis = fakeRedis((values) => values.set(KEY, String(Math.random())));
    vi.spyOn(crypto, 'randomInt').mockReturnValue(0 as never);
    const store = new RedisBudgetStore(redis as never, 'ec:');

    await expect(store.update('anon:203.0.113.0', () => record(1))).rejects.toThrow('The upload budget of a bucket changed 8 times');
  });

  it('finds the reservation of a session by its id until the session expires', async () => {
    const redis = fakeRedis();
    const store = new RedisBudgetStore(redis as never, 'ec:');
    vi.spyOn(Date, 'now').mockReturnValue(1_000);

    await store.link('up_1', { bucket: 'anon:203.0.113.0', reservation: 'r1' }, 61_000);

    await expect(store.lookup('up_1')).resolves.toEqual({ bucket: 'anon:203.0.113.0', reservation: 'r1' });
    expect(redis.ttls.get('ec:upload-budget-link:up_1')).toBe(60_000);
    await expect(store.lookup('up_2')).resolves.toBeUndefined();
  });
});
