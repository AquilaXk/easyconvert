import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BLUE_NOISE_CELLS, BLUE_NOISE_SIDE, blueNoiseRanks } from '../src/lib/conversions/blue-noise-mask';
import { mapToPalette, quantizeImage } from '../src/lib/conversions/color-quantizer';
import { encodeGif } from '../src/lib/conversions/gif-writer';
import { KdTree3 } from '../src/lib/conversions/kd-tree';
import { ConversionFailedError } from '../src/lib/types';
import { getOracleToolPath, requireOracleTool } from './helpers/differential-oracle';
import { bandMean, powerSpectrum, radialPower } from './helpers/image-spectrum';
import { runConvert, SKIP_WITHOUT_MAGICK } from './helpers/imagemagick';
import { skipUnless, skipWithoutTools } from './helpers/strict-skip';

/**
 * The pieces of the palette quantizer, each against an independent oracle: a brute-force scan for the k-d tree, the
 * Fourier spectrum of the void-and-cluster mask (white noise and the old golden-ratio ramp must fail the same
 * test), the sRGB transfer function for dithering in linear light, and three GIF decoders (ImageMagick, ffmpeg and
 * Pillow) for the LZW stream.
 */

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe('k-d tree', () => {
  it.each([1, 2, 3, 17, 64, 256])('finds the same nearest point as a full scan in a palette of %i points, with and without a hint', (count) => {
    const random = lcg(count * 7919);
    const points = new Float64Array(count * 3);
    for (let i = 0; i < points.length; i += 1) points[i] = random();
    // Duplicate one point so a tie must go to the lower index.
    if (count > 2) points.copyWithin(2 * 3, 0, 3);
    const tree = new KdTree3(points, count);
    for (let q = 0; q < 600; q += 1) {
      const x = random() * 1.2 - 0.1;
      const y = random() * 1.2 - 0.1;
      const z = random() * 1.2 - 0.1;
      let best = -1;
      let bestDistance = Infinity;
      for (let i = 0; i < count; i += 1) {
        const d = (x - points[i * 3]) ** 2 + (y - points[i * 3 + 1]) ** 2 + (z - points[i * 3 + 2]) ** 2;
        if (d < bestDistance) {
          bestDistance = d;
          best = i;
        }
      }
      expect(tree.nearestIndex(x, y, z)).toBe(best);
      expect(tree.lastDistance2).toBeCloseTo(bestDistance, 12);
      expect(tree.nearestIndex(x, y, z, Math.floor(random() * count))).toBe(best);
    }
  });

  it('answers a query that lands exactly on a duplicated point with the lower index', () => {
    const tree = new KdTree3([0.2, 0.2, 0.2, 0.9, 0.9, 0.9, 0.2, 0.2, 0.2], 3);
    expect(tree.nearestIndex(0.2, 0.2, 0.2)).toBe(0);
    expect(tree.nearestIndex(0.2, 0.2, 0.2, 2)).toBe(0);
  });

  it('refuses an empty tree and a tree over the point limit', () => {
    expect(() => new KdTree3([], 0)).toThrow(RangeError);
    expect(() => new KdTree3(new Float64Array(3 * 5000), 5000)).toThrow(RangeError);
  });
});

describe('void-and-cluster blue-noise mask', () => {
  const n = BLUE_NOISE_SIDE;
  /** Power at low radial frequency (1 to 4 cycles per mask width) over power at high frequency (16 to 31). */
  function lowToHighRatio(mask: ArrayLike<number>, level: number): number {
    const pattern = new Float64Array(BLUE_NOISE_CELLS);
    for (let i = 0; i < BLUE_NOISE_CELLS; i += 1) pattern[i] = mask[i] < level * BLUE_NOISE_CELLS ? 1 : 0;
    const mean = pattern.reduce((a, b) => a + b, 0) / BLUE_NOISE_CELLS;
    const radial = radialPower(powerSpectrum(pattern.map((v) => v - mean), n), n);
    return bandMean(radial, 1, 4) / bandMean(radial, 16, 31);
  }
  /** Blue noise has almost no low-frequency energy; white noise and a lattice have about as much as anywhere. */
  const MAX_LOW_TO_HIGH = 0.1;

  it('is a permutation of the ranks 0 to 4095', () => {
    const ranks = blueNoiseRanks();
    expect(ranks).toHaveLength(BLUE_NOISE_CELLS);
    expect(new Set(ranks).size).toBe(BLUE_NOISE_CELLS);
    expect(Math.max(...ranks)).toBe(BLUE_NOISE_CELLS - 1);
  });

  it.each([0.1, 0.25, 0.5])('thresholded at %f of the range has at most a tenth of its high-frequency power at low frequencies', (level) => {
    expect(lowToHighRatio(blueNoiseRanks(), level)).toBeLessThanOrEqual(MAX_LOW_TO_HIGH);
  });

  it('the test fails for white noise and for the golden-ratio ramp the old mask was', () => {
    const random = lcg(99);
    const white = new Float64Array(BLUE_NOISE_CELLS).map(() => Math.floor(random() * BLUE_NOISE_CELLS));
    const phi = 1.618033988749895;
    const ramp = new Float64Array(BLUE_NOISE_CELLS);
    for (let y = 0; y < n; y += 1) for (let x = 0; x < n; x += 1) ramp[y * n + x] = ((x * phi + y * phi * phi) % 1) * BLUE_NOISE_CELLS;
    for (const level of [0.1, 0.25, 0.5]) {
      expect(lowToHighRatio(white, level)).toBeGreaterThan(MAX_LOW_TO_HIGH);
    }
    expect(lowToHighRatio(ramp, 0.5)).toBeGreaterThan(MAX_LOW_TO_HIGH);
  });

  it('is the same on every run (fixed seed, ties by position)', () => {
    const first = Array.from(blueNoiseRanks().subarray(0, 16));
    expect(first).toEqual(Array.from(blueNoiseRanks().subarray(0, 16)));
  });
});

