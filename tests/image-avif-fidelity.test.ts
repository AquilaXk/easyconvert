import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { convertFile } from '../src/lib/conversions';

/**
 * AVIF output fidelity. sharp 0.35 tunes lossy AVIF with perceptual (SSIMULACRA2-based) metrics by
 * default, which trades roughly 5 dB of PSNR for smaller files at the same `quality` value. The engine
 * pins the PSNR tuning that earlier releases used, so a given `quality` keeps producing the same
 * pixel fidelity. The oracle is the source raster itself: the AVIF is decoded and compared with the
 * pixels that went in, so no value comes from the engine under test.
 */

const WIDTH = 64;
const HEIGHT = 48;
const RGB_CHANNELS = 3;
const BYTE_MAX = 255;
const TEXTURE_STRIDE = 7;
const DEFAULT_QUALITY_MIN_PSNR_DB = 42;
const HIGH_QUALITY = 95;
const HIGH_QUALITY_MIN_PSNR_DB = 47;
const FTYP_BRAND_OFFSET = 4;
const FTYP_BRAND = 'ftypavif';

/** Deterministic gradient with a hash-like texture, so the image has detail an encoder can lose. */
function textureRgb(): Buffer {
  const rgb = Buffer.alloc(WIDTH * HEIGHT * RGB_CHANNELS);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const at = (y * WIDTH + x) * RGB_CHANNELS;
      rgb[at] = Math.round((x * BYTE_MAX) / (WIDTH - 1));
      rgb[at + 1] = Math.round((y * BYTE_MAX) / (HEIGHT - 1));
      rgb[at + 2] = ((x ^ y) * TEXTURE_STRIDE) & BYTE_MAX;
    }
  }
  return rgb;
}

function psnrDb(reference: Buffer, decoded: Buffer): number {
  expect(decoded.length).toBe(reference.length);
  let squared = 0;
  for (let i = 0; i < reference.length; i++) {
    const delta = reference[i] - decoded[i];
    squared += delta * delta;
  }
  if (squared === 0) return Number.POSITIVE_INFINITY;
  return 10 * Math.log10((BYTE_MAX * BYTE_MAX) / (squared / reference.length));
}

async function decodeRgb(avif: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(avif).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  expect({ width: info.width, height: info.height, channels: info.channels }).toEqual({
    width: WIDTH,
    height: HEIGHT,
    channels: RGB_CHANNELS,
  });
  return data;
}

describe('AVIF encoder fidelity', () => {
  const rgb = textureRgb();
  const raw = { raw: { width: WIDTH, height: HEIGHT, channels: RGB_CHANNELS } } as const;

  it('keeps PSNR at the default quality when converting PNG to AVIF', async () => {
    const png = await sharp(rgb, raw).png().toBuffer();
    const result = await convertFile(png, 'png', 'avif', {}, 'texture.png');
    expect(result.mimeType).toBe('image/avif');
    expect(result.buffer.toString('latin1', FTYP_BRAND_OFFSET, FTYP_BRAND_OFFSET + FTYP_BRAND.length)).toBe(FTYP_BRAND);
    expect(psnrDb(rgb, await decodeRgb(result.buffer))).toBeGreaterThan(DEFAULT_QUALITY_MIN_PSNR_DB);
  });

  it('keeps PSNR at a high quality setting when converting PNG to AVIF', async () => {
    const png = await sharp(rgb, raw).png().toBuffer();
    const result = await convertFile(png, 'png', 'avif', { quality: HIGH_QUALITY }, 'texture.png');
    expect(psnrDb(rgb, await decodeRgb(result.buffer))).toBeGreaterThan(HIGH_QUALITY_MIN_PSNR_DB);
  });
});
