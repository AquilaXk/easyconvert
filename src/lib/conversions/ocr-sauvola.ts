import { OcrPreprocessError } from '../types';

/**
 * Sauvola adaptive thresholding (Sauvola and Pietikainen, "Adaptive document image binarization",
 * Pattern Recognition 33(2), 2000): a pixel is ink when it is not brighter than
 *
 *   T = m * (1 + k * (s / R - 1))
 *
 * where m and s are the mean and standard deviation of the gray values in a window centred on
 * the pixel, k is the sensitivity and R the largest standard deviation (128 for 8-bit data).
 * Window sums come from integral images of the values and of their squares, so each pixel costs
 * a constant number of operations whatever the window size.
 *
 * Only the integral rows a window can reach are kept (a ring of 2 * half + 2 rows), so memory
 * follows the window and the page width, not the page area.
 */

/** Sensitivity; the paper recommends 0.5, lower values keep thin strokes on noisy backgrounds. */
export const SAUVOLA_K = 0.34;
/** Largest standard deviation of an 8-bit image. */
export const SAUVOLA_DYNAMIC_RANGE = 128;
/** Window sizes are clamped to this range, in pixels, and made odd. */
export const SAUVOLA_MIN_WINDOW = 3;
export const SAUVOLA_MAX_WINDOW = 255;
/** Pixels at or above the threshold are paper, the rest ink. */
export const SAUVOLA_INK = 0;
export const SAUVOLA_PAPER = 255;
/**
 * Pixels processed between hand-offs to the event loop. At roughly 25 ns per pixel this keeps
 * each uninterrupted run near 6 ms.
 */
export const SAUVOLA_YIELD_PIXELS = 1 << 18;
/** Largest image accepted; larger inputs are rejected before anything is allocated. */
export const SAUVOLA_MAX_PIXELS = 100_000_000;

export interface SauvolaOptions {
  /** Window side in pixels; rounded up to an odd number inside the allowed range. */
  windowSize: number;
  k?: number;
  dynamicRange?: number;
  /** Overrides SAUVOLA_YIELD_PIXELS (tests use it to force many hand-offs). */
  yieldEveryPixels?: number;
}

/** Hands control back to the event loop so a long binarization does not stall other requests. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function oddWindow(size: number): number {
  const clamped = Math.min(SAUVOLA_MAX_WINDOW, Math.max(SAUVOLA_MIN_WINDOW, Math.round(size)));
  return clamped % 2 === 0 ? clamped + 1 : clamped;
}

function assertImage(gray: Uint8Array, width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new OcrPreprocessError(`Invalid image size ${width}x${height} for binarization.`);
  }
  if (width * height > SAUVOLA_MAX_PIXELS) {
    throw new OcrPreprocessError(
      `A ${width}x${height} image exceeds the ${SAUVOLA_MAX_PIXELS} pixel binarization limit.`
    );
  }
  if (gray.length !== width * height) {
    throw new OcrPreprocessError(
      `Gray buffer holds ${gray.length} bytes but a ${width}x${height} image needs ${width * height}.`
    );
  }
}


/** The integral rows a window can reach, kept in a ring indexed by row number. */
interface IntegralRing {
  sum: Uint32Array;
  sumSquares: Float64Array;
  /** Cells per integral row: one more than the image width, for the zero column. */
  stride: number;
  /** Integral rows in the ring. */
  rows: number;
}

/**
 * Adds integral row `index` (the sums of image rows 0..index-1) to the ring. The per-pixel loops
 * live in plain functions, not in the async driver: code that resumes after an `await` runs its
 * loops in the interpreter until the optimizer catches up, which made each chunk several times slower.
 */
function integrateRow(gray: Uint8Array, width: number, ring: IntegralRing, index: number): void {
  const { sum, sumSquares, stride } = ring;
  const slot = (index % ring.rows) * stride;
  const above = ((index - 1) % ring.rows) * stride;
  const source = (index - 1) * width;
  let rowSum = 0;
  let rowSquares = 0;
  for (let x = 0; x < width; x++) {
    const value = gray[source + x];
    rowSum += value;
    rowSquares += value * value;
    sum[slot + x + 1] = sum[above + x + 1] + rowSum;
    sumSquares[slot + x + 1] = sumSquares[above + x + 1] + rowSquares;
  }
}

