import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { OcrPreprocessError } from '../src/lib/types';
import {
  oddWindow,
  sauvolaBinarize,
  SAUVOLA_INK,
  SAUVOLA_MAX_PIXELS,
  SAUVOLA_MAX_WINDOW,
  SAUVOLA_MIN_WINDOW,
  SAUVOLA_PAPER,
} from '../src/lib/conversions/ocr-sauvola';
import { estimateLineHeight } from '../src/lib/conversions/ocr-text-metrics';
import { preprocessOcrImage } from '../src/lib/conversions/ocr-preprocess';

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'ocr');
const PAPER_LEVEL = 235;
const INK_LEVEL = 40;

/** Deterministic generator so every run sees the same pixels. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Reference Sauvola written straight from the paper's formula: every window is summed pixel by
 * pixel. It shares nothing with the integral-image implementation under test.
 */
function referenceSauvola(
  gray: Uint8Array,
  width: number,
  height: number,
  windowSize: number,
  k: number,
  range: number
): Uint8Array {
  const half = (windowSize - 1) / 2;
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let count = 0;
      let total = 0;
      let squares = 0;
      for (let yy = Math.max(0, y - half); yy <= Math.min(height - 1, y + half); yy++) {
        for (let xx = Math.max(0, x - half); xx <= Math.min(width - 1, x + half); xx++) {
          const value = gray[yy * width + xx];
          count++;
          total += value;
          squares += value * value;
        }
      }
      const mean = total / count;
      const deviation = Math.sqrt(Math.max(0, squares / count - mean * mean));
      const threshold = mean * (1 + k * (deviation / range - 1));
      out[y * width + x] = gray[y * width + x] <= threshold ? 0 : 255;
    }
  }
  return out;
}

describe('Sauvola binarization', () => {
  it('matches a hand-computed 3x3 window (k=0.5, R=128)', async () => {
    // Centre: mean 183.33, deviation 47.14, threshold 125.4 -> ink. Corner (0,0) sees the clipped
    // 2x2 window {200,200,200,50}: mean 162.5, deviation 64.95, threshold 122.5 -> paper.
    const gray = Uint8Array.from([200, 200, 200, 200, 50, 200, 200, 200, 200]);
    const out = await sauvolaBinarize(gray, 3, 3, { windowSize: 3, k: 0.5, dynamicRange: 128 });
    expect(Array.from(out)).toEqual([255, 255, 255, 255, 0, 255, 255, 255, 255]);
  });

  it('treats a uniform page as paper and a uniform black page as ink', async () => {
    const white = await sauvolaBinarize(new Uint8Array(40 * 30).fill(255), 40, 30, { windowSize: 9 });
    expect(new Set(white)).toEqual(new Set([SAUVOLA_PAPER]));
    const black = await sauvolaBinarize(new Uint8Array(40 * 30), 40, 30, { windowSize: 9 });
    expect(new Set(black)).toEqual(new Set([SAUVOLA_INK]));
  });

  for (const windowSize of [7, 15, 31]) {
    it(`equals the per-window reference on random pixels (window ${windowSize}, several strips)`, async () => {
      const width = 53;
      const height = 47;
      const next = mulberry32(windowSize);
      const gray = new Uint8Array(width * height).map(() => Math.floor(next() * 256));
      const k = 0.34;
      const range = 128;
      const expected = referenceSauvola(gray, width, height, windowSize, k, range);
      // A tiny cell budget forces strips of the minimum height, exercising the strip seams.
      const actual = await sauvolaBinarize(gray, width, height, { windowSize, k, dynamicRange: range, maxStripCells: 1 });
      expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);
    });
  }

  it('keeps strokes on a ramp that darkens the background to 35% (shaded page)', async () => {
    const width = 200;
    const height = 60;
    const gray = new Uint8Array(width * height);
    const strokes = new Set<number>();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const background = (0.35 + 0.65 * (x / width)) * PAPER_LEVEL;
        const isStroke = y >= 20 && y < 40 && x % 12 < 3 && x > 6;
        if (isStroke) strokes.add(y * width + x);
        gray[y * width + x] = Math.round(isStroke ? background * 0.45 : background);
      }
    }
    const out = await sauvolaBinarize(gray, width, height, { windowSize: 25 });
    let wrong = 0;
    for (let i = 0; i < out.length; i++) {
      const expectedInk = strokes.has(i);
      if ((out[i] === SAUVOLA_INK) !== expectedInk) wrong++;
    }
    expect(wrong).toBeLessThanOrEqual(width * height * 0.01);
  });

  it('rounds windows up to an odd size inside the allowed range', () => {
    expect(oddWindow(10)).toBe(11);
    expect(oddWindow(11)).toBe(11);
    expect(oddWindow(1)).toBe(SAUVOLA_MIN_WINDOW);
    expect(oddWindow(10_000)).toBe(SAUVOLA_MAX_WINDOW);
  });

  it('rejects a buffer whose length does not match the size, with a typed error', async () => {
    await expect(sauvolaBinarize(new Uint8Array(10), 4, 4, { windowSize: 5 })).rejects.toThrow(OcrPreprocessError);
    await expect(sauvolaBinarize(new Uint8Array(10), 4, 4, { windowSize: 5 })).rejects.toThrow(
      /holds 10 bytes but a 4x4 image needs 16/
    );
  });

  it('rejects invalid sizes and images above the pixel limit before allocating', async () => {
    await expect(sauvolaBinarize(new Uint8Array(0), 0, 0, { windowSize: 5 })).rejects.toThrow(/Invalid image size/);
    await expect(sauvolaBinarize(new Uint8Array(4), 1.5, 2, { windowSize: 5 })).rejects.toThrow(OcrPreprocessError);
    const side = Math.ceil(Math.sqrt(SAUVOLA_MAX_PIXELS)) + 1;
    await expect(sauvolaBinarize(new Uint8Array(4), side, side, { windowSize: 5 })).rejects.toThrow(
      /exceeds the \d+ pixel binarization limit/
    );
  });

  it('rejects a non-positive dynamic range', async () => {
    await expect(
      sauvolaBinarize(new Uint8Array(9), 3, 3, { windowSize: 3, dynamicRange: 0 })
    ).rejects.toThrow(OcrPreprocessError);
  });

  it('returns control to the event loop between strips', async () => {
    const width = 300;
    const height = 400;
    const gray = new Uint8Array(width * height).fill(200);
    let ticks = 0;
    let running = true;
    const spin = (): void => {
      if (!running) return;
      ticks++;
      setImmediate(spin);
    };
    setImmediate(spin);
    // 400 rows in strips of 16 rows is 25 strips, so 24 hand-offs.
    await sauvolaBinarize(gray, width, height, { windowSize: 5, maxStripCells: 1 });
    running = false;
    expect(ticks).toBeGreaterThanOrEqual(24);
  });
});

