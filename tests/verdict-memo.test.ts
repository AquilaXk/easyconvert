import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoizeVerdict } from '../src/lib/health/verdict-memo';

const TTL_MS = 5_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('memoizeVerdict', () => {
  it('shares one run between callers that come while it goes, and reuses its outcome until the ttl ends', async () => {
    const run = vi.fn(() => ({ verdict: Promise.resolve('ok') }));
    const memo = memoizeVerdict(TTL_MS, run);
    expect(await Promise.all([memo.get(), memo.get()])).toEqual(['ok', 'ok']);
    vi.setSystemTime(Date.now() + TTL_MS - 1);
    await memo.get();
    expect(run).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 1);
    await memo.get();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('reuses a failure too, and runs again once it has expired', async () => {
    const run = vi.fn(() => ({ verdict: Promise.reject(new Error('down')) }));
    const memo = memoizeVerdict(TTL_MS, run);
    await expect(memo.get()).rejects.toThrow('down');
    await expect(memo.get()).rejects.toThrow('down');
    expect(run).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + TTL_MS);
    await expect(memo.get()).rejects.toThrow('down');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not start a run on top of work that outlives its verdict, and gives the verdict it has meanwhile', async () => {
    let end!: () => void;
    const work = new Promise<void>((resolve) => (end = resolve));
    const run = vi.fn(() => ({ verdict: Promise.reject(new Error('timed out')), settled: work }));
    const memo = memoizeVerdict(TTL_MS, run);
    await expect(memo.get()).rejects.toThrow('timed out');
    vi.setSystemTime(Date.now() + 10 * TTL_MS);
    await expect(memo.get()).rejects.toThrow('timed out');
    expect(run).toHaveBeenCalledTimes(1);
    end();
    await work;
    await memo.get().catch(() => undefined);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('forgets the verdict on reset', async () => {
    const run = vi.fn(() => ({ verdict: Promise.resolve(1) }));
    const memo = memoizeVerdict(TTL_MS, run);
    await memo.get();
    memo.reset();
    await memo.get();
    expect(run).toHaveBeenCalledTimes(2);
  });
});
