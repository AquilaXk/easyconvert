import os from 'node:os';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { IMAGE_MAX_THREADS, IMAGE_THREADS_ENV, imageThreadsFor, withImageThreads } from '../src/lib/conversions/image-threads';

describe('imageThreadsFor', () => {
  it('uses the available cores up to the bound, and at least one', () => {
    expect([imageThreadsFor(1, {}), imageThreadsFor(4, {}), imageThreadsFor(IMAGE_MAX_THREADS, {}), imageThreadsFor(64, {}), imageThreadsFor(0, {})]).toEqual([1, 4, IMAGE_MAX_THREADS, IMAGE_MAX_THREADS, 1]);
  });

  it('takes a positive whole number from the environment over the cores, above the bound too', () => {
    expect([imageThreadsFor(4, { [IMAGE_THREADS_ENV]: '1' }), imageThreadsFor(4, { [IMAGE_THREADS_ENV]: '16' })]).toEqual([1, 16]);
  });

  it.each(['0', '-2', '1.5', 'many', ''])('ignores the environment value %j', (value) => {
    expect(imageThreadsFor(4, { [IMAGE_THREADS_ENV]: value })).toBe(4);
  });
});

describe('withImageThreads', () => {
  const before = sharp.concurrency();
  const leased = imageThreadsFor(os.availableParallelism());
  afterEach(() => {
    sharp.concurrency(before);
  });

  it('runs the encode on the leased thread count and puts the previous count back afterwards', async () => {
    sharp.concurrency(1);
    const during = await withImageThreads(async () => sharp.concurrency());
    expect(during).toBe(leased);
    expect(sharp.concurrency()).toBe(1);
  });

  it('puts the previous count back when the encode fails, and returns what it returns', async () => {
    sharp.concurrency(1);
    await expect(withImageThreads(async () => Promise.reject(new Error('encode failed')))).rejects.toThrow('encode failed');
    expect(sharp.concurrency()).toBe(1);
    expect(await withImageThreads(async () => 'done')).toBe('done');
  });

  it('keeps the lease until the last of several concurrent encodes ends', async () => {
    sharp.concurrency(1);
    let releaseFirst = (): void => undefined;
    const first = withImageThreads(() => new Promise<void>((resolve) => { releaseFirst = resolve; }));
    await withImageThreads(async () => undefined);
    expect(sharp.concurrency()).toBe(leased);
    releaseFirst();
    await first;
    expect(sharp.concurrency()).toBe(1);
  });
});