/** A page of `lines` dark bands of `bandHeight` rows, `pitch` rows apart, on paper. */
function bandPage(
  width: number,
  height: number,
  lines: number,
  bandHeight: number,
  pitch: number
): Uint8Array {
  const page = new Uint8Array(width * height).fill(SAUVOLA_PAPER);
  for (let line = 0; line < lines; line++) {
    const top = 20 + line * pitch;
    for (let y = top; y < top + bandHeight; y++) {
      for (let x = 10; x < width - 10; x++) {
        // Alternate ink and gaps like words, so a row holds about three quarters ink.
        if (x % 8 < 6) page[y * width + x] = SAUVOLA_INK;
      }
    }
  }
  return page;
}

describe('line height measurement', () => {
  it('returns the band height of the text lines', () => {
    expect(estimateLineHeight(bandPage(300, 240, 6, 13, 35), 300, 240)).toBe(13);
  });

  it('ignores speckles and thin rules between lines', () => {
    const page = bandPage(300, 240, 6, 13, 35);
    const next = mulberry32(5);
    for (let i = 0; i < 300; i++) page[Math.floor(next() * page.length)] = SAUVOLA_INK;
    for (let x = 0; x < 300; x++) page[(20 + 13 + 8) * 300 + x] = SAUVOLA_INK; // a 1 px rule in a gap
    expect(estimateLineHeight(page, 300, 240)).toBe(13);
  });

  it('returns null for a blank page', () => {
    expect(estimateLineHeight(new Uint8Array(100 * 80).fill(SAUVOLA_PAPER), 100, 80)).toBeNull();
  });

  it('rejects a buffer whose length does not match the size', () => {
    expect(() => estimateLineHeight(new Uint8Array(10), 4, 4)).toThrow(OcrPreprocessError);
  });
});

async function grayPixels(png: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(png).toColourspace('b-w').raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

describe('preprocessOcrImage', () => {
  const fixture = (name: string): Buffer => fs.readFileSync(path.join(FIXTURE_DIR, `${name}.png`));

  it('binarizes the shaded 300 dpi page to pure ink and paper at the source size', async () => {
    const result = await preprocessOcrImage(fixture('en_a__shade'));
    expect(result.applied.binarize).toBe(true);
    expect(result.geometry).toEqual({ sourceWidth: 2000, sourceHeight: 490, outputWidth: 2000, outputHeight: 490 });
    const { data, width, height } = await grayPixels(result.image);
    expect([width, height]).toEqual([2000, 490]);
    expect(new Set(data)).toEqual(new Set([SAUVOLA_INK, SAUVOLA_PAPER]));
    // Five text lines of 11 pt Liberation Serif at 300 dpi are about 42 px tall.
    expect(result.lineHeightPx).toBeGreaterThan(38);
    expect(result.lineHeightPx).toBeLessThan(48);
  });

  it('removes the brightness ramp: the left and right halves are equally inked', async () => {
    const { data, width, height } = await grayPixels((await preprocessOcrImage(fixture('en_a__shade'))).image);
    const inkIn = (x0: number, x1: number): number => {
      let ink = 0;
      for (let y = 0; y < height; y++) for (let x = x0; x < x1; x++) if (data[y * width + x] === SAUVOLA_INK) ink++;
      return ink;
    };
    const left = inkIn(0, width / 2);
    const right = inkIn(width / 2, width);
    expect(left / right).toBeGreaterThan(0.8);
    expect(left / right).toBeLessThan(1.25);
  });

  it('leaves a 72 dpi page (about 10 px lines) unbinarized', async () => {
    const result = await preprocessOcrImage(fixture('en_a__dpi72'));
    expect(result.applied.binarize).toBe(false);
    expect(result.lineHeightPx).toBeGreaterThan(8);
    expect(result.lineHeightPx).toBeLessThan(13);
    const { data } = await grayPixels(result.image);
    expect(new Set(data).size).toBeGreaterThan(2);
  });

  it('does not touch the page when the step is switched off', async () => {
    const source = fixture('en_a__shade');
    const result = await preprocessOcrImage(source, { binarize: false });
    expect(result.applied.binarize).toBe(false);
    const expected = await sharp(source).rotate().png().toBuffer();
    expect(result.image.equals(expected)).toBe(true);
  });

  it('rejects bytes that are not an image', async () => {
    await expect(preprocessOcrImage(Buffer.from('not an image'))).rejects.toThrow(/unsupported image format/);
  });
});
