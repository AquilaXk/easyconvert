import { OcrPreprocessError } from '../types';
import { SAUVOLA_INK, yieldToEventLoop } from './ocr-sauvola';

/**
 * Measurements on a binarized page (one byte per pixel, SAUVOLA_INK for ink) that decide how the
 * page is prepared for recognition: the height of its text lines and the angle its lines run at.
 */

/** A row belongs to a text line when its ink count reaches this share of a typical text row. */
const ROW_INK_FRACTION = 0.04;
/** The typical text row is taken at this percentile of the non-empty row ink counts. */
const TYPICAL_ROW_PERCENTILE = 0.9;
/** Bands shorter than this are rules, specks or noise, not text lines. */
const MIN_LINE_HEIGHT_PX = 4;
/** Every row of a band needs at least this much ink however sparse the page is. */
const MIN_ROW_INK_PIXELS = 2;

/** Skew is searched within plus or minus this many degrees. */
export const OCR_DESKEW_MAX_DEGREES = 10;
/** The widest stage only looks for the neighbourhood of the angle, so it scores every n-th of the points. */
const COARSE_STAGE_POINT_STRIDE = 4;
/**
 * Coarse-to-fine search: each stage tries angles at `stepDegrees` over the whole range (first
 * stage) or within `spanDegrees` of the best angle so far, scoring every `pointStride`-th ink point.
 */
interface DeskewStage {
  stepDegrees: number;
  spanDegrees: number;
  pointStride: number;
}
const DESKEW_STAGES: readonly DeskewStage[] = [
  { stepDegrees: 0.5, spanDegrees: OCR_DESKEW_MAX_DEGREES, pointStride: COARSE_STAGE_POINT_STRIDE },
  { stepDegrees: 0.1, spanDegrees: 0.5, pointStride: 1 },
  { stepDegrees: 0.02, spanDegrees: 0.1, pointStride: 1 },
];
/**
 * Ink pixels used to score an angle; a denser page is thinned evenly to this many. The sharpness of a row profile
 * does not need every pixel of a stroke: on the golden skew pages the angle found from 40 000 points is the angle
 * found from 300 000, and every extra point costs one multiplication per candidate angle (73 of them).
 */
export const OCR_DESKEW_MAX_POINTS = 40_000;
/** Pixels scanned or points scored between hand-offs to the event loop. */
const SCAN_YIELD_PIXELS = 1 << 19;
/** Fewer ink pixels than this carry no line structure; the page is reported as straight. */
const DESKEW_MIN_POINTS = 50;
const DEGREES_TO_RADIANS = Math.PI / 180;
/** Candidate angles are rounded to 1e-4 degree so that repeated additions of a step do not drift. */
const DEGREE_PRECISION = 1e4;

function assertBinary(binary: Uint8Array, width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new OcrPreprocessError(`Invalid image size ${width}x${height} for text measurement.`);
  }
  if (binary.length !== width * height) {
    throw new OcrPreprocessError(
      `Binary buffer holds ${binary.length} bytes but a ${width}x${height} image needs ${width * height}.`
    );
  }
}

/** Ink pixels in every row: the horizontal projection profile. */
export function horizontalProjection(binary: Uint8Array, width: number, height: number): Uint32Array {
  assertBinary(binary, width, height);
  const profile = new Uint32Array(height);
  for (let y = 0; y < height; y++) {
    const base = y * width;
    let count = 0;
    for (let x = 0; x < width; x++) {
      if (binary[base + x] === SAUVOLA_INK) count++;
    }
    profile[y] = count;
  }
  return profile;
}

/**
 * Median height of the text lines, in pixels, from a horizontal projection profile: rows with
 * enough ink form bands, and each band is a line from the top of its tallest letter to the bottom
 * of its lowest one. Returns null when the profile holds no line.
 */