describe('dithering in linear light', () => {
  const lin = (code: number): number => (code / 255 <= 0.04045 ? code / 255 / 12.92 : Math.pow((code / 255 + 0.055) / 1.055, 2.4));
  const FOUR_GREYS = [0, 85, 170, 255];

  /** Mean linear light of a flat picture of `value` after mapping to the given greys with `kind`, and the source's. */
  function meanLight(kind: 'floyd-steinberg' | 'riemersma' | 'blue-noise', value: number, levels: number[]): { got: number; source: number } {
    const side = 96;
    const palette = Uint8Array.from(levels.flatMap((level) => [level, level, level]));
    const rgba = new Uint8Array(side * side * 4);
    for (let i = 0; i < side * side; i += 1) rgba.set([value, value, value, 255], i * 4);
    const indices = mapToPalette(rgba, side, side, palette, levels.length, kind);
    let total = 0;
    for (const index of indices) total += lin(levels[index]);
    return { got: total / indices.length, source: lin(value) };
  }

  it('Floyd-Steinberg keeps the light of a flat sRGB 128 on four greys within 5% (diffusing sRGB codes would be 14% off)', () => {
    // The mean of a dither is what the eye integrates, and light adds in linear terms. Between the greys 85 and 170
    // a gamma-space diffusion averages the codes to 128 and so mixes the two half and half: 0.246 for 0.216.
    const { got, source } = meanLight('floyd-steinberg', 128, FOUR_GREYS);
    expect(Math.abs(got - source) / source).toBeLessThan(0.05);
  });

  it('Floyd-Steinberg keeps the light of a dark and of a bright flat area too', () => {
    const dark = meanLight('floyd-steinberg', 60, FOUR_GREYS);
    expect(Math.abs(dark.got - dark.source) / dark.source).toBeLessThan(0.1);
    const bright = meanLight('floyd-steinberg', 200, FOUR_GREYS);
    expect(Math.abs(bright.got - bright.source) / bright.source).toBeLessThan(0.05);
  });

  it('Riemersma works in Oklab, so it keeps perceived lightness instead: sRGB 128 on black and white mixes 0.6 white', () => {
    // Oklab L of sRGB 128 is 0.60; this is the documented difference between the two methods.
    const { got } = meanLight('riemersma', 128, [0, 255]);
    expect(got).toBeGreaterThan(0.55);
    expect(got).toBeLessThan(0.65);
  });

  it('blue-noise dithering keeps a flat area between its two nearest palette colours, with both present', () => {
    const { got } = meanLight('blue-noise', 128, [0, 255]);
    expect(got).toBeGreaterThan(0.05);
    expect(got).toBeLessThan(0.95);
  });

  it('error diffusion runs serpentine: the share of white is the same on a mirrored picture', () => {
    const side = 64;
    const rgba = new Uint8Array(side * side * 4);
    const mirrored = new Uint8Array(side * side * 4);
    for (let y = 0; y < side; y += 1) {
      for (let x = 0; x < side; x += 1) {
        const v = Math.round((x / (side - 1)) * 255);
        rgba.set([v, v, v, 255], (y * side + x) * 4);
        mirrored.set([255 - v, 255 - v, 255 - v, 255], (y * side + x) * 4);
      }
    }
    const blackWhite = Uint8Array.of(0, 0, 0, 255, 255, 255);
    const a = mapToPalette(rgba, side, side, blackWhite, 2, 'floyd-steinberg').reduce((sum, i) => sum + i, 0);
    const b = mapToPalette(mirrored, side, side, blackWhite, 2, 'floyd-steinberg').reduce((sum, i) => sum + i, 0);
    expect(Math.abs(a - b)).toBeLessThanOrEqual(side * 2);
  });
});

