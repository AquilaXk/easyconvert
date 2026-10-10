import os from 'node:os';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
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
    expect(await threadsAsked(await picture(false))).toEqual([imageThreadsFor(os.availableParallelism()), before]);
  });

  it('keeps a graphic on the single thread it had: the tiles that threads bring moved an interface from -14.4% to +1.6% BD-rate in PSNR', async () => {
    expect(await threadsAsked(await picture(true))).toEqual([]);
  });
});
