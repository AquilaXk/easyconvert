import fs from 'node:fs';
import path from 'node:path';
import { availableCpus } from '../workers/available-cpus';
import { OcrEngineUnavailableError } from '../types';
import { OCR_SMALL_CROP_MAX_HEIGHT_PX } from './ocr-config';
import { sortLineBlocksTopological, type OcrLineBlock, type OcrResult, type OcrWord } from './ocr-pdf-combiner';

/**
 * Optional text recognizer built from a text detector (DB, differentiable binarization) and a CTC line recognizer, both
 * ONNX models of the PP-OCR family, run with onnxruntime on the CPU. It is off by default: nothing selects it unless a
 * caller asks for `engine: 'onnx'`, and it needs two things the product image does not ship: the `onnxruntime-node`
 * package and a model directory (see `ONNX_OCR_MODEL_DIR_ENV`). Without either the call is refused with
 * OcrEngineUnavailableError and no other engine is tried, so a measurement never reports another engine's reading.
 *
 * The stages follow the reference implementation of the model family (PaddleOCR `tools/infer/predict_det.py`,
 * `predict_rec.py` and `ppocr/postprocess/db_postprocess.py`, Apache-2.0): ImageNet-normalized detector input with
 * sides rounded to 32, a 0.3 threshold on the probability map, rectangles of the connected regions enlarged by
 * area * 1.5 / perimeter, a mean-probability box score of 0.6, 48 pixel high recognizer input scaled to [-1, 1], and the
 * greedy CTC decode. Everything runs in this process on pure arrays; the geometry is written here because no
 * image-processing library with contours is installed.
 */

export const ONNX_OCR_MODEL_DIR_ENV = 'EASYCONVERT_OCR_ONNX_DIR';
export const ONNX_OCR_DETECTOR_FILE = 'det.onnx';
export const ONNX_OCR_RECOGNIZER_FILE = 'rec.onnx';
export const ONNX_OCR_DICTIONARY_FILE = 'dict.txt';

/** Detector input is scaled so that its short side is at least this (small scans are enlarged) ... */
export const ONNX_DETECTOR_MIN_SIDE = 736;
/** ... and its long side at most this (large scans are reduced); the larger the input, the slower the detector. */
export const ONNX_DETECTOR_MAX_SIDE = 2000;
const DETECTOR_STRIDE = 32;
const DETECTOR_MEAN = [0.485, 0.456, 0.406] as const;
const DETECTOR_STD = [0.229, 0.224, 0.225] as const;
export const DB_BINARY_THRESHOLD = 0.3;
export const DB_BOX_SCORE_THRESHOLD = 0.6;
export const DB_UNCLIP_RATIO = 1.5;
const DB_MIN_BOX_SIDE = 3;
const DB_MAX_BOXES = 2000;
export const RECOGNIZER_HEIGHT = 48;
const RECOGNIZER_MIN_WIDTH = 8;
const RECOGNIZER_MAX_WIDTH = 6400;
const RECOGNIZER_BATCH = 6;
const RECOGNIZER_TIME_PER_PIXEL = 8;
/** A column counts as ink when this many of its pixels are darker than the strip's own midpoint; a lone speckle is not ink. */
const GAP_INK_COLUMN_PIXELS = 2;
/** Ink is darker than this share of the way from the strip's paper level to its darkest level; light strokes still count. */
const GAP_INK_LEVEL = 0.35;
/** A gap between words is also at least this many times the median blank run of the strip (typefaces with wide syllable spacing). */
const GAP_MEDIAN_FACTOR = 2.4;
/** The recognizer's own space probability between two characters that settles a space by itself ... */
const SPACE_PROBABILITY = 0.1;
/** ... and the lower one that settles it when the strip also shows a gap there. */
const SPACE_PROBABILITY_WITH_GAP = 0.003;
/** A run of ink-free columns at least this share of the strip height wide is a gap between words. */
const GAP_MIN_HEIGHT_SHARE = 0.25;

/** The part of onnxruntime this module uses; the package is loaded by name so that its absence is a typed error. */
interface OrtTensor {
  readonly data: ArrayLike<number>;
  readonly dims: readonly number[];
}
interface OrtSession {
  readonly inputNames: readonly string[];
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
  release?(): Promise<void>;
}
export interface OnnxRuntime {
  InferenceSession: { create(file: string, options: Record<string, unknown>): Promise<OrtSession> };
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => OrtTensor;
}

const ONNX_RUNTIME_PACKAGE: string = 'onnxruntime-node';

