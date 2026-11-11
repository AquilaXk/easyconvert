import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildLineBlock,
  cropLine,
  decodeCtc,
  extractTextBoxes,
  groupRows,
  minAreaBox,
  ONNX_OCR_MODEL_DIR_ENV,
  onnxOcrAvailable,
  planDetectorSize,
  recoverSpaces,
  setInColumns,
  releaseOnnxOcr,
  unclipBox,
  wordSpans,
  type OnnxRuntime,
  type RotatedBox,
} from '../src/lib/conversions/ocr-onnx';
import { recognizePageOnnx } from '../src/lib/conversions/ocr-onnx-input';
import { OcrEngineUnavailableError } from '../src/lib/types';

function rotatedRectPoints(cx: number, cy: number, width: number, height: number, angle: number): [number, number][] {
  const points: [number, number][] = [];
  for (let i = 0; i <= 20; i++) {
    for (const v of [-height / 2, height / 2]) {
      const u = -width / 2 + (width * i) / 20;
      points.push([cx + u * Math.cos(angle) - v * Math.sin(angle), cy + u * Math.sin(angle) + v * Math.cos(angle)]);
    }
  }
  return points;
}

/** A box of a text line of 42 pixel text (a box height of 46, as the detector's boxes measure on a page) whose text runs from `x0` to `x1`. */
function lineBox(x0: number, x1: number, y: number, angle = 0): RotatedBox {
  const height = 46;
  const width = x1 - x0 + 2 * 0.05 * height;
  const cx = (x0 + x1) / 2;
  return { cx: cx - y * Math.sin(angle), cy: y + cx * Math.sin(angle), width, height, angle, score: 0.9 };
}

describe('pages set in columns', () => {
  const rows = (count: number) => Array.from({ length: count }, (_, i) => 200 + i * 70);

  it('recognizes two columns of running text with a gutter between them', () => {
    const boxes = rows(10).flatMap((y) => [lineBox(140, 1150, y), lineBox(1240, 2340, y)]);
    expect(setInColumns(boxes, 2480)).toBe(true);
  });

  it('recognizes columns on a page turned by 3 degrees and with a title across them', () => {
    const angle = (3 * Math.PI) / 180;
    const boxes = [lineBox(140, 2340, 100, angle), ...rows(10).flatMap((y) => [lineBox(140, 1150, y, angle), lineBox(1240, 2340, y, angle)])];
    expect(setInColumns(boxes, 2480)).toBe(true);
  });

  it('does not take the cells of a table for columns', () => {
    const cells = rows(8).flatMap((y) => [lineBox(140, 330, y), lineBox(600, 1000, y), lineBox(1400, 1900, y), lineBox(2100, 2300, y)]);
    expect(setInColumns(cells, 2480)).toBe(false);
  });

  it('does not take one column of text, or a few lines, for columns', () => {
    expect(setInColumns(rows(14).map((y) => lineBox(140, 2340, y)), 2480)).toBe(false);
    expect(setInColumns(rows(3).flatMap((y) => [lineBox(140, 1150, y), lineBox(1240, 2340, y)]), 2480)).toBe(false);
  });

  it('needs a gutter, not just two columns that touch', () => {
    const touching = rows(10).flatMap((y) => [lineBox(140, 1190, y), lineBox(1200, 2340, y)]);
    expect(setInColumns(touching, 2480)).toBe(false);
  });
});