describe('quantizeImage', () => {
  it('keeps every colour of an image that has no more than the palette allows, exactly', () => {
    const colours = [[10, 20, 30], [250, 250, 250], [11, 20, 30], [0, 0, 0], [123, 45, 67]];
    const side = 20;
    const rgba = new Uint8Array(side * side * 4);
    for (let i = 0; i < side * side; i += 1) rgba.set([...colours[i % colours.length], 255], i * 4);
    const image = quantizeImage(rgba, side, side, 256, { dither: 'floyd-steinberg' });
    expect(image.paletteSize).toBe(colours.length);
    for (let i = 0; i < side * side; i += 1) {
      const c = colours[i % colours.length];
      expect([...image.palette.subarray(image.indices[i] * 3, image.indices[i] * 3 + 3)]).toEqual(c);
    }
  });

  it('reserves one index for transparent pixels and leaves them out of the palette', () => {
    const random = lcg(5);
    const side = 40;
    const rgba = new Uint8Array(side * side * 4);
    for (let i = 0; i < side * side; i += 1) rgba.set([Math.floor(random() * 256), Math.floor(random() * 256), Math.floor(random() * 256), i % 7 === 0 ? 0 : 255], i * 4);
    const image = quantizeImage(rgba, side, side, 16, { dither: 'floyd-steinberg', transparency: 'threshold' });
    expect(image.paletteSize).toBeLessThanOrEqual(16);
    expect(image.transparentIndex).toBe(image.paletteSize - 1);
    for (let i = 0; i < side * side; i += 1) expect(image.indices[i] === image.transparentIndex).toBe(i % 7 === 0);
  });

  it('answers one colour for a request of one, and a picture with no opaque pixel with the transparent index only', () => {
    const random = lcg(8);
    const rgba = new Uint8Array(30 * 30 * 4);
    for (let i = 0; i < rgba.length; i += 1) rgba[i] = i % 4 === 3 ? 255 : Math.floor(random() * 256);
    expect(quantizeImage(rgba, 30, 30, 1).paletteSize).toBe(1);
    const clear = new Uint8Array(4 * 4 * 4);
    const image = quantizeImage(clear, 4, 4, 8, { transparency: 'threshold' });
    expect([...image.indices]).toEqual(new Array(16).fill(image.transparentIndex));
  });

  it('refuses a raster that is not width x height RGBA and a size that is not positive', () => {
    expect(() => quantizeImage(new Uint8Array(15), 2, 2, 8)).toThrow(ConversionFailedError);
    expect(() => quantizeImage(new Uint8Array(16), 0, 2, 8)).toThrow(/positive integer size/);
    expect(() => mapToPalette(new Uint8Array(16), 2, 2, Uint8Array.of(1, 2, 3), 2, 'none')).toThrow(/palette holds/);
  });

  it('is deterministic', () => {
    const random = lcg(21);
    const rgba = new Uint8Array(50 * 50 * 4);
    for (let i = 0; i < rgba.length; i += 1) rgba[i] = i % 4 === 3 ? 255 : Math.floor(random() * 256);
    const a = quantizeImage(rgba, 50, 50, 32, { dither: 'floyd-steinberg' });
    const b = quantizeImage(rgba, 50, 50, 32, { dither: 'floyd-steinberg' });
    expect(Buffer.compare(Buffer.from(a.indices), Buffer.from(b.indices))).toBe(0);
    expect(Buffer.compare(Buffer.from(a.palette), Buffer.from(b.palette))).toBe(0);
  });
});