export interface OnnxOcrOptions {
  /** Directory holding `det.onnx`, `rec.onnx` and `dict.txt`; defaults to the directory named by `EASYCONVERT_OCR_ONNX_DIR`. */
  modelDir?: string;
  /** The language the result is labelled with (`kor`, or `kor+eng` for a page that names both); the recognizer reads Hangul and Latin either way. */
  language?: string;
  /** Threads of one inference; defaults to the CPUs available to the process. */
  threads?: number;
  detectorMinSide?: number;
  detectorMaxSide?: number;
  /**
   * Whether to put a space where the strip has a gap between words that the recognizer did not mark (default true). The
   * model reads characters well but often drops the spaces of Korean text, which the strip's own column profile shows.
   */
  recoverSpaces?: boolean;
  /** An already loaded onnxruntime, for tests and measurements; otherwise the package is imported by name. */
  runtime?: OnnxRuntime;
  signal?: AbortSignal;
}

/** A rectangle at any angle: centre, length along its own x axis, length along its y axis, and that axis' angle (radians). */
export interface RotatedBox {
  cx: number;
  cy: number;
  width: number;
  height: number;
  angle: number;
  score: number;
}

export interface DecodedLine {
  text: string;
  /** Mean probability of the emitted characters, 0..1. */
  confidence: number;
  /** One entry per character: the time step it was emitted at, and its probability. */
  chars: { char: string; step: number; probability: number; spaceBefore?: number }[];
  steps: number;
}

// --- detector input ---------------------------------------------------------------------------------------------

/** Size of the detector input for a page: the page scaled into [minSide, maxSide], each side rounded to a multiple of 32. */
export function planDetectorSize(
  width: number,
  height: number,
  minSide: number = ONNX_DETECTOR_MIN_SIDE,
  maxSide: number = ONNX_DETECTOR_MAX_SIDE
): { width: number; height: number } {
  let ratio = 1;
  if (Math.min(width, height) < minSide) ratio = minSide / Math.min(width, height);
  if (Math.max(width, height) * ratio > maxSide) ratio = maxSide / Math.max(width, height);
  const round = (side: number): number => Math.max(DETECTOR_STRIDE, Math.round((side * ratio) / DETECTOR_STRIDE) * DETECTOR_STRIDE);
  return { width: round(width), height: round(height) };
}

function normalizedPlanes(rgb: Uint8Array, count: number, mean: readonly number[], std: readonly number[]): Float32Array {
  const out = new Float32Array(3 * count);
  for (let c = 0; c < 3; c++) {
    const scale = 1 / (255 * std[c]);
    const offset = mean[c] / std[c];
    const base = c * count;
    for (let i = 0; i < count; i++) out[base + i] = rgb[i * 3 + c] * scale - offset;
  }
  return out;
}

// --- DB post-processing -----------------------------------------------------------------------------------------

function convexHull(points: [number, number][]): [number, number][] {
  const sorted = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) return sorted;
  const cross = (o: [number, number], a: [number, number], b: [number, number]): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const build = (input: [number, number][]): [number, number][] => {
    const hull: [number, number][] = [];
    for (const p of input) {
      while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) hull.pop();
      hull.push(p);
    }
    hull.pop();
    return hull;
  };
  return [...build(sorted), ...build(sorted.slice().reverse())];
}

/**
 * The smallest rectangle around the points (one side lies along a hull edge), with its x axis turned into (-45, 45]
 * degrees so that a line of text has its length along x.
 */
export function minAreaBox(points: [number, number][]): Omit<RotatedBox, 'score'> | null {
  const hull = convexHull(points);
  if (hull.length < 3) return null;
  let best: { area: number; angle: number; minX: number; maxX: number; minY: number; maxY: number } | null = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [x, y] of hull) {
      const u = x * cos + y * sin;
      const v = -x * sin + y * cos;
      if (u < minX) minX = u;
      if (u > maxX) maxX = u;
      if (v < minY) minY = v;
      if (v > maxY) maxY = v;
    }
    const area = (maxX - minX) * (maxY - minY);
    if (!best || area < best.area) best = { area, angle, minX, maxX, minY, maxY };
  }
  if (!best) return null;
  let { angle } = best;
  let width = best.maxX - best.minX;
  let height = best.maxY - best.minY;
  const u = (best.minX + best.maxX) / 2;
  const v = (best.minY + best.maxY) / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const cx = u * cos - v * sin;
  const cy = u * sin + v * cos;
  while (angle > Math.PI / 4) {
    angle -= Math.PI / 2;
    [width, height] = [height, width];
  }
  while (angle <= -Math.PI / 4) {
    angle += Math.PI / 2;
    [width, height] = [height, width];
  }
  return { cx, cy, width, height, angle };
}

/** Grows a rectangle on every side by area * ratio / perimeter, which is how the reference enlarges a shrunk text region. */
export function unclipBox<T extends Omit<RotatedBox, 'score'>>(box: T, ratio: number = DB_UNCLIP_RATIO): T {
  const distance = (box.width * box.height * ratio) / (2 * (box.width + box.height));
  return { ...box, width: box.width + 2 * distance, height: box.height + 2 * distance };
}

