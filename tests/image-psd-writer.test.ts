import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { UnsupportedOptionError } from '../src/lib/types';
import { magickDifferingPixels } from './helpers/magick-compare';
import { runConvert, runIdentify, SKIP_WITHOUT_MAGICK } from './helpers/imagemagick';
import { skipUnless } from './helpers/strict-skip';

/**
 * PSD output follows the Adobe Photoshop file format: planar PackBits channels, resolution and ICC image
 * resources, and for a picture with alpha one layer plus a merged image premultiplied against white. The
 * oracles are ImageMagick (`compare -metric AE` counts differing pixels; `identify` reads depth, profile and
 * resolution) and Pillow's PSD reader (size and mode). The 16-bit fixtures are built by ImageMagick, not by
 * the converter, and the converter's output is never read back by the converter.
 */

const WIDTH = 37;
const HEIGHT = 23;
const BYTE_MAX = 255;
const U16_MAX = 65535;
const NOISE_MULTIPLIER = 2654435761;
const SOURCE_DENSITY_PPI = 300;
const PSD_MAX_SIDE = 30_000;
/** Lowest alpha of the fixtures: colour under a fully transparent pixel is not part of the merged image. */
const MIN_ALPHA = 40;
/** Merged-image colours differ from the source by the white premultiplication's rounding only. */
const MERGED_FUZZ_PERCENT = 1;

function noise(index: number): number {
  return (Math.imul(index + 1, NOISE_MULTIPLIER) >>> 9) & 0xff;
}

function samples8(channels: 3 | 4): Buffer {
  const out = Buffer.alloc(WIDTH * HEIGHT * channels);
  for (let i = 0; i < WIDTH * HEIGHT; i += 1) {
    for (let c = 0; c < channels; c += 1) out[i * channels + c] = (noise(i * 4 + c) + i * (c + 1)) & BYTE_MAX;
    if (channels === 4) out[i * 4 + 3] = MIN_ALPHA + (noise(i) % (BYTE_MAX - MIN_ALPHA + 1));
  }
  return out;
}

/** Big-endian 16-bit samples with distinct high and low bytes, so an 8-bit truncation cannot pass. */
function samples16(channels: 3 | 4): Buffer {
  const out = Buffer.alloc(WIDTH * HEIGHT * channels * 2);
  for (let i = 0; i < WIDTH * HEIGHT; i += 1) {
    for (let c = 0; c < channels; c += 1) {
      const value = c === 3 ? 10_000 + ((noise(i) * 197 + i) % (U16_MAX - 10_000)) : (noise(i * 4 + c) * 257 + i * 31 + c) % (U16_MAX + 1);
      out.writeUInt16BE(value, (i * channels + c) * 2);
    }
  }
  return out;
}

function imagemagickPng16(channels: 3 | 4): Buffer {
  const layout = channels === 3 ? 'rgb' : 'rgba';
  return runConvert(['-size', `${WIDTH}x${HEIGHT}`, '-depth', '16', '-endian', 'MSB', `${layout}:-`, '-depth', '16', 'png:-'], samples16(channels));
}

const pillowAvailable = spawnSync('python3', ['-I', '-c', 'import PIL.PsdImagePlugin'], { encoding: 'utf-8' }).status === 0;

function pillowReads(file: string): { mode: string; width: number; height: number } {
  const script =
    'import sys, json; from PIL import Image; im = Image.open(sys.argv[1]); im.load(); print(json.dumps({"mode": im.mode, "width": im.width, "height": im.height}))';
  return JSON.parse(execFileSync('python3', ['-I', '-c', script, file], { encoding: 'utf-8' }));
}

let workDir: string;
const fixtures: Record<string, Buffer> = {};

