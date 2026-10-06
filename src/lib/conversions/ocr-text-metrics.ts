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
/**
 * Coarse-to-fine search: each stage tries angles at `stepDegrees` over the whole range (first
 * stage) or within `spanDegrees` of the best angle so far.
 */
const DESKEW_STAGES: ReadonlyArray<{ stepDegrees: number; spanDegrees: number }> = [
  { stepDegrees: 0.5, spanDegrees: OCR_DESKEW_MAX_DEGREES },
  { stepDegrees: 0.1, spanDegrees: 0.5 },
  { stepDegrees: 0.02, spanDegrees: 0.1 },
];
/** Ink pixels used to score an angle; on a denser page every n-th one is taken. */
export const OCR_DESKEW_MAX_POINTS = 300_000;
/** Fewer ink pixels than this carry no line structure; the page is reported as straight. */
const DESKEW_MIN_POINTS = 50;
/** Angles scored between hand-offs to the event loop. */
const DESKEW_ANGLES_PER_YIELD = 8;
const DEGREES_TO_RADIANS = Math.PI / 180;

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
  /** Distance from the page centre to a corner, which bounds a turned row coordinate. */
  radius: number;
}

/** Centre-relative coordinates of the ink pixels, thinned to at most OCR_DESKEW_MAX_POINTS. */
function collectInk(binary: Uint8Array, width: number, height: number): InkPoints {
  let ink = 0;
  for (let i = 0; i < binary.length; i++) {
    if (binary[i] === SAUVOLA_INK) ink++;
  }
  const every = Math.max(1, Math.ceil(ink / OCR_DESKEW_MAX_POINTS));
  const used = Math.ceil(ink / every);
  const xs = new Int32Array(used);
  const ys = new Int32Array(used);
  const centreX = width >> 1;
  const centreY = height >> 1;
  let seen = 0;
  let taken = 0;
  for (let y = 0; y < height; y++) {
    const base = y * width;
    for (let x = 0; x < width; x++) {
      if (binary[base + x] !== SAUVOLA_INK) continue;
      if (seen % every === 0) {
        xs[taken] = x - centreX;
        ys[taken] = y - centreY;
        taken++;
      }
      seen++;
    }
  }
  return { xs, ys, radius: Math.ceil(Math.hypot(width, height) / 2) + 2 };
}

/**
 * Rows of ink after the page is turned by `degrees` clockwise-positive (the direction in which a
 * line sloping down to the right is levelled): counts per row go to `counts`, and the sum of their
 * squares is returned. Straight lines concentrate ink in few rows, which maximises the sum.
 */
function projectionScore(points: InkPoints, degrees: number, counts: Uint32Array): number {
  const radians = degrees * DEGREES_TO_RADIANS;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const { xs, ys, radius } = points;
  counts.fill(0);
  for (let i = 0; i < xs.length; i++) {
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
}

/**
 * Finds the skew of a binarized page by projection-profile variance: for each candidate angle the
 * ink pixels are projected onto rows, and the angle with the sharpest row profile levels the
 * text. The search is coarse to fine over plus or minus OCR_DESKEW_MAX_DEGREES and works on ink
 * coordinates, so it costs time in proportion to the (capped) ink, not the page area.
 */
export async function estimateSkew(binary: Uint8Array, width: number, height: number): Promise<SkewEstimate> {
  assertBinary(binary, width, height);
  const points = collectInk(binary, width, height);
  const counts = new Uint32Array(2 * points.radius + 1);
  const baseline = projectionScore(points, 0, counts);
  if (points.xs.length < DESKEW_MIN_POINTS) {
    return { degrees: 0, improvement: 1, profile: counts.slice() };
  }

  let bestDegrees = 0;
  let bestScore = baseline;
  let evaluated = 0;
  for (const stage of DESKEW_STAGES) {
    const centre = bestDegrees;
    const steps = Math.round(stage.spanDegrees / stage.stepDegrees);
    // The first stage covers the whole range around 0; later stages refine around the best so far.
    for (let k = -steps; k <= steps; k++) {
      const degrees = Math.round((centre + k * stage.stepDegrees) * 1e4) / 1e4;
      if (Math.abs(degrees) > OCR_DESKEW_MAX_DEGREES || degrees === bestDegrees) continue;
      const score = projectionScore(points, degrees, counts);
      if (score > bestScore) {
        bestScore = score;
        bestDegrees = degrees;
      }
      if (++evaluated % DESKEW_ANGLES_PER_YIELD === 0) await yieldToEventLoop();
    }
  }
  projectionScore(points, bestDegrees, counts);
  return { degrees: bestDegrees, improvement: baseline > 0 ? bestScore / baseline : 1, profile: counts };
}