function boxCorners(box: Omit<RotatedBox, 'score'>): [number, number][] {
  const cos = Math.cos(box.angle);
  const sin = Math.sin(box.angle);
  const hw = box.width / 2;
  const hh = box.height / 2;
  return [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map(([x, y]) => [box.cx + x * cos - y * sin, box.cy + x * sin + y * cos] as [number, number]);
}

/**
 * Text boxes of a detector probability map (`width` x `height`, row-major): connected regions above the threshold, kept
 * when their rectangle has sides of at least 3 pixels and a mean probability of at least the score threshold, then
 * enlarged. Boxes are in map pixels, in reading order of their rows.
 */
export function extractTextBoxes(
  map: ArrayLike<number>,
  width: number,
  height: number,
  options: { threshold?: number; scoreThreshold?: number; unclipRatio?: number } = {}
): RotatedBox[] {
  const threshold = options.threshold ?? DB_BINARY_THRESHOLD;
  const scoreThreshold = options.scoreThreshold ?? DB_BOX_SCORE_THRESHOLD;
  const size = width * height;
  const label = new Int32Array(size);
  const stack = new Int32Array(size);
  const boxes: RotatedBox[] = [];
  let next = 0;
  for (let start = 0; start < size; start++) {
    if (label[start] !== 0 || map[start] <= threshold) continue;
    next++;
    const boundary: [number, number][] = [];
    let top = 0;
    let sum = 0;
    let count = 0;
    stack[top++] = start;
    label[start] = next;
    while (top > 0) {
      const at = stack[--top];
      const x = at % width;
      const y = (at - x) / width;
      sum += map[at];
      count++;
      let edge = false;
      const visit = (nx: number, ny: number): void => {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
          edge = true;
          return;
        }
        const to = ny * width + nx;
        if (map[to] <= threshold) {
          edge = true;
          return;
        }
        if (label[to] === 0) {
          label[to] = next;
          stack[top++] = to;
        }
      };
      visit(x - 1, y);
      visit(x + 1, y);
      visit(x, y - 1);
      visit(x, y + 1);
      if (edge) boundary.push([x + 0.5, y + 0.5]);
    }
    if (count < DB_MIN_BOX_SIDE * DB_MIN_BOX_SIDE) continue;
    const tight = minAreaBox(boundary);
    if (!tight || Math.min(tight.width, tight.height) < DB_MIN_BOX_SIDE) continue;
    // The score is the mean probability inside the rectangle, as the reference's box_score_fast.
    const score = meanInside(map, width, height, tight);
    if (score < scoreThreshold) continue;
    boxes.push({ ...unclipBox(tight, options.unclipRatio), score });
    if (boxes.length >= DB_MAX_BOXES) break;
  }
  return boxes;
}

function meanInside(map: ArrayLike<number>, width: number, height: number, box: Omit<RotatedBox, 'score'>): number {
  const corners = boxCorners(box);
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const x1 = Math.min(width - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(height - 1, Math.ceil(Math.max(...ys)));
  const cos = Math.cos(box.angle);
  const sin = Math.sin(box.angle);
  let sum = 0;
  let count = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - box.cx;
      const dy = y + 0.5 - box.cy;
      const u = dx * cos + dy * sin;
      const v = -dx * sin + dy * cos;
      if (Math.abs(u) <= box.width / 2 && Math.abs(v) <= box.height / 2) {
        sum += map[y * width + x];
        count++;
      }
    }
  }
  return count === 0 ? 0 : sum / count;
}

// --- recognizer input and CTC decode ----------------------------------------------------------------------------

/**
 * The text line under a rotated box, straightened and scaled to RECOGNIZER_HEIGHT, as planar floats in [-1, 1]
 * (bilinear sampling). `width` is the sampled width; a box whose length would be beyond the model's range is squeezed.
 */
export function cropLine(
  rgb: Uint8Array,
  imageWidth: number,
  imageHeight: number,
  box: Omit<RotatedBox, 'score'>
): { data: Float32Array; width: number } {
  const width = Math.min(RECOGNIZER_MAX_WIDTH, Math.max(RECOGNIZER_MIN_WIDTH, Math.ceil((RECOGNIZER_HEIGHT * box.width) / box.height)));
  const plane = RECOGNIZER_HEIGHT * width;
  const data = new Float32Array(3 * plane);
  const cos = Math.cos(box.angle);
  const sin = Math.sin(box.angle);
  for (let v = 0; v < RECOGNIZER_HEIGHT; v++) {
    const ly = ((v + 0.5) / RECOGNIZER_HEIGHT - 0.5) * box.height;
    for (let u = 0; u < width; u++) {
      const lx = ((u + 0.5) / width - 0.5) * box.width;
      const sx = Math.min(imageWidth - 1, Math.max(0, box.cx + lx * cos - ly * sin - 0.5));
      const sy = Math.min(imageHeight - 1, Math.max(0, box.cy + lx * sin + ly * cos - 0.5));
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(imageWidth - 1, x0 + 1);
      const y1 = Math.min(imageHeight - 1, y0 + 1);
      const fx = sx - x0;
      const fy = sy - y0;
      for (let c = 0; c < 3; c++) {
        const top = rgb[(y0 * imageWidth + x0) * 3 + c] * (1 - fx) + rgb[(y0 * imageWidth + x1) * 3 + c] * fx;
        const bottom = rgb[(y1 * imageWidth + x0) * 3 + c] * (1 - fx) + rgb[(y1 * imageWidth + x1) * 3 + c] * fx;
        data[c * plane + v * width + u] = ((top * (1 - fy) + bottom * fy) / 255 - 0.5) / 0.5;
      }
    }
  }
  return { data, width };
}

