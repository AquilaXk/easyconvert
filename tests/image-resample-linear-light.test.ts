import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConversionOptionsSchema, validateOrProblem } from '../src/lib/api/contracts';
import { convertImage } from '../src/lib/conversions/image';
import { UnsupportedOptionError } from '../src/lib/types';
import { magickPsnr } from './helpers/magick-compare';
import { decodeRgba, runConvert, SKIP_WITHOUT_MAGICK } from './helpers/imagemagick';

/**
 * Downscales resample in linear light. Oracles: the sRGB transfer function (a 1-pixel black/white checkerboard
 * halves to the sRGB encoding of 0.5 linear, 188, not 128), an ImageMagick linear-light Lanczos resize compared
 * by PSNR, and CIE76 colour difference computed here from the sRGB definition. Pixels are decoded by ImageMagick.
 */

const BYTE_MAX = 255;
const SRGB_HALF_LINEAR = Math.round(BYTE_MAX * (1.055 * Math.pow(0.5, 1 / 2.4) - 0.055));
const MEAN_TOLERANCE = 2;
/** Lanczos rings at the Nyquist frequency, so single pixels of the flat result stray a few levels. */
const RINGING_TOLERANCE = 8;
const IM_PSNR_MIN_DB = 45;
const EDGE_DELTA_E_MAX = 2;
/**
 * Chirp length in sides: the corner of the plate then reaches 0.707 / 8 = 0.088 cycles per pixel. A plate that
 * reaches 0.2 cycles per pixel makes ImageMagick's 16-bit integer resize clamp the negative filter lobes between
 * its two passes (37 dB from an independent float32 linear-light Lanczos, where this implementation is at 50 dB), so
 * the comparison would measure that clamp, not the resample.
 */
const ZONE_CHIRP_LENGTH = 8;

function checkerboardPng(side: number, channels: 1 | 3 = 3): Promise<Buffer> {
  const raw = Buffer.alloc(side * side * channels);
  for (let y = 0; y < side; y += 1) for (let x = 0; x < side; x += 1) raw.fill(((x + y) & 1) * BYTE_MAX, (y * side + x) * channels, (y * side + x + 1) * channels);
  const base = sharp(raw, { raw: { width: side, height: side, channels } });
  return (channels === 1 ? base.toColourspace('b-w') : base).png().toBuffer();
}

/** Circular zone plate: the spatial frequency grows with the radius up to 0.09 cycles per pixel, well inside the Nyquist limit of the half-size result. */
function zonePlatePng(side: number): Promise<Buffer> {
  const raw = Buffer.alloc(side * side * 3);
  const centre = side / 2;
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const r2 = (x - centre) ** 2 + (y - centre) ** 2;
      const value = Math.round(BYTE_MAX * (0.5 + 0.5 * Math.cos((Math.PI * r2) / (side * ZONE_CHIRP_LENGTH))));
      raw.fill(value, (y * side + x) * 3, (y * side + x + 1) * 3);
    }
  }
  return sharp(raw, { raw: { width: side, height: side, channels: 3 } }).png().toBuffer();
}

