import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { magickDifferingPixels } from './helpers/magick-compare';
import { runConvert, runIdentify, SKIP_WITHOUT_MAGICK } from './helpers/imagemagick';

/**
 * Sources with 16 bits per sample keep them in PNG and TIFF output. The fixtures are built by ImageMagick from raw
 * big-endian samples, so no 16-bit value is a scaled 8-bit one; the oracle is ImageMagick's depth report
 * (`identify -format %z`), its count of distinct colours (a 1024-step ramp has 1024 of them at 16 bits and at most
 * 256 at 8) and `compare -metric AE`, which is exact at 16 bits.
 */

const COLUMNS = 1024;
const ROWS = 8;
const RAMP_STEP = 64;

let workDir: string;
let rgbRamp: Buffer;
let greyRamp: Buffer;

function ramp(channels: 1 | 3): Buffer {
  const samples = Buffer.alloc(COLUMNS * ROWS * channels * 2);
  for (let y = 0; y < ROWS; y += 1) {
    for (let x = 0; x < COLUMNS; x += 1) {
      for (let c = 0; c < channels; c += 1) samples.writeUInt16BE(x * RAMP_STEP + c * 7, ((y * COLUMNS + x) * channels + c) * 2);
    }
  }
  return samples;
}

function png16(channels: 1 | 3): Buffer {
  const layout = channels === 1 ? 'gray' : 'rgb';
  return runConvert(['-size', `${COLUMNS}x${ROWS}`, '-depth', '16', '-endian', 'MSB', `${layout}:-`, '-depth', '16', 'png:-'], ramp(channels));
}

function write(name: string, bytes: Buffer): string {
  const file = path.join(workDir, name);
  writeFileSync(file, bytes);
  return file;
}

const depthOf = (file: string): string => runIdentify(['-format', '%z', file]).trim();
const coloursOf = (file: string): number => Number(runIdentify(['-format', '%k', file]).trim());

beforeAll(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), 'depth16-'));
  if (!SKIP_WITHOUT_MAGICK) {
    rgbRamp = png16(3);
    greyRamp = png16(1);
  }
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe.skipIf(SKIP_WITHOUT_MAGICK)('16-bit sources', () => {
  it('fixtures are really 16-bit with more than 256 levels', () => {
    const file = write('source.png', rgbRamp);
    expect(depthOf(file)).toBe('16');
    expect(coloursOf(file)).toBe(COLUMNS);
  });

  it.each(['png', 'tiff'] as const)('RGB %s output stays 16-bit and pixel-identical (AE 0)', async (target) => {
    const source = write(`rgb-source-${target}.png`, rgbRamp);
    const out = write(`rgb-out.${target}`, (await convertImage(rgbRamp, target, {}, 'ramp.png', 'png')).buffer);
    expect(depthOf(out)).toBe('16');
    expect(coloursOf(out)).toBe(COLUMNS);
    expect(magickDifferingPixels(source, out)).toBe(0);
  });

  it.each(['png', 'tiff'] as const)('grey %s output stays 16-bit, grey and pixel-identical', async (target) => {
    const source = write(`grey-source-${target}.png`, greyRamp);
    const out = write(`grey-out.${target}`, (await convertImage(greyRamp, target, {}, 'ramp.png', 'png')).buffer);
    expect(depthOf(out)).toBe('16');
    expect(runIdentify(['-format', '%[colorspace]', out]).trim()).toBe('Gray');
    expect(magickDifferingPixels(source, out)).toBe(0);
  });

  it('keeps 16 bits through a linear-light downscale', async () => {
    const out = write('down.png', (await convertImage(rgbRamp, 'png', { width: COLUMNS / 2, height: ROWS / 2 }, 'ramp.png', 'png')).buffer);
    expect(depthOf(out)).toBe('16');
    expect(coloursOf(out)).toBeGreaterThan(256);
  });

  it('writes 8 bits when asked for colorDepth 8, and for the 8-bit-only targets', async () => {
    expect(depthOf(write('eight.png', (await convertImage(rgbRamp, 'png', { colorDepth: 8 }, 'ramp.png', 'png')).buffer))).toBe('8');
    expect(depthOf(write('eight.jpg', (await convertImage(rgbRamp, 'jpg', {}, 'ramp.png', 'png')).buffer))).toBe('8');
    expect(depthOf(write('eight.webp', (await convertImage(rgbRamp, 'webp', {}, 'ramp.png', 'png')).buffer))).toBe('8');
  });

  it('leaves an 8-bit source at 8 bits', async () => {
    const eight = runConvert([write('wide.png', rgbRamp), '-depth', '8', 'png:-']);
    expect(depthOf(write('eight-out.png', (await convertImage(eight, 'png', {}, 'eight.png', 'png')).buffer))).toBe('8');
  });
});