/** Greedy CTC decoding of one line's `steps` x `classes` probabilities; class 0 is the blank, `characters[i - 1]` is class i. */
export function decodeCtc(
  probabilities: ArrayLike<number>,
  offset: number,
  steps: number,
  classes: number,
  characters: readonly string[]
): DecodedLine {
  const chars: DecodedLine['chars'] = [];
  const spaceClass = characters.lastIndexOf(' ') + 1;
  let previous = 0;
  let space = 0;
  for (let t = 0; t < steps; t++) {
    const row = offset + t * classes;
    let best = 0;
    let bestValue = -Infinity;
    for (let k = 0; k < classes; k++) {
      if (probabilities[row + k] > bestValue) {
        bestValue = probabilities[row + k];
        best = k;
      }
    }
    if (best !== 0 && best !== previous) {
      chars.push({ char: characters[best - 1] ?? '', step: t, probability: bestValue, spaceBefore: space });
      space = 0;
    } else if (spaceClass > 0 && best !== spaceClass) {
      space = Math.max(space, probabilities[row + spaceClass]);
    }
    previous = best;
  }
  const confidence = chars.length === 0 ? 0 : chars.reduce((sum, c) => sum + c.probability, 0) / chars.length;
  return { text: chars.map((c) => c.char).join(''), confidence, chars, steps };
}

/**
 * Inserts a space between two characters when the recognizer put a tenth of its probability on a space between them, or
 * a thirtieth of that and the strip also has an ink-free gap there (at least a quarter of the strip height and 2.4 times
 * the strip's median blank run, since a typeface that spaces its syllables widely has wide gaps inside words too).
 * `strip` is the planar strip `cropLine` made; a column is ink when two of its pixels are, so a lone speckle does not
 * close a gap. The two levels were chosen on the measurement set (see the policy entry), not on the test pages.
 */
export function recoverSpaces(line: DecodedLine, strip: Float32Array, width: number): DecodedLine {
  if (line.chars.length < 2) return line;
  const plane = RECOGNIZER_HEIGHT * width;
  const grey = new Float32Array(plane);
  let low = Infinity;
  let high = -Infinity;
  for (let i = 0; i < plane; i++) {
    grey[i] = (strip[i] + strip[plane + i] + strip[2 * plane + i]) / 3;
    if (grey[i] < low) low = grey[i];
    if (grey[i] > high) high = grey[i];
  }
  const midpoint = high - GAP_INK_LEVEL * (high - low);
  const ink: boolean[] = [];
  for (let x = 0; x < width; x++) {
    let dark = 0;
    for (let y = 0; y < RECOGNIZER_HEIGHT; y++) if (grey[y * width + x] < midpoint) dark++;
    ink.push(dark >= GAP_INK_COLUMN_PIXELS);
  }
  const runs: { start: number; end: number }[] = [];
  for (let x = 0, start = -1; x <= width; x++) {
    const blank = x < width && !ink[x];
    if (blank && start < 0) start = x;
    if (!blank && start >= 0) {
      if (start > 0 && x < width) runs.push({ start, end: x });
      start = -1;
    }
  }
  if (runs.length === 0) return line;
  const widths = runs.map((r) => r.end - r.start).sort((a, b) => a - b);
  const minGap = Math.max(GAP_MIN_HEIGHT_SHARE * RECOGNIZER_HEIGHT, GAP_MEDIAN_FACTOR * widths[widths.length >> 1]);
  const gaps = runs.filter((r) => r.end - r.start >= minGap).map((r) => (r.start + r.end) / 2);
  const centre = (step: number): number => ((step + 0.5) / line.steps) * width;
  const chars: DecodedLine['chars'] = [];
  let g = 0;
  for (let i = 0; i < line.chars.length; i++) {
    chars.push(line.chars[i]);
    const next = line.chars[i + 1];
    if (!next) break;
    while (g < gaps.length && gaps[g] <= centre(line.chars[i].step)) g++;
    const inside = g < gaps.length && gaps[g] < centre(next.step);
    const heard = next.spaceBefore ?? 0;
    if ((heard >= SPACE_PROBABILITY || (inside && heard >= SPACE_PROBABILITY_WITH_GAP)) && line.chars[i].char !== ' ' && next.char !== ' ') {
      chars.push({ char: ' ', step: Math.round((line.chars[i].step + next.step) / 2), probability: Math.min(line.chars[i].probability, next.probability) });
    }
  }
  return { ...line, text: chars.map((c) => c.char).join(''), chars };
}