function textPng(): Promise<Buffer> {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="160"><rect width="400" height="160" fill="#fff"/>' +
    '<text x="12" y="52" font-family="DejaVu Sans, sans-serif" font-size="30" fill="#000">Linear light 123</text>' +
    '<text x="12" y="104" font-family="DejaVu Sans, sans-serif" font-size="18" fill="#222">The quick brown fox jumps</text>' +
    '<rect x="12" y="124" width="376" height="1" fill="#000"/><rect x="12" y="130" width="376" height="2" fill="#444"/></svg>';
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function lab(r: number, g: number, b: number): [number, number, number] {
  const lin = (c: number): number => {
    const v = c / BYTE_MAX;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const [lr, lg, lb] = [lin(r), lin(g), lin(b)];
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047;
  const y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb;
  const z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883;
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

function deltaE76(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

describe.skipIf(SKIP_WITHOUT_MAGICK)('downscaling resamples in linear light', () => {
  it('halves a 1-pixel black/white checkerboard to the sRGB encoding of 0.5 linear (188), not 128', async () => {
    const converted = await convertImage(await checkerboardPng(64), 'png', { width: 32, height: 32 }, 'board.png', 'png');
    const decoded = decodeRgba(converted.buffer, 'png');
    expect({ width: decoded.width, height: decoded.height }).toEqual({ width: 32, height: 32 });
    let sum = 0;
    let worst = 0;
    for (let i = 0; i < decoded.data.length; i += 4) {
      sum += decoded.data[i];
      worst = Math.max(worst, Math.abs(decoded.data[i] - SRGB_HALF_LINEAR));
    }
    const mean = sum / (decoded.data.length / 4);
    expect(SRGB_HALF_LINEAR).toBe(188);
    expect(Math.abs(mean - SRGB_HALF_LINEAR)).toBeLessThanOrEqual(MEAN_TOLERANCE);
    expect(worst).toBeLessThanOrEqual(RINGING_TOLERANCE);
  });

  it('keeps a grey checkerboard grey (one channel) and a 16-bit one 16-bit', async () => {
    const grey = await convertImage(await checkerboardPng(64, 1), 'png', { width: 32, height: 32 }, 'grey.png', 'png');
    expect((await sharp(grey.buffer).metadata()).channels).toBe(1);
    const sixteen = await sharp(await checkerboardPng(64), {}).toColourspace('rgb16').png({ compressionLevel: 1 }).toBuffer();
    const deep = await convertImage(sixteen, 'png', { width: 32, height: 32 }, 'deep.png', 'png');
    const meta = await sharp(deep.buffer).metadata();
    expect(meta.depth).toBe('ushort');
  });

  it('matches an ImageMagick linear-light Lanczos halving to 45 dB on a zone plate and on text', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'linear-light-'));
    try {
      for (const [name, source] of [['zone', await zonePlatePng(256)], ['text', await textPng()]] as const) {
        const input = path.join(dir, `${name}.png`);
        const expected = path.join(dir, `${name}-im.png`);
        const actual = path.join(dir, `${name}-ours.png`);
        writeFileSync(input, source);
        runConvert([input, '-colorspace', 'RGB', '-filter', 'Lanczos', '-resize', '50%', '-colorspace', 'sRGB', expected]);
        const meta = await sharp(source).metadata();
        const result = await convertImage(source, 'png', { width: (meta.width as number) / 2, height: (meta.height as number) / 2, fit: 'fill' }, `${name}.png`, 'png');
        writeFileSync(actual, result.buffer);
        expect(magickPsnr(expected, actual), name).toBeGreaterThanOrEqual(IM_PSNR_MIN_DB);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves no dark fringe on the edge of opaque red on a transparent background', async () => {
    const side = 64;
    const raw = Buffer.alloc(side * side * 4);
    for (let y = 0; y < side; y += 1) {
      for (let x = 0; x < side; x += 1) if (x < side / 2 + 1) raw.set([BYTE_MAX, 0, 0, BYTE_MAX], (y * side + x) * 4);
    }
    const source = await sharp(raw, { raw: { width: side, height: side, channels: 4 } }).png().toBuffer();
    const converted = await convertImage(source, 'png', { width: 16, height: 16 }, 'edge.png', 'png');
    const decoded = decodeRgba(converted.buffer, 'png');
    const red = lab(BYTE_MAX, 0, 0);
    let checked = 0;
    for (let i = 0; i < decoded.data.length; i += 4) {
      const alpha = decoded.data[i + 3];
      if (alpha === 0) continue;
      checked += 1;
      const delta = deltaE76(lab(decoded.data[i], decoded.data[i + 1], decoded.data[i + 2]), red);
      expect(delta, `pixel ${i / 4} alpha ${alpha}`).toBeLessThanOrEqual(EDGE_DELTA_E_MAX);
    }
    expect(checked).toBeGreaterThan(16);
  });
});

describe('the kernel option', () => {
  let gradient: Buffer;
  beforeAll(async () => {
    const raw = Buffer.alloc(48 * 48 * 3);
    for (let i = 0; i < 48 * 48; i += 1) raw.fill((i * 37) & BYTE_MAX, i * 3, i * 3 + 3);
    gradient = await sharp(raw, { raw: { width: 48, height: 48, channels: 3 } }).png().toBuffer();
  });
  afterAll(() => undefined);

  it.each(['lanczos3', 'lanczos2', 'mitchell', 'cubic', 'nearest', 'mks2021'] as const)('accepts %s', async (kernel) => {
    const out = await convertImage(gradient, 'png', { width: 24, height: 24, kernel }, 'g.png', 'png');
    expect((await sharp(out.buffer).metadata()).width).toBe(24);
  });

  it('changes the result: nearest differs from the default lanczos3', async () => {
    const lanczos = await convertImage(gradient, 'png', { width: 24, height: 24 }, 'g.png', 'png');
    const nearest = await convertImage(gradient, 'png', { width: 24, height: 24, kernel: 'nearest' }, 'g.png', 'png');
    expect(Buffer.compare(lanczos.buffer, nearest.buffer)).not.toBe(0);
    const explicit = await convertImage(gradient, 'png', { width: 24, height: 24, kernel: 'lanczos3' }, 'g.png', 'png');
    expect(Buffer.compare(lanczos.buffer, explicit.buffer)).toBe(0);
  });

  it('rejects an unknown kernel with UnsupportedOptionError, resize or not', async () => {
    const bogus = 'bicubic-sharper' as never;
    await expect(convertImage(gradient, 'png', { width: 24, kernel: bogus }, 'g.png', 'png')).rejects.toBeInstanceOf(UnsupportedOptionError);
    await expect(convertImage(gradient, 'png', { kernel: bogus }, 'g.png', 'png')).rejects.toThrow(/kernel "bicubic-sharper"/);
  });

  it('is in the request schema as an enum, so the API answers 400 for an unknown value', () => {
    expect(validateOrProblem(ConversionOptionsSchema, { kernel: 'mitchell' }).ok).toBe(true);
    const rejected = validateOrProblem(ConversionOptionsSchema, { kernel: 'bogus' });
    expect(rejected.ok).toBe(false);
  });
});