beforeAll(async () => {
  workDir = mkdtempSync(path.join(os.tmpdir(), 'psd-writer-'));
  fixtures.rgb = await sharp(samples8(3), { raw: { width: WIDTH, height: HEIGHT, channels: 3 } }).png().toBuffer();
  fixtures.rgba = await sharp(samples8(4), { raw: { width: WIDTH, height: HEIGHT, channels: 4 } }).png().toBuffer();
  fixtures.profiled = await sharp(samples8(3), { raw: { width: WIDTH, height: HEIGHT, channels: 3 } })
    .withIccProfile('p3')
    .withMetadata({ density: SOURCE_DENSITY_PPI })
    .png()
    .toBuffer();
  if (!SKIP_WITHOUT_MAGICK) {
    fixtures.rgb16 = imagemagickPng16(3);
    fixtures.rgba16 = imagemagickPng16(4);
  }
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function writeIn(name: string, bytes: Buffer): string {
  const file = path.join(workDir, name);
  writeFileSync(file, bytes);
  return file;
}

async function toPsd(name: string, options = {}): Promise<{ source: string; psd: string }> {
  const source = fixtures[name];
  const result = await convertImage(source, 'psd', options, `${name}.png`, 'png');
  expect(result.buffer.subarray(0, 4).toString('ascii')).toBe('8BPS');
  return { source: writeIn(`${name}.png`, source), psd: writeIn(`${name}-${Object.keys(options).join('') || 'default'}.psd`, result.buffer) };
}

describe.skipIf(SKIP_WITHOUT_MAGICK)('PSD output is read back bit-exactly by ImageMagick', () => {
  it('RGB: one merged image, AE 0', async () => {
    const { source, psd } = await toPsd('rgb');
    expect(magickDifferingPixels(source, psd)).toBe(0);
    expect(runIdentify(['-format', '%z %w %h %n,', psd]).trim()).toBe(`8 ${WIDTH} ${HEIGHT} 1,`);
  });

  it('RGBA: the layer is exact (AE 0) and the merged image matches within the white premultiplication rounding', async () => {
    const { source, psd } = await toPsd('rgba');
    expect(magickDifferingPixels(source, `${psd}[1]`)).toBe(0);
    expect(magickDifferingPixels(source, `${psd}[0]`, MERGED_FUZZ_PERCENT)).toBe(0);
    expect(runIdentify(['-format', '%A,', `${psd}[0]`]).trim()).toMatch(/^(True|Blend),$/);
  });

  it('16-bit RGB keeps every sample (depth 16, AE 0)', async () => {
    const { source, psd } = await toPsd('rgb16');
    expect(runIdentify(['-format', '%z', source]).trim()).toBe('16');
    expect(runIdentify(['-format', '%z', psd]).trim()).toBe('16');
    expect(magickDifferingPixels(source, psd)).toBe(0);
  });

  it('16-bit RGBA keeps every sample of the layer and the transparency', async () => {
    const { source, psd } = await toPsd('rgba16');
    expect(runIdentify(['-format', '%z,', `${psd}[1]`]).trim()).toBe('16,');
    expect(magickDifferingPixels(source, `${psd}[1]`)).toBe(0);
    expect(magickDifferingPixels(source, `${psd}[0]`, MERGED_FUZZ_PERCENT)).toBe(0);
  });

  it('keeps the embedded ICC profile (resource 1039) and the source density (resource 1005)', async () => {
    const { source, psd } = await toPsd('profiled');
    expect(magickDifferingPixels(source, psd)).toBe(0);
    expect(runIdentify(['-verbose', psd])).toMatch(/Profile-icc: \d+ bytes/);
    expect(runIdentify(['-format', '%x %y %U', psd]).trim()).toBe(`${SOURCE_DENSITY_PPI} ${SOURCE_DENSITY_PPI} PixelsPerInch`);
  });

  it('drops the profile when metadata is stripped', async () => {
    const { psd } = await toPsd('profiled', { stripMetadata: true });
    expect(runIdentify(['-verbose', psd])).not.toMatch(/Profile-icc/);
  });
});

describe.skipIf(skipUnless('Pillow with PsdImagePlugin', pillowAvailable))('a second reader opens the file', () => {
  it.each([
    ['rgb', 'RGB'],
    ['rgba', 'RGBA'],
  ] as const)('Pillow reads %s with the right size and mode', async (name, mode) => {
    const { psd } = await toPsd(name);
    expect(pillowReads(psd)).toEqual({ mode, width: WIDTH, height: HEIGHT });
  });
});

describe('PSD size limit', () => {
  it('answers UnsupportedOptionError (400) for a picture wider than 30000 pixels', async () => {
    const wide = await sharp({ create: { width: PSD_MAX_SIDE + 1, height: 1, channels: 3, background: '#fff' } })
      .png()
      .toBuffer();
    const run = convertImage(wide, 'psd', {}, 'wide.png', 'png');
    await expect(run).rejects.toBeInstanceOf(UnsupportedOptionError);
    await expect(run).rejects.toThrow(/30000/);
  });

  it('answers the same error when a resize asks for more than 30000 pixels', async () => {
    const small = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).png().toBuffer();
    const run = convertImage(small, 'psd', { width: PSD_MAX_SIDE + 1, height: 1, fit: 'fill' }, 'small.png', 'png');
    await expect(run).rejects.toBeInstanceOf(UnsupportedOptionError);
    await expect(run).rejects.toThrow(/30001 x 1/);
  });
});
