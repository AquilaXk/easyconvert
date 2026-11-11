import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Which GIF encoder a photograph reaches depends on its size: up to `GIF_PHOTO_PIXEL_BUDGET` the in-process palette
 * quantizer and LZW writer (`encodeGif`), over it the image library's own quantizer. The budget is lowered to one megapixel
 * here so that both sides of the boundary are tested on pictures a test can afford; the real value is checked in
 * image-pixel-budgets.test.ts and the route at that value in image-gif-photo-route.test.ts.
 */
const BUDGET_PIXELS = 1_000_000;
const encodeGifCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock('../src/lib/conversions/image-input-limits', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/conversions/image-input-limits')>();
  return { ...actual, GIF_PHOTO_PIXEL_BUDGET: { ...actual.GIF_PHOTO_PIXEL_BUDGET, maxPixels: 1_000_000 } };
});
vi.mock('../src/lib/conversions/gif-writer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/conversions/gif-writer')>();
  return {
    ...actual,
    encodeGif: (...args: Parameters<typeof actual.encodeGif>) => {
      encodeGifCalls.count += 1;
      return actual.encodeGif(...args);
    },
  };
});

const { convertFile } = await import('../src/lib/conversions');

const PHOTO = path.join(__dirname, '..', 'bench', 'corpus', 'photo-a.jpg');
const CONVERSION_TIMEOUT_MS = 60_000;

/** The corpus photograph stretched to a size, so that it stays a photograph to the classifier. */
function photoOf(width: number, height: number): Promise<Buffer> {
  return sharp(fs.readFileSync(PHOTO)).resize(width, height, { fit: 'fill' }).png().toBuffer();
}

describe('the GIF of a photograph at the in-process budget', () => {
  beforeEach(() => {
    encodeGifCalls.count = 0;
  });

  it('is written by the in-process quantizer at exactly the budget', async () => {
    const result = await convertFile(await photoOf(1000, 1000), 'png', 'gif', {}, 'photo.png');
    expect(1000 * 1000).toBe(BUDGET_PIXELS);
    expect(encodeGifCalls.count).toBe(1);
    expect(result.buffer.subarray(0, 3).toString('latin1')).toBe('GIF');
  }, CONVERSION_TIMEOUT_MS);

  it('is written by the image library one pixel row over the budget', async () => {
    const result = await convertFile(await photoOf(1000, 1001), 'png', 'gif', {}, 'photo.png');
    expect(encodeGifCalls.count).toBe(0);
    expect(result.buffer.subarray(0, 3).toString('latin1')).toBe('GIF');
  }, CONVERSION_TIMEOUT_MS);

  it('measures the size before a resize, which cannot make the picture larger for the quantizer', async () => {
    const result = await convertFile(await photoOf(1200, 1000), 'png', 'gif', { width: 600 }, 'photo.png');
    expect(encodeGifCalls.count).toBe(0);
    expect(result.buffer.subarray(0, 3).toString('latin1')).toBe('GIF');
  }, CONVERSION_TIMEOUT_MS);
});
