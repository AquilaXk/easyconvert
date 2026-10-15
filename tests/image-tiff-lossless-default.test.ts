import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { convertVectorCad } from '../src/lib/conversions/vector-cad';
import { UnsupportedOptionError } from '../src/lib/types';
import { getOracleToolPath } from './helpers/differential-oracle';
import { magickDifferingPixels } from './helpers/magick-compare';
import { runIdentify, SKIP_WITHOUT_MAGICK } from './helpers/imagemagick';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * Image to TIFF writes lossless pixels unless the request asks for JPEG. The oracles are ImageMagick
 * (`compare -metric AE` counts differing pixels, `identify` reads the alpha flag) and `tiffinfo` (the
 * compression scheme and predictor tags); nothing is read back through the converter.
 */

const WIDTH = 96;
const HEIGHT = 64;
const RGBA_CHANNELS = 4;
const BYTE_MAX = 255;
const NOISE_MULTIPLIER = 2654435761;
const NOISE_SHIFT = 13;
const HALF_ALPHA = 128;

/** A smooth gradient with a deterministic per-pixel texture, so lossy coding cannot reproduce it exactly. */
function texturedRgba(): Buffer {
  const rgba = Buffer.alloc(WIDTH * HEIGHT * RGBA_CHANNELS);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const at = (y * WIDTH + x) * RGBA_CHANNELS;
      const noise = (Math.imul(y * WIDTH + x, NOISE_MULTIPLIER) >>> NOISE_SHIFT) & 0x3f;
      rgba[at] = Math.min(BYTE_MAX, Math.round((x * BYTE_MAX) / (WIDTH - 1)) + noise);
      rgba[at + 1] = Math.min(BYTE_MAX, Math.round((y * BYTE_MAX) / (HEIGHT - 1)) + (noise >> 1));
      rgba[at + 2] = (x * 7 + y * 13 + noise) & BYTE_MAX;
      rgba[at + 3] = x < WIDTH / 2 ? BYTE_MAX : HALF_ALPHA;
    }
  }
  return rgba;
}

function tiffinfo(file: string): string {
  const binary = getOracleToolPath('tiffinfo');
  if (!binary) throw new Error('tiffinfo is required by this test');
  return execFileSync(binary, [file], { encoding: 'utf-8' });
}

let workDir: string;
let rgbPng: Buffer;
let rgbaPng: Buffer;

beforeAll(async () => {
  workDir = mkdtempSync(path.join(os.tmpdir(), 'tiff-lossless-'));
  const rgba = texturedRgba();
  rgbaPng = await sharp(rgba, { raw: { width: WIDTH, height: HEIGHT, channels: RGBA_CHANNELS } }).png().toBuffer();
  rgbPng = await sharp(rgba, { raw: { width: WIDTH, height: HEIGHT, channels: RGBA_CHANNELS } })
    .removeAlpha()
    .png()
    .toBuffer();
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function writeIn(name: string, bytes: Buffer): string {
  const file = path.join(workDir, name);
  writeFileSync(file, bytes);
  return file;
}

const skipOracles = SKIP_WITHOUT_MAGICK || skipWithoutTools('tiffinfo');

describe.skipIf(skipOracles)('PNG to TIFF is lossless by default', () => {
  it('decodes pixel-identical to the source (AE 0) and declares Deflate with horizontal differencing', async () => {
    const source = writeIn('rgb.png', rgbPng);
    const result = await convertImage(rgbPng, 'tiff', {}, 'rgb.png', 'png');
    const out = writeIn('rgb-default.tiff', result.buffer);
    expect(magickDifferingPixels(source, out)).toBe(0);
    const info = tiffinfo(out);
    expect(info).toMatch(/Compression Scheme: AdobeDeflate/);
    expect(info).toMatch(/Predictor: horizontal differencing/);
  });

  it('keeps lossless pixels when only a quality is given', async () => {
    const source = writeIn('rgb-q.png', rgbPng);
    const result = await convertImage(rgbPng, 'tiff', { quality: 40 }, 'rgb.png', 'png');
    const out = writeIn('rgb-quality.tiff', result.buffer);
    expect(magickDifferingPixels(source, out)).toBe(0);
    expect(tiffinfo(out)).toMatch(/Compression Scheme: AdobeDeflate/);
  });

  it('keeps the alpha channel as an unassociated extra sample', async () => {
    const source = writeIn('rgba.png', rgbaPng);
    const result = await convertImage(rgbaPng, 'tiff', {}, 'rgba.png', 'png');
    const out = writeIn('rgba-default.tiff', result.buffer);
    expect(magickDifferingPixels(source, out)).toBe(0);
    expect(runIdentify(['-format', '%A', out]).trim()).toMatch(/^(True|Blend)$/);
    expect(tiffinfo(out)).toMatch(/Extra Samples: 1<unassoc-alpha>/);
  });

  it.each([
    ['lzw', /Compression Scheme: LZW/, /Predictor: horizontal differencing/],
    ['none', /Compression Scheme: None/, null],
  ] as const)('writes %s when asked, still lossless', async (tiffCompression, scheme, predictor) => {
    const source = writeIn(`rgb-${tiffCompression}.png`, rgbPng);
    const result = await convertImage(rgbPng, 'tiff', { tiffCompression }, 'rgb.png', 'png');
    const out = writeIn(`rgb-${tiffCompression}.tiff`, result.buffer);
    expect(magickDifferingPixels(source, out)).toBe(0);
    const info = tiffinfo(out);
    expect(info).toMatch(scheme);
    if (predictor) expect(info).toMatch(predictor);
    else expect(info).not.toMatch(/Predictor:/);
  });

  it('writes JPEG only when tiffCompression is jpeg', async () => {
    const result = await convertImage(rgbPng, 'tiff', { tiffCompression: 'jpeg', quality: 80 }, 'rgb.png', 'png');
    const out = writeIn('rgb-jpeg.tiff', result.buffer);
    expect(tiffinfo(out)).toMatch(/Compression Scheme: JPEG/);
    expect(magickDifferingPixels(writeIn('rgb-jpeg-src.png', rgbPng), out)).toBeGreaterThan(0);
  });

  it('is smaller than the uncompressed file for a smooth picture', async () => {
    const smooth = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#3366cc' } })
      .png()
      .toBuffer();
    const deflate = await convertImage(smooth, 'tiff', {}, 'flat.png', 'png');
    const none = await convertImage(smooth, 'tiff', { tiffCompression: 'none' }, 'flat.png', 'png');
    expect(deflate.buffer.length).toBeLessThan(none.buffer.length / 20);
  });
});

describe.skipIf(skipWithoutTools('tiffinfo'))('vector sources use the same lossless default', () => {
  it('writes SVG to TIFF with Adobe Deflate and a horizontal predictor', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><rect width="64" height="48" fill="#c33"/><circle cx="32" cy="24" r="12" fill="#39f"/></svg>'
    );
    const result = await convertVectorCad(svg, 'svg', 'tiff', {}, 'shape.svg');
    const info = tiffinfo(writeIn('shape.tiff', result.buffer));
    expect(info).toMatch(/Compression Scheme: AdobeDeflate/);
    expect(info).toMatch(/Predictor: horizontal differencing/);
  });
});

describe('tiffCompression validation', () => {
  it('answers UnsupportedOptionError (400) for an unknown value', async () => {
    const run = convertImage(rgbPng, 'tiff', { tiffCompression: 'packbits' as never }, 'rgb.png', 'png');
    await expect(run).rejects.toBeInstanceOf(UnsupportedOptionError);
    await expect(run).rejects.toThrow(/tiffCompression/);
  });
});