describe('ONNX OCR geometry', () => {
  it('scales the detector input into the side range and rounds each side to 32', () => {
    expect(planDetectorSize(2000, 1460)).toEqual({ width: 2016, height: 1472 });
    // a small scan is enlarged until its short side reaches the minimum
    expect(planDetectorSize(600, 400, 736, 2000)).toEqual({ width: 1120, height: 736 });
    // a large page is reduced to the long side maximum
    const big = planDetectorSize(6000, 4000, 736, 2000);
    expect(big.width).toBe(2016);
    expect(big.width % 32).toBe(0);
    expect(big.height % 32).toBe(0);
  });

  it('finds the smallest rectangle of a turned bar, with its length along x', () => {
    const angle = (3 * Math.PI) / 180;
    const box = minAreaBox(rotatedRectPoints(100, 50, 80, 10, angle));
    expect(box).not.toBeNull();
    expect(box!.width).toBeCloseTo(80, 0);
    expect(box!.height).toBeCloseTo(10, 0);
    expect(box!.angle).toBeCloseTo(angle, 2);
    expect(box!.cx).toBeCloseTo(100, 0);
    expect(box!.cy).toBeCloseTo(50, 0);
    // the same bar described the other way round comes back with the long side on x
    const tall = minAreaBox(rotatedRectPoints(0, 0, 10, 80, 0));
    expect(Math.abs(tall!.angle)).toBeLessThanOrEqual(Math.PI / 4 + 1e-9);
  });

  it('enlarges a rectangle by area * ratio / perimeter on every side', () => {
    const grown = unclipBox({ cx: 0, cy: 0, width: 100, height: 20, angle: 0 }, 1.5);
    const distance = (100 * 20 * 1.5) / (2 * 120);
    expect(grown.width).toBeCloseTo(100 + 2 * distance, 6);
    expect(grown.height).toBeCloseTo(20 + 2 * distance, 6);
  });

  it('keeps regions above the threshold with enough score and drops weak or tiny ones', () => {
    const width = 120;
    const height = 60;
    const map = new Float32Array(width * height);
    const paint = (x0: number, y0: number, x1: number, y1: number, value: number): void => {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) map[y * width + x] = value;
    };
    paint(10, 10, 100, 20, 0.9); // a text line
    paint(10, 35, 100, 45, 0.4); // above the binary threshold, below the score threshold
    paint(110, 50, 112, 52, 0.95); // a speck
    const boxes = extractTextBoxes(map, width, height);
    expect(boxes).toHaveLength(1);
    expect(boxes[0].width).toBeGreaterThan(90);
    expect(boxes[0].cy).toBeCloseTo(15, 0);
    expect(boxes[0].score).toBeGreaterThan(0.85);
  });

  it('straightens a turned line into a 48 pixel high strip', () => {
    const width = 200;
    const height = 120;
    const rgb = new Uint8Array(width * height * 3).fill(255);
    const angle = (5 * Math.PI) / 180;
    // a black bar along the rotated axis
    for (const [x, y] of rotatedRectPoints(100, 60, 120, 16, angle).concat(rotatedRectPoints(100, 60, 120, 12, angle))) {
      for (let c = 0; c < 3; c++) rgb[(Math.round(y) * width + Math.round(x)) * 3 + c] = 0;
    }
    const crop = cropLine(rgb, width, height, { cx: 100, cy: 60, width: 120, height: 16, angle });
    expect(crop.data.length).toBe(3 * 48 * crop.width);
    expect(crop.width).toBe(360);
    // every value stays in [-1, 1]
    expect(Math.min(...crop.data)).toBeGreaterThanOrEqual(-1);
    expect(Math.max(...crop.data)).toBeLessThanOrEqual(1);
  });
});