/** How far a word's box may reach toward the next word, as a share of the distance between the two characters on either side of the space. */
const WORD_REACH_SHARE = 0.35;

/**
 * Words of a decoded line as ranges along the line's length (0..1). A character is emitted at one time step near its
 * centre, so a word spans from half a character pitch before its first character to half a pitch after its last one,
 * except toward a neighbouring word: there it reaches only 35% of the way to that word's nearest character, so the space
 * between two words stays a gap in the boxes (a full half pitch after a full stop, which is narrow, would close it, and a
 * text extractor then joins the two words in the searchable PDF).
 */
export function wordSpans(line: DecodedLine): { text: string; start: number; end: number; confidence: number }[] {
  const pitches: number[] = [];
  for (let i = 1; i < line.chars.length; i++) {
    if (line.chars[i].char !== ' ' && line.chars[i - 1].char !== ' ') pitches.push(line.chars[i].step - line.chars[i - 1].step);
  }
  pitches.sort((a, b) => a - b);
  const pitch = pitches.length > 0 ? pitches[pitches.length >> 1] : Math.max(1, Math.min(line.steps, RECOGNIZER_HEIGHT / RECOGNIZER_TIME_PER_PIXEL));
  const groups: DecodedLine['chars'][] = [];
  let current: DecodedLine['chars'] = [];
  for (const c of line.chars) {
    if (/^\s*$/.test(c.char)) {
      if (current.length > 0) groups.push(current);
      current = [];
    } else current.push(c);
  }
  if (current.length > 0) groups.push(current);
  return groups.map((group, index) => {
    const first = group[0];
    const last = group[group.length - 1];
    const before = index > 0 ? first.step - groups[index - 1][groups[index - 1].length - 1].step : Infinity;
    const after = index < groups.length - 1 ? groups[index + 1][0].step - last.step : Infinity;
    return {
      text: group.map((c) => c.char).join(''),
      start: Math.max(0, first.step + 0.5 - Math.min(pitch / 2, WORD_REACH_SHARE * before)) / line.steps,
      end: Math.min(line.steps, last.step + 0.5 + Math.min(pitch / 2, WORD_REACH_SHARE * after)) / line.steps,
      confidence: group.reduce((sum, c) => sum + c.probability, 0) / group.length,
    };
  });
}

// --- result -----------------------------------------------------------------------------------------------------

function pointAlong(box: Omit<RotatedBox, 'score'>, along: number, across: number): [number, number] {
  const cos = Math.cos(box.angle);
  const sin = Math.sin(box.angle);
  const lx = (along - 0.5) * box.width;
  const ly = across * box.height;
  return [box.cx + lx * cos - ly * sin, box.cy + lx * sin + ly * cos];
}