export function lineHeightFromProfile(profile: ArrayLike<number>): number | null {
  const occupied = Array.from(profile as ArrayLike<number>)
    .filter((count) => count > 0)
    .sort((a, b) => a - b);
  if (occupied.length === 0) return null;
  const typical = occupied[Math.min(occupied.length - 1, Math.floor(occupied.length * TYPICAL_ROW_PERCENTILE))];
  const threshold = Math.max(MIN_ROW_INK_PIXELS, typical * ROW_INK_FRACTION);

  const heights: number[] = [];
  let runStart = -1;
  for (let y = 0; y <= profile.length; y++) {
    const inked = y < profile.length && profile[y] >= threshold;
    if (inked && runStart < 0) runStart = y;
    if (!inked && runStart >= 0) {
      if (y - runStart >= MIN_LINE_HEIGHT_PX) heights.push(y - runStart);
      runStart = -1;
    }
  }
  if (heights.length === 0) return null;
  heights.sort((a, b) => a - b);
  const middle = heights.length >> 1;
  return heights.length % 2 === 1 ? heights[middle] : (heights[middle - 1] + heights[middle]) / 2;
}

/** Median text line height of a page whose lines run along its rows, or null when it holds none. */
export function estimateLineHeight(binary: Uint8Array, width: number, height: number): number | null {
  return lineHeightFromProfile(horizontalProjection(binary, width, height));
}

interface InkPoints {
  xs: Int32Array;
  ys: Int32Array;
  /** Points stored in `xs` and `ys`. */
  count: number;
  /** Distance from the page centre to a corner, which bounds a turned row coordinate. */
  radius: number;
}

/** Ink pixels kept so far while the page is read row by row. */
interface InkCollector {
  xs: Int32Array;
  ys: Int32Array;
  /** Points stored. */
  taken: number;
  /** Ink pixels passed. */
  seen: number;
  /**
   * Spacing minus one of the stored pixels: 0 (every pixel), then 1, 3, 7... each time the store fills up. The spacing is
   * a power of two, so a pixel is on it when none of these bits are set in its number.
   */
  spacingMask: number;
}

/** Keeps every second stored point and doubles the spacing, so the store always holds an even sample of the ink so far. */
function thinCollected(collector: InkCollector): void {
  const kept = (collector.taken + 1) >> 1;
  for (let i = 1; i < kept; i++) {
    collector.xs[i] = collector.xs[2 * i];
    collector.ys[i] = collector.ys[2 * i];
  }
  collector.taken = kept;
  collector.spacingMask = collector.spacingMask * 2 + 1;
}

/** Stores the ink pixels of row `y` that fall on the current spacing, relative to the page centre. */
function takeRowInk(binary: Uint8Array, y: number, width: number, centre: { x: number; y: number }, collector: InkCollector): void {
  const base = y * width;
  for (let x = 0; x < width; x++) {
    if (binary[base + x] !== SAUVOLA_INK) continue;
    if ((collector.seen & collector.spacingMask) === 0) {
      if (collector.taken === collector.xs.length) thinCollected(collector);
      // The spacing may have doubled just now; this pixel is only kept when it still falls on it.
      if ((collector.seen & collector.spacingMask) === 0) {
        collector.xs[collector.taken] = x - centre.x;
        collector.ys[collector.taken] = y - centre.y;
        collector.taken++;
      }
    }
    collector.seen++;
  }
}

/**
 * Centre-relative coordinates of the ink pixels, thinned evenly to at most OCR_DESKEW_MAX_POINTS in one pass over
 * the page. Rows are scanned in plain functions with a hand-off to the event loop every SCAN_YIELD_PIXELS.
 */
async function collectInk(binary: Uint8Array, width: number, height: number): Promise<InkPoints> {
  const rowsPerYield = Math.max(1, Math.floor(SCAN_YIELD_PIXELS / width));
  const collector: InkCollector = {
    xs: new Int32Array(OCR_DESKEW_MAX_POINTS),
    ys: new Int32Array(OCR_DESKEW_MAX_POINTS),
    taken: 0,
    seen: 0,
    spacingMask: 0,
  };
  const centre = { x: width >> 1, y: height >> 1 };
  for (let y = 0; y < height; y++) {
    takeRowInk(binary, y, width, centre, collector);
    if ((y + 1) % rowsPerYield === 0) await yieldToEventLoop();
  }
  return { xs: collector.xs, ys: collector.ys, count: collector.taken, radius: Math.ceil(Math.hypot(width, height) / 2) + 2 };
}

