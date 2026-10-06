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
import {
  estimateLineHeight,
  estimateSkew,
  lineHeightFromProfile,
  OCR_DESKEW_MAX_DEGREES,
} from '../src/lib/conversions/ocr-text-metrics';
import { OCR_MAX_UPSCALE, OCR_PREPROCESS_MAX_PIXELS, planRescale, preprocessOcrImage } from '../src/lib/conversions/ocr-preprocess';
import { identityGeometry, mapBoxToSource, mapOcrResultToSource } from '../src/lib/conversions/ocr-geometry';
import type { OcrResult } from '../src/lib/conversions/ocr-pdf-combiner';

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'ocr');
const PAPER_LEVEL = 235;
/** Line heights the recognizer reads best, from the issue. */
const MIN_LINE_HEIGHT_PX = 30;
const MAX_LINE_HEIGHT_PX = 40;

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

/** A text-like page turned by sharp (an independent rotation) and thresholded back to ink and paper. */
async function rotatedBandPage(
  angleClockwise: number
): Promise<{ binary: Uint8Array; width: number; height: number }> {
  const width = 700;
  const height = 420;
  const page = bandPage(width, height, 8, 14, 46);
  const { data, info } = await sharp(Buffer.from(page), { raw: { width, height, channels: 1 } })
    .rotate(angleClockwise, { background: '#ffffff' })
    .toColourspace('b-w')
    .raw()
    .toBuffer({ resolveWithObject: true });
  const binary = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) binary[i] = data[i] < 128 ? SAUVOLA_INK : SAUVOLA_PAPER;
  return { binary, width: info.width, height: info.height };
}

const SKEW_TOLERANCE_DEGREES = 0.15;

describe('skew estimation', () => {
  // Text turned clockwise by A needs a clockwise correction of -A, so the estimate is -A.
  for (const angle of [-7, -3, -0.4, 0.4, 2, 6.5, 9.5]) {
    it(`finds a page turned ${angle} degrees clockwise`, async () => {
      const { binary, width, height } = await rotatedBandPage(angle);
      const { degrees } = await estimateSkew(binary, width, height);
      expect(Math.abs(degrees - -angle)).toBeLessThanOrEqual(SKEW_TOLERANCE_DEGREES);
    });
  }

  it('reports no skew for straight text', async () => {
    const page = bandPage(700, 420, 8, 14, 46);
    const { degrees } = await estimateSkew(page, 700, 420);
    expect(Math.abs(degrees)).toBeLessThanOrEqual(0.05);
  });

  it('never reports more than the search range', async () => {
    const { binary, width, height } = await rotatedBandPage(18);
    const { degrees } = await estimateSkew(binary, width, height);
    expect(Math.abs(degrees)).toBeLessThanOrEqual(OCR_DESKEW_MAX_DEGREES);
  });

  it('reports no skew, and no gain, for a blank page', async () => {
    const result = await estimateSkew(new Uint8Array(200 * 100).fill(SAUVOLA_PAPER), 200, 100);
    expect(result.degrees).toBe(0);
    expect(result.improvement).toBe(1);
  });

  it('measures the line height along the detected direction of a skewed page', async () => {
    const { binary, width, height } = await rotatedBandPage(4);
    // Straight along the page the 4 degree lines run into each other.
    expect(estimateLineHeight(binary, width, height) as number).toBeGreaterThan(30);
    const { profile } = await estimateSkew(binary, width, height);
    const measured = lineHeightFromProfile(profile) as number;
    expect(measured).toBeGreaterThanOrEqual(12);
    expect(measured).toBeLessThanOrEqual(16);
  });

  it('stays bounded on a page that is all ink', async () => {
    const result = await estimateSkew(new Uint8Array(1500 * 1500).fill(SAUVOLA_INK), 1500, 1500);
    expect(Math.abs(result.degrees)).toBeLessThanOrEqual(OCR_DESKEW_MAX_DEGREES);
  });

  it('rejects a buffer whose length does not match the size', async () => {
    await expect(estimateSkew(new Uint8Array(10), 4, 4)).rejects.toThrow(OcrPreprocessError);
  });
});