describe('ONNX OCR decoding', () => {
  const characters = ['가', '나', ' '];
  function distribution(classes: number, best: number[]): Float32Array {
    const out = new Float32Array(best.length * classes).fill(0.02);
    best.forEach((cls, t) => {
      out[t * classes + cls] = 0.94;
    });
    return out;
  }

  it('collapses repeats, drops blanks and averages the emitted probabilities', () => {
    const decoded = decodeCtc(distribution(4, [0, 1, 1, 0, 1, 2, 2, 0]), 0, 8, 4, characters);
    expect(decoded.text).toBe('가가나');
    expect(decoded.chars.map((c) => c.step)).toEqual([1, 4, 5]);
    expect(decoded.confidence).toBeCloseTo(0.94, 6);
    expect(decodeCtc(distribution(4, [0, 0, 0]), 0, 3, 4, characters)).toMatchObject({ text: '', confidence: 0 });
  });

  it('splits a decoded line into words at its spaces, each with a range inside the line', () => {
    const decoded = decodeCtc(distribution(4, [1, 0, 2, 0, 3, 0, 1, 0, 2, 0]), 0, 10, 4, characters);
    expect(decoded.text).toBe('가나 가나');
    const spans = wordSpans(decoded);
    expect(spans.map((s) => s.text)).toEqual(['가나', '가나']);
    expect(spans[0].start).toBeGreaterThanOrEqual(0);
    expect(spans[0].end).toBeLessThanOrEqual(spans[1].start + 0.2);
    expect(spans[1].end).toBeLessThanOrEqual(1);
  });

  it('keeps a gap between two words, also after a narrow character such as a full stop', () => {
    const at = (char: string, step: number) => ({ char, step, probability: 0.9 });
    // "다." then "북부": characters ten steps apart, and the first character of the second word 13 steps after the full stop
    const decoded = { text: '다. 북부', confidence: 0.9, steps: 40, chars: [at('다', 0), at('.', 10), at(' ', 16), at('북', 23), at('부', 33)] };
    const [first, second] = wordSpans(decoded);
    // Each word reaches 35% of 13 steps toward the other (4.55), not half a pitch (5): the gap is 3.9 steps, where half pitches left 3.
    expect((second.start - first.end) * 40).toBeCloseTo(23.5 - 4.55 - (10.5 + 4.55), 6);
    expect(first.end * 40).toBeCloseTo(10.5 + 4.55, 6);
  });

  it('builds a line block with word boxes on the line and a baseline along its lower edge', () => {
    const decoded = decodeCtc(distribution(4, [1, 0, 2, 0, 3, 0, 1, 0, 2, 0]), 0, 10, 4, characters);
    const box: RotatedBox = { cx: 200, cy: 100, width: 300, height: 40, angle: 0, score: 0.9 };
    const block = buildLineBlock(box, decoded, 1000, 500)!;
    expect(block.text).toBe('가나 가나');
    expect(block.words).toHaveLength(2);
    expect(block.bbox).toMatchObject({ x: 50, y: 80, width: 300, height: 40 });
    for (const word of block.words) {
      expect(word.bbox.x).toBeGreaterThanOrEqual(50);
      expect(word.bbox.x + word.bbox.width).toBeLessThanOrEqual(350);
      expect(word.bbox.y).toBe(80);
      expect(word.bbox.height).toBe(40);
    }
    expect(block.words[0].bbox.x).toBeLessThan(block.words[1].bbox.x);
    expect(block.baseline).toEqual({ x0: 50, y0: 120, x1: 350, y1: 120 });
    expect(buildLineBlock(box, { text: '', confidence: 0, chars: [], steps: 10 }, 1000, 500)).toBeNull();
  });

  it('joins the pieces of one row left to right and keeps separate rows apart', () => {
    const piece = (cx: number, cy: number): { box: RotatedBox } => ({ box: { cx, cy, width: 100, height: 30, angle: 0, score: 1 } });
    const rows = groupRows([piece(400, 102), piece(100, 100), piece(100, 200)]);
    expect(rows).toHaveLength(2);
    expect(rows[0].map((i) => i.box.cx)).toEqual([100, 400]);
    expect(groupRows([])).toEqual([]);
  });
});