function enclosing(points: [number, number][]): { x: number; y: number; width: number; height: number } {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Builds the line block of one recognized box: words with their own boxes, the baseline along the box's lower edge. */
export function buildLineBlock(box: RotatedBox, line: DecodedLine, imageWidth: number, imageHeight: number): OcrLineBlock | null {
  const spans = wordSpans(line).filter((w) => w.text.length > 0);
  if (spans.length === 0) return null;
  const clampBox = (b: { x: number; y: number; width: number; height: number }) => {
    const x = Math.max(0, Math.min(imageWidth, b.x));
    const y = Math.max(0, Math.min(imageHeight, b.y));
    return { x, y, width: Math.max(1, Math.min(imageWidth, b.x + b.width) - x), height: Math.max(1, Math.min(imageHeight, b.y + b.height) - y) };
  };
  const words: OcrWord[] = spans.map((span) => ({
    text: span.text,
    confidence: span.confidence,
    bbox: clampBox(
      enclosing([
        pointAlong(box, span.start, -0.5),
        pointAlong(box, span.end, -0.5),
        pointAlong(box, span.end, 0.5),
        pointAlong(box, span.start, 0.5),
      ])
    ),
  }));
  const [x0, y0] = pointAlong(box, 0, 0.5);
  const [x1, y1] = pointAlong(box, 1, 0.5);
  const lineBox = clampBox(enclosing(boxCorners(box)));
  const block: OcrLineBlock = {
    text: words.map((w) => w.text).join(' '),
    bbox: lineBox,
    words,
    baseline: { x0, y0, x1, y1 },
    rowHeight: box.height,
  };
  const degrees = (box.angle * 180) / Math.PI;
  if (Math.abs(degrees) > 0.05) block.angleDegrees = degrees;
  return block;
}

/** Joins boxes that lie on one row (a line the detector cut at a wide gap) so the row is read as one line. */
export function groupRows<T extends { box: RotatedBox }>(items: T[]): T[][] {
  if (items.length === 0) return [];
  const angles = items.map((i) => i.box.angle).sort((a, b) => a - b);
  const tilt = angles[angles.length >> 1];
  const cos = Math.cos(tilt);
  const sin = Math.sin(tilt);
  const along = (i: T): number => i.box.cx * cos + i.box.cy * sin;
  const across = (i: T): number => -i.box.cx * sin + i.box.cy * cos;
  const sorted = items.slice().sort((a, b) => across(a) - across(b));
  const rows: T[][] = [];
  for (const item of sorted) {
    const row = rows.find((r) => Math.abs(across(r[0]) - across(item)) < 0.5 * Math.min(r[0].box.height, item.box.height));
    if (row) row.push(item);
    else rows.push([item]);
  }
  return rows.map((r) => r.sort((a, b) => along(a) - along(b)));
}

/**
 * The detector's boxes are the text region enlarged by the reference's unclip rule, which lands a box at about one text height (a 13 point
 * line at 300 dpi, 54 pixels, gives a box of 57; measured on the golden page), with a margin of a twentieth of its height on each side.
 */
const BOX_HEIGHTS_PER_TEXT_HEIGHT = 1.05;
const BOX_MARGIN_SHARE = 0.05;
/** A line this many text heights long (about as many syllables) is a line of running text; the cells of a table and labels are shorter. */
const PROSE_LINE_EMS = 14;
/** Fewest lines of running text on each side of a gutter for the page to count as set in columns. */
const COLUMN_MIN_LINES = 4;
/** A gutter is at least this many text heights wide, and this share of the page width. */
const GUTTER_MIN_EMS = 1.2;
const GUTTER_MIN_PAGE_SHARE = 0.015;
/** A line as wide as this share of the text is a title or a rule across the columns, not a line of one of them. */
const SPANNING_SHARE = 0.72;

/**
 * Whether the page is running text set in columns: its long lines (fourteen text heights or more, so not the cells of a table) leave a
 * gutter between them, with at least four on each side. The boxes of such a page are not joined along a row: a line of the left column
 * and the line of the right column beside it are two lines, read one column after the other, where the cells of a table are one row.
 * Lines wider than 72% of the text (titles) do not count against the gutter, and the gutter is measured along the lines' own direction.
 */
export function setInColumns(boxes: RotatedBox[], pageWidth: number): boolean {
  if (boxes.length < 2 * COLUMN_MIN_LINES) return false;
  const tilt = boxes.map((b) => b.angle).sort((a, b) => a - b)[boxes.length >> 1];
  const cos = Math.cos(tilt);
  const sin = Math.sin(tilt);
  const heights = boxes.map((b) => b.height).sort((a, b) => a - b);
  const em = heights[heights.length >> 1] / BOX_HEIGHTS_PER_TEXT_HEIGHT;
  const text = (b: RotatedBox): number => b.width - 2 * BOX_MARGIN_SHARE * b.height;
  const long = boxes.filter((b) => text(b) >= PROSE_LINE_EMS * em);
  if (long.length < 2 * COLUMN_MIN_LINES || long.length < 0.6 * boxes.length) return false;
  const spans = long.map((b) => {
    const centre = b.cx * cos + b.cy * sin;
    return { start: centre - text(b) / 2, end: centre + text(b) / 2 };
  });
  const textWidth = Math.max(...spans.map((r) => r.end)) - Math.min(...spans.map((r) => r.start));
  const lines = spans.filter((r) => r.end - r.start < SPANNING_SHARE * textWidth).sort((a, b) => a.start - b.start);
  const minGap = Math.max(GUTTER_MIN_EMS * em, GUTTER_MIN_PAGE_SHARE * pageWidth);
  let reach = -Infinity;
  let left = 0;
  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && lines[i].start - reach >= minGap) {
      if (left >= COLUMN_MIN_LINES && lines.length - i >= COLUMN_MIN_LINES) return true;
      left = 0;
    }
    reach = Math.max(reach, lines[i].end);
    left++;
  }
  return false;
}

// --- engine -----------------------------------------------------------------------------------------------------

interface LoadedModels {
  ort: OnnxRuntime;
  detector: OrtSession;
  recognizer: OrtSession;
  characters: string[];
  key: string;
}

let loaded: Promise<LoadedModels> | null = null;