describe('rescale planning', () => {
  it('aims 10 px lines at 35 px (a factor of 3.5)', () => {
    expect(planRescale(10, 480, 117)).toBeCloseTo(3.5, 10);
    expect(planRescale(20, 1000, 800)).toBeCloseTo(1.75, 10);
  });

  it('never shrinks: lines of 30 px or more, and unmeasured pages, keep their size', () => {
    expect(planRescale(30, 1000, 800)).toBe(1);
    expect(planRescale(42.5, 2000, 490)).toBe(1);
    expect(planRescale(300, 2000, 490)).toBe(1);
    expect(planRescale(null, 1000, 800)).toBe(1);
    expect(planRescale(0, 1000, 800)).toBe(1);
  });

  it('caps the enlargement at OCR_MAX_UPSCALE', () => {
    expect(planRescale(2, 400, 300)).toBe(OCR_MAX_UPSCALE);
    expect(OCR_MAX_UPSCALE).toBe(4);
  });

  it('keeps the enlarged page inside the pixel budget', () => {
    const scale = planRescale(8, 6000, 5000);
    expect(scale).toBeGreaterThan(1);
    expect(Math.round(6000 * scale) * Math.round(5000 * scale)).toBeLessThanOrEqual(OCR_PREPROCESS_MAX_PIXELS * 1.001);
    // A page already at the budget cannot grow at all.
    expect(planRescale(8, 10_000, 5_000)).toBe(1);
  });
});