/**
 * Rows of ink after the page is turned by `degrees` clockwise-positive (the direction in which a
 * line sloping down to the right is levelled): counts per row go to `counts`, and the sum of their
 * squares is returned. Straight lines concentrate ink in few rows, which maximises the sum. Every
 * `stride`-th point is projected.
 */
function projectionScore(points: InkPoints, degrees: number, counts: Uint32Array, stride: number): number {
  const radians = degrees * DEGREES_TO_RADIANS;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const { xs, ys, radius, count } = points;
  counts.fill(0);
  for (let i = 0; i < count; i += stride) {
    counts[Math.round(ys[i] * cos + xs[i] * sin) + radius]++;
  }
  let score = 0;
  for (let i = 0; i < counts.length; i++) score += counts[i] * counts[i];
  return score;
}

export interface SkewEstimate {
  /**
   * Angle in degrees to turn the page clockwise to level its text lines: positive for text that
   * slopes up to the right. Within plus or minus OCR_DESKEW_MAX_DEGREES.
   */
  degrees: number;
  /** Projection score at `degrees` over the score at 0: 1 for straight text, larger when skewed. */
  improvement: number;
  /** Ink per row of the page after it is levelled by `degrees`; measure line heights on this. */
  profile: Uint32Array;
  /** Ink points the search scored: all of the page's ink up to OCR_DESKEW_MAX_POINTS, an even sample of it beyond. */
  points: number;
}

/** One stage of the search: the angle around `from` whose row profile is sharpest, scoring the stage's share of the points. */
async function searchStage(
  points: InkPoints,
  counts: Uint32Array,
  stage: DeskewStage,
  from: number,
  budget: { scoredSinceYield: number }
): Promise<number> {
  const steps = Math.round(stage.spanDegrees / stage.stepDegrees);
  let bestDegrees = from;
  // Scores of one stage are only comparable with each other: they sum the same points.
  let bestScore = projectionScore(points, from, counts, stage.pointStride);
  // The first stage covers the whole range around 0; later stages refine around the best so far.
  for (let k = -steps; k <= steps; k++) {
    const degrees = Math.round((from + k * stage.stepDegrees) * DEGREE_PRECISION) / DEGREE_PRECISION;
    if (Math.abs(degrees) > OCR_DESKEW_MAX_DEGREES || degrees === bestDegrees) continue;
    const score = projectionScore(points, degrees, counts, stage.pointStride);
    if (score > bestScore) {
      bestScore = score;
      bestDegrees = degrees;
    }
    budget.scoredSinceYield += points.count / stage.pointStride;
    if (budget.scoredSinceYield >= SCAN_YIELD_PIXELS) {
      budget.scoredSinceYield = 0;
      await yieldToEventLoop();
    }
  }
  return bestDegrees;
}

/**
 * Finds the skew of a binarized page by projection-profile variance: for each candidate angle the
 * ink pixels are projected onto rows, and the angle with the sharpest row profile levels the
 * text. The search is coarse to fine over plus or minus OCR_DESKEW_MAX_DEGREES and works on ink
 * coordinates, so it costs time in proportion to the (capped) ink, not the page area.
 */
export async function estimateSkew(binary: Uint8Array, width: number, height: number): Promise<SkewEstimate> {
  assertBinary(binary, width, height);
  const points = await collectInk(binary, width, height);
  const counts = new Uint32Array(2 * points.radius + 1);
  const baseline = projectionScore(points, 0, counts, 1);
  if (points.count < DESKEW_MIN_POINTS) {
    return { degrees: 0, improvement: 1, profile: counts.slice(), points: points.count };
  }

  let degrees = 0;
  const budget = { scoredSinceYield: 0 };
  for (const stage of DESKEW_STAGES) degrees = await searchStage(points, counts, stage, degrees, budget);
  const score = projectionScore(points, degrees, counts, 1);
  return { degrees, improvement: baseline > 0 ? score / baseline : 1, profile: counts, points: points.count };
}
