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
 * Integral image cells held at once (4 bytes per sum and 8 per sum of squares). Rows are
 * processed in strips so a large page needs a few megabytes, not a table the size of the page.
 */
export const SAUVOLA_MAX_STRIP_CELLS = 1 << 20;
/** A strip always advances by at least this many rows, whatever the window and width. */
export const SAUVOLA_MIN_STRIP_ROWS = 16;
/** Largest image accepted; larger inputs are rejected before anything is allocated. */
export const SAUVOLA_MAX_PIXELS = 100_000_000;
/** Sums of 8-bit values stay exact in a Uint32Array while a strip holds fewer cells than this. */
const UINT32_SAFE_CELLS = Math.floor(0xffffffff / 255);

export interface SauvolaOptions {
  /** Window side in pixels; rounded up to an odd number inside the allowed range. */
  windowSize: number;
  k?: number;
  dynamicRange?: number;
  /** Overrides SAUVOLA_MAX_STRIP_CELLS (tests use it to force several strips). */
  maxStripCells?: number;
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
  const half = (oddWindow(options.windowSize) - 1) >> 1;
  const stride = width + 1;
  const cellBudget = Math.min(options.maxStripCells ?? SAUVOLA_MAX_STRIP_CELLS, UINT32_SAFE_CELLS);
  const minRows = Math.min(SAUVOLA_MIN_STRIP_ROWS, height);
  // Output rows per strip; the integral image also covers `half` rows above and below them.
  const stripRows = Math.min(
    height,
    Math.max(minRows, Math.floor(cellBudget / stride) - 2 * half - 1)
  );
  const maxIntegralRows = Math.min(height, stripRows + 2 * half) + 1;
  if (maxIntegralRows * stride > UINT32_SAFE_CELLS) {
    throw new OcrPreprocessError(`A ${width}x${height} image cannot be binarized with a ${2 * half + 1} px window.`);
  }
  const sum = new Uint32Array(maxIntegralRows * stride);
  const sumSquares = new Float64Array(maxIntegralRows * stride);
  const left = new Int32Array(width);
  const right = new Int32Array(width);
  for (let x = 0; x < width; x++) {
    left[x] = Math.max(0, x - half);
    right[x] = Math.min(width, x + half + 1);
  }
  const out = new Uint8Array(width * height);

  for (let y0 = 0; y0 < height; y0 += stripRows) {
    const y1 = Math.min(height, y0 + stripRows);
    const top = Math.max(0, y0 - half);
    const bottom = Math.min(height, y1 + half);
    for (let row = 0; row < bottom - top; row++) {
      const source = (top + row) * width;
      const base = (row + 1) * stride;
      const above = row * stride;
      let rowSum = 0;
      let rowSquares = 0;
      for (let x = 0; x < width; x++) {
        const value = gray[source + x];
        rowSum += value;
        rowSquares += value * value;
        sum[base + x + 1] = sum[above + x + 1] + rowSum;
        sumSquares[base + x + 1] = sumSquares[above + x + 1] + rowSquares;
      }
    }
    for (let y = y0; y < y1; y++) {
      const r0 = Math.max(0, y - half) - top;
      const r1 = Math.min(height, y + half + 1) - top;
      const rowTop = r0 * stride;
      const rowBottom = r1 * stride;
      const rows = r1 - r0;
      for (let x = 0; x < width; x++) {
        const x0 = left[x];
        const x1 = right[x];
        const area = rows * (x1 - x0);
        const total = sum[rowBottom + x1] - sum[rowTop + x1] - sum[rowBottom + x0] + sum[rowTop + x0];
        const squares =
          sumSquares[rowBottom + x1] - sumSquares[rowTop + x1] - sumSquares[rowBottom + x0] + sumSquares[rowTop + x0];
        const mean = total / area;
        const variance = squares / area - mean * mean;
        const deviation = variance > 0 ? Math.sqrt(variance) : 0;
        const threshold = mean * (1 + k * (deviation / dynamicRange - 1));
        out[y * width + x] = gray[y * width + x] <= threshold ? SAUVOLA_INK : SAUVOLA_PAPER;
      }
    }
    if (y1 < height) await yieldToEventLoop();
  }
  return out;
}
