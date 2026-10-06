import { OcrPreprocessError } from '../types';
import { SAUVOLA_INK } from './ocr-sauvola';

/**
 * Measurements on a binarized page (one byte per pixel, SAUVOLA_INK for ink) that decide how the
 * page is prepared for recognition.
 */

/** A row belongs to a text line when its ink count reaches this share of a typical text row. */
const ROW_INK_FRACTION = 0.04;
/** The typical text row is taken at this percentile of the non-empty row ink counts. */
const TYPICAL_ROW_PERCENTILE = 0.9;
/** Bands shorter than this are rules, specks or noise, not text lines. */
const MIN_LINE_HEIGHT_PX = 4;
/** Every row of a band needs at least this much ink however sparse the page is. */
const MIN_ROW_INK_PIXELS = 2;

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
 * Median height of the text lines, in pixels, from the horizontal projection profile: rows with
 * enough ink form bands, and each band is a line from the top of its tallest letter to the bottom
 * of its lowest one. Returns null when the page holds no line.
 */
export function estimateLineHeight(binary: Uint8Array, width: number, height: number): number | null {
  const profile = horizontalProjection(binary, width, height);
  const occupied = Array.from(profile).filter((count) => count > 0).sort((a, b) => a - b);
  if (occupied.length === 0) return null;
  const typical = occupied[Math.min(occupied.length - 1, Math.floor(occupied.length * TYPICAL_ROW_PERCENTILE))];
  const threshold = Math.max(MIN_ROW_INK_PIXELS, typical * ROW_INK_FRACTION);

  const heights: number[] = [];
  let runStart = -1;
  for (let y = 0; y <= height; y++) {
    const inked = y < height && profile[y] >= threshold;
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