describe('ONNX OCR space recovery', () => {
  const width = 300;
  /** A white strip with dark blocks (rows 10..38) at the given column ranges. */
  function strip(blocks: [number, number][]): Float32Array {
    const plane = 48 * width;
    const data = new Float32Array(3 * plane).fill(1);
    for (const [from, to] of blocks) {
      for (let c = 0; c < 3; c++) for (let y = 10; y < 38; y++) for (let x = from; x < to; x++) data[c * plane + y * width + x] = -1;
    }
    return data;
  }
  const blocks: [number, number][] = [[10, 40], [46, 76], [82, 112], [118, 148], [210, 240]];
  const emitted = (spaceBefore: number[]) => ({
    text: '가나다라마',
    confidence: 0.9,
    steps: 40,
    chars: [3, 8, 12, 17, 30].map((step, i) => ({ char: '가나다라마'[i], step, probability: 0.9, spaceBefore: spaceBefore[i] })),
  });

  it('puts a space at a wide ink-free gap the recognizer also gave some probability, and nowhere else', () => {
    expect(recoverSpaces(emitted([0.01, 0.01, 0.01, 0.01, 0.01]), strip(blocks), width).text).toBe('가나다라 마');
  });

  it('needs both: a wide gap alone, with no probability on a space, leaves the text as read', () => {
    expect(recoverSpaces(emitted([0, 0, 0, 0, 0]), strip(blocks), width).text).toBe('가나다라마');
  });

  it('keeps a gap that is no wider than the strip\'s ordinary spacing closed', () => {
    const even: [number, number][] = [[10, 40], [46, 76], [82, 112], [118, 148], [154, 184]];
    const line = { ...emitted([0, 0, 0, 0, 0]), chars: [3, 8, 12, 17, 22].map((step, i) => ({ char: '가나다라마'[i], step, probability: 0.9, spaceBefore: 0.01 })) };
    expect(recoverSpaces(line, strip(even), width).text).toBe('가나다라마');
  });

  it('trusts a space the recognizer put real probability on, even where the strip shows no gap', () => {
    const even: [number, number][] = [[10, 40], [46, 76], [82, 112], [118, 148], [154, 184]];
    const line = { ...emitted([0, 0, 0.4, 0, 0]), chars: [3, 8, 12, 17, 22].map((step, i) => ({ char: '가나다라마'[i], step, probability: 0.9, spaceBefore: i === 2 ? 0.4 : 0 })) };
    expect(recoverSpaces(line, strip(even), width).text).toBe('가나 다라마');
  });

  it('does not put a space beside one the recognizer already wrote', () => {
    const line = emitted([0.01, 0.01, 0.01, 0.01, 0.01]);
    line.chars.splice(4, 0, { char: ' ', step: 24, probability: 0.9, spaceBefore: 0 });
    expect(recoverSpaces({ ...line, text: '가나다라 마' }, strip(blocks), width).text).toBe('가나다라 마');
  });

  it('records the space probability the recognizer held back between two characters', () => {
    const classes = 4;
    const probabilities = new Float32Array(6 * classes).fill(0);
    const set = (t: number, k: number, v: number): void => {
      probabilities[t * classes + k] = v;
    };
    set(0, 1, 0.9);
    set(1, 0, 0.6);
    set(1, 3, 0.3);
    set(2, 0, 0.9);
    set(3, 2, 0.9);
    const decoded = decodeCtc(probabilities, 0, 4, classes, ['가', '나', ' ']);
    expect(decoded.text).toBe('가나');
    expect(decoded.chars[0].spaceBefore).toBe(0);
    expect(decoded.chars[1].spaceBefore).toBeCloseTo(0.3, 6);
  });
});

describe('ONNX OCR engine availability', () => {
  it('is refused with a typed error when no model directory or an incomplete one is given', async () => {
    const saved = process.env[ONNX_OCR_MODEL_DIR_ENV];
    delete process.env[ONNX_OCR_MODEL_DIR_ENV];
    try {
      const page = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#fff' } }).png().toBuffer();
      await expect(recognizePageOnnx(page)).rejects.toBeInstanceOf(OcrEngineUnavailableError);
      await expect(recognizePageOnnx(page, { modelDir: os.tmpdir() })).rejects.toThrow(/missing/);
      expect(await onnxOcrAvailable(undefined)).toBe(false);
    } finally {
      if (saved !== undefined) process.env[ONNX_OCR_MODEL_DIR_ENV] = saved;
    }
  });
});