describe('mapping boxes back to the source image', () => {
  const doubled = {
    sourceWidth: 100,
    sourceHeight: 50,
    scaledWidth: 200,
    scaledHeight: 100,
    outputWidth: 200,
    outputHeight: 100,
    rotationDegrees: 0,
  };

  it('divides a box of the enlarged image by the scale', () => {
    expect(mapBoxToSource({ x: 20, y: 10, width: 40, height: 20 }, doubled)).toEqual({
      x: 10,
      y: 5,
      width: 20,
      height: 10,
    });
  });

  it('keeps boxes inside the source and at least one pixel wide', () => {
    expect(mapBoxToSource({ x: 190, y: 90, width: 40, height: 40 }, doubled)).toEqual({ x: 95, y: 45, width: 5, height: 5 });
    expect(mapBoxToSource({ x: 199, y: 99, width: 0, height: 0 }, doubled)).toEqual({ x: 99, y: 49, width: 1, height: 1 });
  });

  it('maps line and word boxes, reports the source size and leaves the text alone', () => {
    const result: OcrResult = {
      text: 'ab cd',
      confidence: 0.9,
      wordCount: 2,
      lines: ['ab cd'],
      lineBlocks: [
        {
          text: 'ab cd',
          bbox: { x: 20, y: 10, width: 100, height: 20 },
          words: [
            { text: 'ab', confidence: 91, bbox: { x: 20, y: 10, width: 40, height: 20 } },
            { text: 'cd', bbox: { x: 80, y: 10, width: 40, height: 20 } },
          ],
        },
      ],
      imageWidth: 200,
      imageHeight: 100,
    };
    const mapped = mapOcrResultToSource(result, doubled);
    expect(mapped.imageWidth).toBe(100);
    expect(mapped.imageHeight).toBe(50);
    expect(mapped.text).toBe('ab cd');
    expect(mapped.confidence).toBe(0.9);
    expect(mapped.lineBlocks?.[0].bbox).toEqual({ x: 10, y: 5, width: 50, height: 10 });
    expect(mapped.lineBlocks?.[0].words.map((w) => w.bbox)).toEqual([
      { x: 10, y: 5, width: 20, height: 10 },
      { x: 40, y: 5, width: 20, height: 10 },
    ]);
    expect(mapped.lineBlocks?.[0].words[0].confidence).toBe(91);
    // The input is not modified.
    expect(result.lineBlocks?.[0].bbox).toEqual({ x: 20, y: 10, width: 100, height: 20 });
  });

  describe('through the turned image', () => {
    const MARKER = { x: 100, y: 250, width: 40, height: 30 };
    const SOURCE = { width: 600, height: 400 };
    const MAX_CENTRE_ERROR_PX = 1.5;

    /** A page with one black marker, scaled and turned by sharp, and the marker's box in the result. */
    async function turnedMarker(scale: number, angleClockwise: number) {
      const raw = Buffer.alloc(SOURCE.width * SOURCE.height, 255);
      for (let y = MARKER.y; y < MARKER.y + MARKER.height; y++) {
        for (let x = MARKER.x; x < MARKER.x + MARKER.width; x++) raw[y * SOURCE.width + x] = 0;
      }
      const scaledWidth = Math.round(SOURCE.width * scale);
      const scaledHeight = Math.round(SOURCE.height * scale);
      const { data, info } = await sharp(raw, { raw: { width: SOURCE.width, height: SOURCE.height, channels: 1 } })
        .resize({ width: scaledWidth, height: scaledHeight, fit: 'fill' })
        .rotate(angleClockwise, { background: '#ffffff' })
        .toColourspace('b-w')
        .raw()
        .toBuffer({ resolveWithObject: true });
      let x0 = info.width;
      let y0 = info.height;
      let x1 = -1;
      let y1 = -1;
      for (let y = 0; y < info.height; y++) {
        for (let x = 0; x < info.width; x++) {
          if (data[y * info.width + x] >= 128) continue;
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x + 1);
          y1 = Math.max(y1, y + 1);
        }
      }
      return {
        box: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
        geometry: {
          sourceWidth: SOURCE.width,
          sourceHeight: SOURCE.height,
          scaledWidth,
          scaledHeight,
          outputWidth: info.width,
          outputHeight: info.height,
          rotationDegrees: angleClockwise,
        },
      };
    }

    for (const [scale, angle] of [
      [1, 3],
      [1, -4.5],
      [1, 9],
      [2, 3],
      [3.5, -7],
    ]) {
      it(`maps a marker back from scale ${scale} and a ${angle} degree clockwise turn`, async () => {
        const { box, geometry } = await turnedMarker(scale, angle);
        const mapped = mapBoxToSource(box, geometry);
        const centreX = mapped.x + mapped.width / 2;
        const centreY = mapped.y + mapped.height / 2;
        expect(Math.abs(centreX - (MARKER.x + MARKER.width / 2))).toBeLessThanOrEqual(MAX_CENTRE_ERROR_PX);
        expect(Math.abs(centreY - (MARKER.y + MARKER.height / 2))).toBeLessThanOrEqual(MAX_CENTRE_ERROR_PX);
        // The box of a turned box covers the marker.
        expect(mapped.x).toBeLessThanOrEqual(MARKER.x + 1);
        expect(mapped.y).toBeLessThanOrEqual(MARKER.y + 1);
        expect(mapped.x + mapped.width).toBeGreaterThanOrEqual(MARKER.x + MARKER.width - 1);
        expect(mapped.y + mapped.height).toBeGreaterThanOrEqual(MARKER.y + MARKER.height - 1);
      });
    }
  });

  it('is the identity when the image was not resized', () => {
    const box = { x: 3, y: 4, width: 5, height: 6 };
    expect(mapBoxToSource(box, identityGeometry(100, 50))).toEqual(box);
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
    expect(result.geometry).toEqual({
      sourceWidth: 2000,
      sourceHeight: 490,
      scaledWidth: 2000,
      scaledHeight: 490,
      outputWidth: 2000,
      outputHeight: 490,
      rotationDegrees: 0,
    });
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

  it('does not rescale a 300 dpi page whose lines are already tall enough', async () => {
    const result = await preprocessOcrImage(fixture('en_a__clean300'));
    expect(result.applied).toEqual({ rescale: false, deskew: false, binarize: true });
    expect(result.geometry.outputWidth).toBe(result.geometry.sourceWidth);
  });

  it('enlarges a 72 dpi page (about 10 px lines) until its lines are 30 to 40 px, then binarizes', async () => {
    const result = await preprocessOcrImage(fixture('en_a__dpi72'));
    expect(result.applied).toEqual({ rescale: true, deskew: false, binarize: true });
    expect(result.lineHeightPx).toBeGreaterThan(8);
    expect(result.lineHeightPx).toBeLessThan(13);
    const { sourceWidth, sourceHeight, outputWidth, outputHeight } = result.geometry;
    expect([sourceWidth, sourceHeight]).toEqual([480, 117]);
    expect(outputWidth / sourceWidth).toBeCloseTo(outputHeight / sourceHeight, 1);
    // Measure the prepared image itself, not the value the step used to decide.
    const { data, width, height } = await grayPixels(result.image);
    expect([width, height]).toEqual([outputWidth, outputHeight]);
    expect(new Set(data)).toEqual(new Set([SAUVOLA_INK, SAUVOLA_PAPER]));
    const outputLine = estimateLineHeight(new Uint8Array(data), width, height) as number;
    expect(outputLine).toBeGreaterThanOrEqual(MIN_LINE_HEIGHT_PX);
    expect(outputLine).toBeLessThanOrEqual(MAX_LINE_HEIGHT_PX);
  });

  it('enlarges without binarizing when only the rescale step is on', async () => {
    const result = await preprocessOcrImage(fixture('en_a__dpi72'), { rescale: true, deskew: false, binarize: false });
    expect(result.applied).toEqual({ rescale: true, deskew: false, binarize: false });
    const { data } = await grayPixels(result.image);
    expect(new Set(data).size).toBeGreaterThan(2);
  });

  it('straightens the page rendered with a 3 degree skew (the generator rotated it by 3)', async () => {
    const result = await preprocessOcrImage(fixture('en_a__skew3'));
    expect(result.applied.deskew).toBe(true);
    expect(Math.abs(result.geometry.rotationDegrees - 3)).toBeLessThanOrEqual(0.2);
    // The line height is measured along the text, not along the page: 5 lines of about 42 px.
    expect(result.lineHeightPx).toBeGreaterThan(36);
    expect(result.lineHeightPx).toBeLessThan(48);
    // The page grows to hold the turned image, and the source size is kept for mapping boxes back.
    expect([result.geometry.sourceWidth, result.geometry.sourceHeight]).toEqual([2024, 596]);
    expect(result.geometry.outputWidth).toBeGreaterThan(2024);
    expect(result.geometry.outputHeight).toBeGreaterThan(596);
  });

  it('does not turn a page whose text is already straight', async () => {
    const result = await preprocessOcrImage(fixture('en_a__clean300'));
    expect(result.applied.deskew).toBe(false);
    expect(result.geometry.rotationDegrees).toBe(0);
  });

  it('keeps a skewed page as it is when the deskew step is off', async () => {
    const result = await preprocessOcrImage(fixture('en_a__skew3'), { rescale: false, deskew: false, binarize: true });
    expect(result.applied.deskew).toBe(false);
    expect(result.geometry.rotationDegrees).toBe(0);
    expect([result.geometry.outputWidth, result.geometry.outputHeight]).toEqual([2024, 596]);
  });

  it('does not turn a page when the turned image would exceed the pixel budget', async () => {
    // 16000 x 2900 is 46 million pixels, inside the budget, but turned by 5 degrees it needs
    // about 16190 x 4283 = 69 million, which is not.
    const width = 16_000;
    const height = 2_900;
    const slope = Math.tan((5 * Math.PI) / 180);
    const page = new Uint8Array(width * height).fill(SAUVOLA_PAPER);
    for (let line = 0; line < 3; line++) {
      for (let x = 10; x < width - 10; x++) {
        if (x % 80 >= 60) continue;
        const top = 40 + line * 500 + Math.round(x * slope);
        for (let y = top; y < top + 100 && y < height; y++) page[y * width + x] = SAUVOLA_INK;
      }
    }
    const skewed = await sharp(Buffer.from(page), { raw: { width, height, channels: 1 } })
      .png({ compressionLevel: 1 })
      .toBuffer();
    expect(width * height).toBeLessThan(OCR_PREPROCESS_MAX_PIXELS);
    const result = await preprocessOcrImage(skewed, { rescale: false, deskew: true, binarize: false });
    expect(result.applied.deskew).toBe(false);
    expect(Math.abs(result.skewDegrees + 5)).toBeLessThanOrEqual(0.3);
    expect(result.geometry.rotationDegrees).toBe(0);
  }, 60_000);

  it('does not touch the page when every step is switched off', async () => {
    const source = fixture('en_a__shade');
    const result = await preprocessOcrImage(source, { rescale: false, deskew: false, binarize: false });
    expect(result.applied).toEqual({ rescale: false, deskew: false, binarize: false });
    const expected = await sharp(source).rotate().png().toBuffer();
    expect(result.image.equals(expected)).toBe(true);
  });

  it('rejects bytes that are not an image', async () => {
    await expect(preprocessOcrImage(Buffer.from('not an image'))).rejects.toThrow(/unsupported image format/);
  });
});
