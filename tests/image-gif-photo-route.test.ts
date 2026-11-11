import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A photograph over the 16 megapixels of the Oklab and Riemersma quantizers, and under `GIF_PHOTO_PIXEL_BUDGET`, is written
 * by the in-process palette quantizer (policy entry 230), not by the image library: the 39 megapixel and 21 megapixel camera
 * pictures of the benchmark took 8 s and 10 s that way.
 */
const encodeGifCalls = vi.hoisted(() => ({ count: 0 }));

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
const CONVERSION_TIMEOUT_MS = 120_000;
/** 4200 x 4000 = 16.8 megapixels: over the 16 megapixels of the other quantizers. */
const OVER_QUANTIZER_BUDGET = { width: 4200, height: 4000 };

describe('a photograph over the Oklab quantizer budget', () => {
  beforeEach(() => {
    encodeGifCalls.count = 0;
  });

  it('is written to GIF by the in-process quantizer', async () => {
    const { width, height } = OVER_QUANTIZER_BUDGET;
    const source = await sharp(fs.readFileSync(PHOTO)).resize(width, height, { fit: 'fill' }).png({ compressionLevel: 1 }).toBuffer();
    const result = await convertFile(source, 'png', 'gif', {}, 'photo.png');
    expect(encodeGifCalls.count).toBe(1);
    const meta = await sharp(result.buffer).metadata();
    expect([meta.width, meta.height]).toEqual([width, height]);
  }, CONVERSION_TIMEOUT_MS);

  it('still refuses an explicit Oklab request over that budget', async () => {
    const { width, height } = OVER_QUANTIZER_BUDGET;
    const source = await sharp(fs.readFileSync(PHOTO)).resize(width, height, { fit: 'fill' }).png({ compressionLevel: 1 }).toBuffer();
    await expect(convertFile(source, 'png', 'gif', { quantizer: 'oklab' }, 'photo.png')).rejects.toThrow(/limit of 16000000 pixels/);
    expect(encodeGifCalls.count).toBe(0);
  }, CONVERSION_TIMEOUT_MS);
});