describe('GIF writer', () => {
  let workDir: string;
  beforeAll(() => {
    workDir = mkdtempSync(path.join(os.tmpdir(), 'gif-writer-'));
  });
  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  /** RGBA a decoder must produce: palette colours, with alpha 0 at the transparent index. */
  function expectedRgba(palette: Uint8Array, indices: Uint8Array, transparentIndex: number): Buffer {
    const out = Buffer.alloc(indices.length * 4);
    indices.forEach((index, i) => {
      out.set([palette[index * 3], palette[index * 3 + 1], palette[index * 3 + 2], index === transparentIndex ? 0 : 255], i * 4);
    });
    return out;
  }

  function fixture(width: number, height: number, colours: number, kind: 'noise' | 'bands' | 'gradient'): { palette: Uint8Array; indices: Uint8Array } {
    const random = lcg(width * 31 + colours);
    const palette = new Uint8Array(colours * 3);
    for (let i = 0; i < palette.length; i += 1) palette[i] = Math.floor(random() * 256);
    const indices = new Uint8Array(width * height);
    for (let i = 0; i < indices.length; i += 1) {
      if (kind === 'noise') indices[i] = Math.floor(random() * colours);
      else if (kind === 'bands') indices[i] = Math.floor(i / width / 3) % colours;
      else indices[i] = Math.floor(((i % width) / width) * colours);
    }
    return { palette, indices };
  }

  const cases: Array<[string, number, number, number, 'noise' | 'bands' | 'gradient', number]> = [
    ['1 x 1', 1, 1, 2, 'noise', -1],
    ['2 colours, bands', 40, 30, 2, 'bands', -1],
    ['3 colours, gradient', 90, 20, 3, 'gradient', -1],
    ['5 colours with a transparent index', 33, 27, 5, 'noise', 4],
    ['16 colours, noise', 120, 80, 16, 'noise', -1],
    ['100 colours, gradient', 250, 40, 100, 'gradient', 99],
    ['256 colours, noise (fills and clears the LZW table)', 300, 220, 256, 'noise', -1],
    ['256 colours, long runs', 400, 300, 256, 'bands', 0],
  ];

  it.skipIf(SKIP_WITHOUT_MAGICK).each(cases)('ImageMagick decodes %s to the exact pixels', (_name, width, height, colours, kind, transparent) => {
    const { palette, indices } = fixture(width, height, colours, kind);
    const gif = encodeGif({ width, height, palette, paletteSize: colours, indices, transparentIndex: transparent });
    expect(gif.subarray(0, 6).toString('ascii')).toBe('GIF89a');
    expect(gif[gif.length - 1]).toBe(0x3b);
    const file = path.join(workDir, 'writer.gif');
    writeFileSync(file, gif);
    const decoded = runConvert([file, '-depth', '8', 'rgba:-']);
    expect(Buffer.compare(decoded, expectedRgba(palette, indices, transparent))).toBe(0);
  });

  it.skipIf(skipWithoutTools('ffmpeg')).each(cases.slice(3))('ffmpeg decodes %s to the exact pixels', (_name, width, height, colours, kind, transparent) => {
    const { palette, indices } = fixture(width, height, colours, kind);
    const gif = encodeGif({ width, height, palette, paletteSize: colours, indices, transparentIndex: transparent });
    const file = path.join(workDir, 'ffmpeg.gif');
    writeFileSync(file, gif);
    const decoded = execFileSync(requireOracleTool('ffmpeg'), ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28 });
    const expected = expectedRgba(palette, indices, transparent);
    expect(decoded).toHaveLength(expected.length);
    // ffmpeg leaves the colour of a transparent pixel unspecified: alpha must agree everywhere, colour where opaque.
    for (let i = 0; i < expected.length; i += 4) {
      expect(decoded[i + 3]).toBe(expected[i + 3]);
      if (expected[i + 3] === 255) expect([...decoded.subarray(i, i + 3)]).toEqual([...expected.subarray(i, i + 3)]);
    }
  });

  const pillow = spawnSync('python3', ['-I', '-c', 'import PIL.GifImagePlugin'], { encoding: 'utf-8' }).status === 0;
  it.skipIf(skipUnless('Pillow', pillow)).each(cases)('Pillow decodes %s to the exact pixels', (_name, width, height, colours, kind, transparent) => {
    const { palette, indices } = fixture(width, height, colours, kind);
    const gif = encodeGif({ width, height, palette, paletteSize: colours, indices, transparentIndex: transparent });
    const file = path.join(workDir, 'pillow.gif');
    writeFileSync(file, gif);
    const script = 'import sys; from PIL import Image; im = Image.open(sys.argv[1]).convert("RGBA"); sys.stdout.buffer.write(im.tobytes())';
    const decoded = execFileSync('python3', ['-I', '-c', script, file], { maxBuffer: 1 << 28 });
    expect(Buffer.compare(decoded, expectedRgba(palette, indices, transparent))).toBe(0);
  });

  it('refuses sizes and palettes a GIF cannot hold', () => {
    const palette = new Uint8Array(6);
    expect(() => encodeGif({ width: 0, height: 1, palette, paletteSize: 2, indices: new Uint8Array(0), transparentIndex: -1 })).toThrow(ConversionFailedError);
    expect(() => encodeGif({ width: 65_536, height: 1, palette, paletteSize: 2, indices: new Uint8Array(65_536), transparentIndex: -1 })).toThrow(/pixels on a side/);
    expect(() => encodeGif({ width: 1, height: 1, palette, paletteSize: 300, indices: new Uint8Array(1), transparentIndex: -1 })).toThrow(/palette holds/);
    expect(() => encodeGif({ width: 2, height: 2, palette, paletteSize: 2, indices: new Uint8Array(3), transparentIndex: -1 })).toThrow(/palette indices/);
  });
});