describe('ONNX OCR pipeline with stand-in models', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-onnx-ocr-'));
    for (const name of ['det.onnx', 'rec.onnx']) fs.writeFileSync(path.join(dir, name), 'stand-in');
    fs.writeFileSync(path.join(dir, 'dict.txt'), '가\n나\n');
  });
  afterAll(async () => {
    await releaseOnnxOcr();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  class Tensor {
    constructor(
      readonly type: string,
      readonly data: Float32Array,
      readonly dims: number[]
    ) {}
  }
  const runtime: OnnxRuntime = {
    Tensor: Tensor as unknown as OnnxRuntime['Tensor'],
    InferenceSession: {
      async create(file: string) {
        const detector = path.basename(file) === 'det.onnx';
        return {
          inputNames: ['x'],
          async run(feeds: Record<string, { dims: readonly number[] }>) {
            const dims = feeds.x.dims;
            if (detector) {
              const [, , h, w] = dims;
              const map = new Float32Array(h * w);
              for (let y = 24; y < 40; y++) for (let x = 8; x < 100; x++) map[y * w + x] = 0.9;
              return { out: new Tensor('float32', map, [1, 1, h, w]) };
            }
            const [n, , , w] = dims;
            const steps = Math.ceil(w / 8);
            const classes = 4;
            const out = new Float32Array(n * steps * classes).fill(0.02);
            for (let b = 0; b < n; b++) {
              for (let t = 0; t < steps; t++) out[(b * steps + t) * classes] = 0.94;
              out[(b * steps + 3) * classes] = 0.02;
              out[(b * steps + 3) * classes + 1] = 0.94;
              out[(b * steps + 9) * classes] = 0.02;
              out[(b * steps + 9) * classes + 2] = 0.94;
            }
            return { out: new Tensor('float32', out, [n, steps, classes]) };
          },
        };
      },
    },
  };

  it('reads a page into one line block whose word boxes lie on the detected bar', async () => {
    const page = await sharp({ create: { width: 128, height: 64, channels: 3, background: '#fff' } }).png().toBuffer();
    const result = await recognizePageOnnx(page, { modelDir: dir, runtime, threads: 1, detectorMinSide: 32, detectorMaxSide: 128 });
    expect(result.text).toBe('가나');
    expect(result.lines).toEqual(['가나']);
    expect(result.wordCount).toBe(1);
    expect(result.imageWidth).toBe(128);
    expect(result.confidenceCalibrated).toBe(false);
    expect(result.confidence).toBeCloseTo(0.94, 6);
    const [line] = result.lineBlocks!;
    expect(line.words[0].bbox.y).toBeGreaterThanOrEqual(12);
    expect(line.words[0].bbox.y + line.words[0].bbox.height).toBeLessThanOrEqual(52);
    expect(line.words[0].bbox.x + line.words[0].bbox.width).toBeLessThanOrEqual(128);
  });

  it('stops before the first stage when the signal is already aborted', async () => {
    const page = await sharp({ create: { width: 128, height: 64, channels: 3, background: '#fff' } }).png().toBuffer();
    const controller = new AbortController();
    controller.abort(new Error('stopped'));
    await expect(recognizePageOnnx(page, { modelDir: dir, runtime, signal: controller.signal })).rejects.toThrow('stopped');
  });

  it('refuses bytes that are not an image', async () => {
    await expect(recognizePageOnnx(Buffer.from('not an image'), { modelDir: dir, runtime })).rejects.toThrow(/Invalid image/);
  });
});

// The real models are read by tests/ocr-onnx-real.test.ts, through the helper process.
