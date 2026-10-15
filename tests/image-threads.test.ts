import os from 'node:os';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import '../src/lib/conversions/image';
import { baseImageThreads, IMAGE_BASE_THREADS, IMAGE_MAX_THREADS, IMAGE_THREADS_ENV, IMAGE_UNBOUNDED_HEAP_THREADS, MALLOC_ARENA_ENV, imageThreadsFor, memoryLimitBytes, withImageThreads } from '../src/lib/conversions/image-threads';

const GIB = 1024 * 1024 * 1024;

describe('imageThreadsFor', () => {
  const bounded = { [MALLOC_ARENA_ENV]: '2' };

  it('with the heap bounded uses the available cores up to the bound, and at least one', () => {
    expect([1, 4, IMAGE_MAX_THREADS, 64, 0].map((cores) => imageThreadsFor(cores, GIB * 64, bounded))).toEqual([1, 4, IMAGE_MAX_THREADS, IMAGE_MAX_THREADS, 1]);
  });

  it('with the heap not bounded leases two threads, which is most of the speed at the memory of the single thread plus a tenth', () => {
    expect([1, 2, 4, 64].map((cores) => imageThreadsFor(cores, GIB * 64, {}))).toEqual([1, IMAGE_UNBOUNDED_HEAP_THREADS, IMAGE_UNBOUNDED_HEAP_THREADS, IMAGE_UNBOUNDED_HEAP_THREADS]);
    expect(imageThreadsFor(4, GIB * 64, { [MALLOC_ARENA_ENV]: '' })).toBe(IMAGE_UNBOUNDED_HEAP_THREADS);
  });

  it('leases only the threads the memory limit pays for: 256 MB each, at least one', () => {
    expect([4 * GIB, GIB, GIB / 2, GIB / 8].map((memory) => imageThreadsFor(8, memory, bounded))).toEqual([8, 4, 2, 1]);
  });

  it('takes a positive whole number from the environment over the cores, the heap and the memory, above the bound too', () => {
    expect([imageThreadsFor(4, GIB, { [IMAGE_THREADS_ENV]: '1' }), imageThreadsFor(4, GIB / 8, { [IMAGE_THREADS_ENV]: '16' })]).toEqual([1, 16]);
  });

  it.each(['0', '-2', '1.5', 'many', ''])('ignores the environment value %j', (value) => {
    expect(imageThreadsFor(4, GIB * 64, { ...bounded, [IMAGE_THREADS_ENV]: value })).toBe(4);
  });
});

describe('baseImageThreads', () => {
  it('is one thread unless the operator names a count', () => {
    expect([baseImageThreads({}), baseImageThreads({ [IMAGE_THREADS_ENV]: '3' }), baseImageThreads({ [IMAGE_THREADS_ENV]: 'x' })]).toEqual([IMAGE_BASE_THREADS, 3, IMAGE_BASE_THREADS]);
  });

  it('is what the image library runs on once the conversion module is loaded, whatever its own default is', () => {
    expect(sharp.concurrency()).toBe(baseImageThreads());
  });

  it('reads a memory limit that is a positive number of bytes no larger than the machine', () => {
    expect(memoryLimitBytes()).toBeGreaterThan(0);
    expect(memoryLimitBytes()).toBeLessThanOrEqual(os.totalmem());
  });
});

describe('withImageThreads', () => {
  const before = sharp.concurrency();
  const leased = imageThreadsFor(os.availableParallelism(), memoryLimitBytes());
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

describe('the AVIF encode of the image library', () => {
  const SIDE = 64;
  const MULTIPLIER = 2654435761;
  const picture = (flat: boolean): Promise<Buffer> => {
    const raw = Buffer.alloc(SIDE * SIDE * 3);
    for (let i = 0; i < raw.length; i += 1) raw[i] = flat ? (Math.floor(i / 3 / 8) % 2) * 200 : (Math.imul(i + 1, MULTIPLIER) >>> 24) & 0xff;
    return sharp(raw, { raw: { width: SIDE, height: SIDE, channels: 3 } }).png().toBuffer();
  };
  const savedPath = process.env.AVIFENC_PATH;
  afterEach(() => {
    vi.restoreAllMocks();
    if (savedPath === undefined) delete process.env.AVIFENC_PATH;
    else process.env.AVIFENC_PATH = savedPath;
  });

  /** Thread counts the image library was asked for during a conversion that the image library itself encodes. */
  async function threadsAsked(source: Buffer): Promise<unknown[]> {
    process.env.AVIFENC_PATH = '/nonexistent/avifenc';
    const asked: unknown[] = [];
    const concurrency = sharp.concurrency;
    vi.spyOn(sharp, 'concurrency').mockImplementation(((count?: number) => {
      if (count !== undefined) asked.push(count);
      return concurrency(count as number);
    }) as typeof sharp.concurrency);
    const result = await convertImage(source, 'avif', { quality: 60 }, 'p.png', 'png');
    expect(result.metadata).toMatchObject({ avifEncoder: 'image-library' });
    return asked;
  }

  it('runs a photograph on the leased threads and puts the previous count back', async () => {
    const before = sharp.concurrency();
    expect(await threadsAsked(await picture(false))).toEqual([imageThreadsFor(os.availableParallelism(), memoryLimitBytes()), before]);
  });

  it('keeps a graphic on the single thread it had: the tiles that threads bring moved an interface from -14.4% to +1.6% BD-rate in PSNR', async () => {
    expect(await threadsAsked(await picture(true))).toEqual([]);
  });
});