async function loadModels(modelDir: string, threads: number, runtime?: OnnxRuntime): Promise<LoadedModels> {
  const key = `${modelDir}|${threads}`;
  if (loaded) {
    const current = await loaded;
    if (current.key === key) return current;
    await releaseOnnxOcr();
  }
  const files = [ONNX_OCR_DETECTOR_FILE, ONNX_OCR_RECOGNIZER_FILE, ONNX_OCR_DICTIONARY_FILE].map((name) => path.join(modelDir, name));
  for (const file of files) {
    if (!fs.existsSync(file)) throw new OcrEngineUnavailableError(`The ONNX OCR model file '${path.basename(file)}' is missing from '${modelDir}'.`);
  }
  let ort: OnnxRuntime;
  try {
    ort = runtime ?? ((await import(/* webpackIgnore: true */ ONNX_RUNTIME_PACKAGE)) as OnnxRuntime);
  } catch {
    throw new OcrEngineUnavailableError(`The ONNX OCR engine needs the '${ONNX_RUNTIME_PACKAGE}' package, which is not installed.`);
  }
  // The arena and the memory pattern are off: a page changes the detector's input shape, so a pattern is never reused, and the
  // arena kept the peak of one page (about 1.45 GB against 0.9 GB for a 2000 x 1460 page on the measurement set).
  const options = { executionProviders: ['cpu'], intraOpNumThreads: threads, interOpNumThreads: 1, graphOptimizationLevel: 'all', enableCpuMemArena: false, enableMemPattern: false };
  const promise = (async (): Promise<LoadedModels> => {
    const [detector, recognizer] = await Promise.all([
      ort.InferenceSession.create(files[0], options),
      ort.InferenceSession.create(files[1], options),
    ]);
    const dictionary = fs.readFileSync(files[2], 'utf8').split('\n');
    if (dictionary[dictionary.length - 1] === '') dictionary.pop();
    // The recognizer's last class is the space the reference appends to the dictionary.
    return { ort, detector, recognizer, characters: [...dictionary, ' '], key };
  })();
  loaded = promise;
  try {
    return await promise;
  } catch (err) {
    loaded = null;
    throw new OcrEngineUnavailableError(`The ONNX OCR models could not be loaded: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Releases the sessions; the next call loads them again. */
export async function releaseOnnxOcr(): Promise<void> {
  const current = loaded;
  loaded = null;
  if (!current) return;
  try {
    const { detector, recognizer } = await current;
    await Promise.all([detector.release?.(), recognizer.release?.()]);
  } catch {
    // a load that failed holds nothing to release
  }
}

/** Loads the sessions now (the helper does this before it says it is ready) with the thread count the pages will be read with. */
export async function warmOnnxOcr(modelDir: string, threads: number, runtime?: OnnxRuntime): Promise<void> {
  await loadModels(modelDir, threads, runtime);
}

/** Whether the engine could run here: the package resolves and the model directory is complete. */
export async function onnxOcrAvailable(modelDir: string | undefined = process.env[ONNX_OCR_MODEL_DIR_ENV]): Promise<boolean> {
  if (!modelDir) return false;
  try {
    await loadModels(modelDir, 1);
    return true;
  } catch {
    return false;
  }
}

/** A page as the recognizer reads it: the pixels at full size, for the line crops, and a copy scaled to the detector's size. */
export interface OnnxPageInput {
  width: number;
  height: number;
  /** Packed RGB, `width * height * 3` bytes. */
  rgb: Uint8Array;
  detector: { width: number; height: number; rgb: Uint8Array };
}

/** Recognizes a page that `prepareOnnxInput` (ocr-onnx-input.ts) made; this is what the helper process runs. */
export async function recognizeOnnxInput(input: OnnxPageInput, options: OnnxOcrOptions = {}): Promise<OcrResult> {
  const modelDir = options.modelDir ?? process.env[ONNX_OCR_MODEL_DIR_ENV];
  if (!modelDir) throw new OcrEngineUnavailableError(`The ONNX OCR engine needs a model directory (${ONNX_OCR_MODEL_DIR_ENV}).`);
  const { signal } = options;
  const { rgb, width, height } = input;
  const models = await loadModels(modelDir, options.threads ?? availableCpus(), options.runtime);
  const { ort } = models;

  // Detector: the page scaled to the detector's size, then one probability map of the same size.
  const plan = input.detector;
  const tensor = new ort.Tensor('float32', normalizedPlanes(input.detector.rgb, plan.width * plan.height, DETECTOR_MEAN, DETECTOR_STD), [1, 3, plan.height, plan.width]);
  signal?.throwIfAborted();
  const detection = await models.detector.run({ [models.detector.inputNames[0]]: tensor });
  const map = Object.values(detection)[0].data;
  const scaleX = width / plan.width;
  const scaleY = height / plan.height;
  let boxes = extractTextBoxes(map, plan.width, plan.height).map((box) => scaleBox(box, scaleX, scaleY));
  // A label or a cropped line (the same images that Tesseract reads as one block) is enlarged by the detector's minimum size until it is a
  // blur that finds no text: when nothing is found in such an image, the whole image is the line, which is how the recogniser is used on a crop.
  if (boxes.length === 0 && height <= OCR_SMALL_CROP_MAX_HEIGHT_PX && width >= height) {
    boxes = [{ cx: width / 2, cy: height / 2, width, height, angle: 0, score: 1 }];
  }

  // Recognizer: lines grouped by width so that a batch pads little.
  const crops = boxes.map((box) => ({ box, ...cropLine(rgb, width, height, box) }));
  const order = crops.map((_, i) => i).sort((a, b) => crops[a].width - crops[b].width);
  const lines = new Map<number, DecodedLine>();
  for (let start = 0; start < order.length; start += RECOGNIZER_BATCH) {
    signal?.throwIfAborted();
    const batch = order.slice(start, start + RECOGNIZER_BATCH);
    const batchWidth = Math.max(...batch.map((i) => crops[i].width));
    const plane = RECOGNIZER_HEIGHT * batchWidth;
    const data = new Float32Array(batch.length * 3 * plane);
    batch.forEach((index, slot) => {
      const crop = crops[index];
      for (let c = 0; c < 3; c++) {
        for (let v = 0; v < RECOGNIZER_HEIGHT; v++) {
          data.set(crop.data.subarray(c * RECOGNIZER_HEIGHT * crop.width + v * crop.width, c * RECOGNIZER_HEIGHT * crop.width + (v + 1) * crop.width), slot * 3 * plane + c * plane + v * batchWidth);
        }
      }
    });
    const output = await models.recognizer.run({
      [models.recognizer.inputNames[0]]: new ort.Tensor('float32', data, [batch.length, 3, RECOGNIZER_HEIGHT, batchWidth]),
    });
    const logits = Object.values(output)[0];
    const [, steps, classes] = logits.dims;
    batch.forEach((index, slot) => {
      // Only the steps of the line's own width are read; the zero padding after it would decode to blanks anyway.
      const own = Math.max(1, Math.min(steps, Math.ceil((crops[index].width / batchWidth) * steps)));
      const decoded = decodeCtc(logits.data, slot * steps * classes, own, classes, models.characters);
      lines.set(index, options.recoverSpaces === false ? decoded : recoverSpaces(decoded, crops[index].data, crops[index].width));
    });
  }

  const items = boxes.map((box, index) => ({ box, index }));
  const lineBlocks: OcrLineBlock[] = [];
  // A page set in columns keeps every box a line of its own; the order of the columns is settled by sortLineBlocksTopological below.
  const rows = setInColumns(boxes, width) ? items.map((item) => [item]) : groupRows(items);
  for (const row of rows) {
    const parts = row
      .map((item) => buildLineBlock(item.box, lines.get(item.index) as DecodedLine, width, height))
      .filter((block): block is OcrLineBlock => block !== null);
    if (parts.length === 0) continue;
    lineBlocks.push(
      parts.length === 1
        ? parts[0]
        : {
            ...parts[0],
            text: parts.map((p) => p.text).join(' '),
            words: parts.flatMap((p) => p.words),
            bbox: unionBox(parts.map((p) => p.bbox)),
            baseline: { ...(parts[0].baseline as NonNullable<OcrLineBlock['baseline']>), x1: (parts[parts.length - 1].baseline as NonNullable<OcrLineBlock['baseline']>).x1, y1: (parts[parts.length - 1].baseline as NonNullable<OcrLineBlock['baseline']>).y1 },
          }
    );
  }
  const ordered = sortLineBlocksTopological(lineBlocks, width, height);
  const words = ordered.flatMap((b) => b.words);
  const characters = words.reduce((sum, w) => sum + w.text.length, 0);
  const confidence = characters === 0 ? null : words.reduce((sum, w) => sum + (w.confidence ?? 0) * w.text.length, 0) / characters;
  return {
    text: ordered.map((b) => b.text).join('\n'),
    confidence,
    confidenceCalibrated: false,
    wordCount: words.length,
    lines: ordered.map((b) => b.text),
    lineBlocks: ordered,
    imageWidth: width,
    imageHeight: height,
    language: options.language ?? 'kor',
  };
}

function scaleBox(box: RotatedBox, sx: number, sy: number): RotatedBox {
  // The map is stretched by (sx, sy), which differ by a rounding only; the rectangle's axes keep the page's own aspect.
  const s = (sx + sy) / 2;
  return { ...box, cx: box.cx * sx, cy: box.cy * sy, width: box.width * s, height: box.height * s };
}

function unionBox(boxes: { x: number; y: number; width: number; height: number }[]): { x: number; y: number; width: number; height: number } {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, width: Math.max(...boxes.map((b) => b.x + b.width)) - x, height: Math.max(...boxes.map((b) => b.y + b.height)) - y };
}