interface RowWindow {
  /** Window columns [left[x], right[x]) of every pixel x, clipped at the border. */
  left: Int32Array;
  right: Int32Array;
  k: number;
  dynamicRange: number;
}

/** Thresholds image row `y` from the window between integral rows `top` and `bottom`. */
function thresholdRow(
  gray: Uint8Array,
  out: Uint8Array,
  width: number,
  y: number,
  ring: IntegralRing,
  top: number,
  bottom: number,
  window: RowWindow
): void {
  const { sum, sumSquares, stride } = ring;
  const { left, right, k, dynamicRange } = window;
  const topSlot = (top % ring.rows) * stride;
  const bottomSlot = (bottom % ring.rows) * stride;
  const rows = bottom - top;
  const base = y * width;
  for (let x = 0; x < width; x++) {
    const x0 = left[x];
    const x1 = right[x];
    const area = rows * (x1 - x0);
    // Cumulative sums wrap modulo 2^32 on pages over 16.8 million pixels; a window sum is far
    // below that, so reducing the four-term difference modulo 2^32 recovers it exactly.
    const total = (sum[bottomSlot + x1] - sum[topSlot + x1] - sum[bottomSlot + x0] + sum[topSlot + x0]) >>> 0;
    const squares =
      sumSquares[bottomSlot + x1] - sumSquares[topSlot + x1] - sumSquares[bottomSlot + x0] + sumSquares[topSlot + x0];
    const mean = total / area;
    const variance = squares / area - mean * mean;
    const deviation = variance > 0 ? Math.sqrt(variance) : 0;
    const threshold = mean * (1 + k * (deviation / dynamicRange - 1));
    out[base + x] = gray[base + x] <= threshold ? SAUVOLA_INK : SAUVOLA_PAPER;
  }
}

/**
 * Binarizes 8-bit gray pixels. Returns one byte per pixel, SAUVOLA_INK or SAUVOLA_PAPER. Windows
 * are clipped at the image border, and the statistics use the clipped area.
 */
export async function sauvolaBinarize(
  gray: Uint8Array,
  width: number,
  height: number,
  options: SauvolaOptions
): Promise<Uint8Array> {
  assertImage(gray, width, height);
  const k = options.k ?? SAUVOLA_K;
  const dynamicRange = options.dynamicRange ?? SAUVOLA_DYNAMIC_RANGE;
  if (!(dynamicRange > 0) || !Number.isFinite(k)) {
    throw new OcrPreprocessError('Sauvola parameters must be finite and the dynamic range positive.');
  }
  const yieldEvery = Math.max(1, options.yieldEveryPixels ?? SAUVOLA_YIELD_PIXELS);
  const half = (oddWindow(options.windowSize) - 1) >> 1;
  const stride = width + 1;
  // Integral row k holds the sums of image rows 0..k-1; row 0 is zero and so is column 0. A window
  // reads two integral rows at most 2 * half + 1 apart, so a ring of one more row suffices.
  const ringRows = 2 * half + 2;
  const ring: IntegralRing = {
    sum: new Uint32Array(ringRows * stride),
    sumSquares: new Float64Array(ringRows * stride),
    stride,
    rows: ringRows,
  };
  const window: RowWindow = { left: new Int32Array(width), right: new Int32Array(width), k, dynamicRange };
  for (let x = 0; x < width; x++) {
    window.left[x] = Math.max(0, x - half);
    window.right[x] = Math.min(width, x + half + 1);
  }
  const out = new Uint8Array(width * height);

  let built = 0;
  let pending = 0;
  for (let y = 0; y < height; y++) {
    const top = Math.max(0, y - half);
    const bottom = Math.min(height, y + half + 1);
    while (built < bottom) {
      integrateRow(gray, width, ring, ++built);
      pending += width;
      if (pending >= yieldEvery) {
        pending = 0;
        await yieldToEventLoop();
      }
    }
    thresholdRow(gray, out, width, y, ring, top, bottom, window);
    pending += width;
    if (pending >= yieldEvery && y + 1 < height) {
      pending = 0;
      await yieldToEventLoop();
    }
  }
  return out;
}
