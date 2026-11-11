import { afterAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import sharp from 'sharp';
import {
  applyOklabQuantizationAndDither,
  applyOklabQuantizationAndDitherAsync,
  QUANTIZER_POOL_MIN_PIXELS,
  quantizeImage,
  quantizeImageAsync,
  type DitherKind,
} from '../src/lib/conversions/color-quantizer';
import { CpuTaskAbortedError } from '../src/lib/types';
import { EVENT_LOOP_BLOCK_BUDGET_MS, shutdownCpuPool } from '../src/lib/workers/cpu-pool';

/**
 * The quantizers run on a pool thread from `QUANTIZER_POOL_MIN_PIXELS` pixels. The pool result must equal the in-thread
 * result byte for byte (same palette, same indices, same rebuilt raster), and the event loop must keep turning while a large
 * picture is quantized.
 */
const FIXTURES = ['sample.png', 'image-encoder-defaults/text-192x128.png', 'ocr/ko_a__skew3.png', 'ocr/en_b__clean300.png'];
const SIDE_PIXELS = 900;
const SAMPLE_INTERVAL_MS = 5;
const US_PER_MS = 1000;
const DITHERS: DitherKind[] = ['none', 'floyd-steinberg', 'riemersma', 'blue-noise'];

afterAll(async () => {
  await shutdownCpuPool();
});

/** A fixture scaled to 900 x 900 (0.81 MP, over the pool threshold) as RGBA bytes in an ArrayBuffer of their own. */
async function raster(fixture: string, width = SIDE_PIXELS, height = SIDE_PIXELS): Promise<Uint8Array> {
  const { data } = await sharp(path.join(__dirname, 'fixtures', fixture))
    .ensureAlpha()
    .resize(width, height, { fit: 'fill', kernel: 'cubic' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return new Uint8Array(data);
}

function threadCpuMs(): number {
  const { user, system } = (process as unknown as { threadCpuUsage: () => NodeJS.CpuUsage }).threadCpuUsage();
  return (user + system) / US_PER_MS;
}

/** The most CPU time the loop thread used between two ticks of a timer while `work` ran. */
async function longestHold(work: () => Promise<unknown>): Promise<number> {
  let previous = threadCpuMs();
  let held = 0;
  const timer = setInterval(() => {
    const now = threadCpuMs();
    held = Math.max(held, now - previous);
    previous = now;
  }, SAMPLE_INTERVAL_MS);
  try {
    await new Promise((resolve) => setTimeout(resolve, SAMPLE_INTERVAL_MS * 3));
    await work();
    await new Promise((resolve) => setTimeout(resolve, SAMPLE_INTERVAL_MS * 2));
  } finally {
    clearInterval(timer);
  }
  return held;
}

describe('quantizers on the CPU pool', () => {
  it('starts the pool from a raster the in-thread path would hold the loop for', () => {
    expect(QUANTIZER_POOL_MIN_PIXELS).toBeLessThanOrEqual(SIDE_PIXELS * SIDE_PIXELS);
  });

  for (const fixture of FIXTURES) {
    for (const dither of DITHERS) {
      it(`returns the in-thread palette and indices for ${fixture} with ${dither}`, async () => {
        const pixels = await raster(fixture);
        const expected = quantizeImage(pixels.slice(), SIDE_PIXELS, SIDE_PIXELS, 64, { dither, transparency: 'threshold' });
        const actual = await quantizeImageAsync(pixels, SIDE_PIXELS, SIDE_PIXELS, 64, { dither, transparency: 'threshold' });
        expect(actual.paletteSize).toBe(expected.paletteSize);
        expect(actual.transparentIndex).toBe(expected.transparentIndex);
        expect(Buffer.from(actual.palette).equals(Buffer.from(expected.palette))).toBe(true);
        expect(Buffer.from(actual.indices).equals(Buffer.from(expected.indices))).toBe(true);
      }, 120_000);
    }
  }

  it('returns the in-thread palette, indices and rebuilt raster of the Oklab dither entry', async () => {
    const pixels = await raster('ocr/en_b__clean300.png');
    const expected = applyOklabQuantizationAndDither({ data: pixels.slice(), width: SIDE_PIXELS, height: SIDE_PIXELS }, 32, true, 'riemersma');
    const actual = await applyOklabQuantizationAndDitherAsync({ data: pixels, width: SIDE_PIXELS, height: SIDE_PIXELS }, 32, true, 'riemersma');
    expect(actual.palette).toEqual(expected.palette);
    expect(Buffer.from(actual.indexed).equals(Buffer.from(expected.indexed))).toBe(true);
    expect(Buffer.from(actual.rgba).equals(Buffer.from(expected.rgba))).toBe(true);
  }, 120_000);

  it('hands the raster over: the caller gives up its ArrayBuffer, no copy is made', async () => {
    const pixels = await raster('sample.png');
    await quantizeImageAsync(pixels, SIDE_PIXELS, SIDE_PIXELS, 16, { dither: 'none' });
    expect(pixels.buffer.byteLength).toBe(0);
  });

  it('quantizes a buffer of the image library, which cannot be transferred, as the in-thread path does', async () => {
    const { data } = await sharp({ create: { width: SIDE_PIXELS, height: SIDE_PIXELS, channels: 4, background: { r: 200, g: 40, b: 90, alpha: 1 } } })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const expected = quantizeImage(new Uint8Array(data), SIDE_PIXELS, SIDE_PIXELS, 16, { dither: 'riemersma' });
    const actual = await quantizeImageAsync(data, SIDE_PIXELS, SIDE_PIXELS, 16, { dither: 'riemersma' });
    expect(actual.paletteSize).toBe(expected.paletteSize);
    expect(Buffer.from(actual.indices).equals(Buffer.from(expected.indices))).toBe(true);
  });

  it('copies a view that does not own its whole buffer, and leaves the caller its bytes', async () => {
    const whole = await raster('sample.png');
    const padded = new Uint8Array(whole.length + 16);
    padded.set(whole, 16);
    const view = padded.subarray(16);
    await quantizeImageAsync(view, SIDE_PIXELS, SIDE_PIXELS, 16, { dither: 'none' });
    expect(padded.buffer.byteLength).toBe(whole.length + 16);
  });

  it('keeps the event loop turning while a large picture is dithered', async () => {
    const side = 2000;
    const pixels = await raster('ocr/ko_a__skew3.png', side, side);
    const sync = pixels.slice();
    const controlHold = await longestHold(async () => {
      quantizeImage(sync, side, side, 64, { dither: 'riemersma' });
    });
    expect(controlHold).toBeGreaterThan(EVENT_LOOP_BLOCK_BUDGET_MS);
    const hold = await longestHold(() => quantizeImageAsync(pixels, side, side, 64, { dither: 'riemersma' }));
    expect(hold).toBeLessThan(EVENT_LOOP_BLOCK_BUDGET_MS);
  }, 300_000);

  it('stops at the job signal', async () => {
    const side = 2000;
    const pixels = await raster('ocr/ko_a__skew3.png', side, side);
    const controller = new AbortController();
    const run = quantizeImageAsync(pixels, side, side, 64, { dither: 'riemersma', signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(run).rejects.toBeInstanceOf(CpuTaskAbortedError);
    // The pool starts a fresh thread: the next picture is quantized as the in-thread path does.
    const next = await raster('sample.png');
    const expected = quantizeImage(next.slice(), SIDE_PIXELS, SIDE_PIXELS, 16, { dither: 'none' });
    const actual = await quantizeImageAsync(next, SIDE_PIXELS, SIDE_PIXELS, 16, { dither: 'none' });
    expect(actual.paletteSize).toBe(expected.paletteSize);
    expect(Buffer.from(actual.indices).equals(Buffer.from(expected.indices))).toBe(true);
  }, 120_000);

  it('refuses a raster over the quantizer budget before any hand-over', async () => {
    await expect(quantizeImageAsync(new Uint8Array(17_000 * 1_000 * 4), 17_000, 1_000, 16, { dither: 'riemersma' })).rejects.toThrow(/16000000|16,000,000|pixels/i);
  });
});
