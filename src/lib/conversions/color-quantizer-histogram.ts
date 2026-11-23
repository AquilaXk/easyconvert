/**
 * Single-pass striped RGBA histogram and exact-colour collector for Oklab palette quantization.
 *
 * Each stripe processes a slice `[from, to)` of the shared RGBA buffer once on a worker pool thread: tracking whether any
 * transparent pixel exists (when `keepsTransparency` is set), collecting up to `maxColors` distinct opaque colours in
 * row-major first-seen order until a continuous-tone raster overflows that limit, and accumulating per-bin 5-bit RGB sums.
 * Merging stripes in slice order preserves the exact palette of single-threaded `exactColours` + `buildHistogram`.
 */

import os from 'node:os';

export const QUANT_MAX_COLORS = 256;
/** Bits of each channel the histogram keeps: 32 x 32 x 32 bins. */
export const QUANT_HISTOGRAM_BITS = 5;
/** A pixel with less alpha than this is transparent when transparency is kept (GIF has one transparent index). */
export const QUANT_ALPHA_THRESHOLD = 128;

export const HISTOGRAM_SHIFT = 8 - QUANT_HISTOGRAM_BITS;
export const HISTOGRAM_BINS = 1 << (3 * QUANT_HISTOGRAM_BITS);
const RGBA_STRIDE = 4;
const EXACT_TABLE_SIZE = 4 * QUANT_MAX_COLORS;
/** Bounded chunks keep V8 TurboFan from stalling on long OSR transitions (see `color-quantizer.ts`). */
const HISTOGRAM_CHUNK_PIXELS = 1 << 16;
/** Max pixels in one stripe whose RGB channel sum stays within `Uint32` (`255 * 16_777_216 < 2^32`). */
const UINT32_SUM_MAX_PIXELS = 1 << 24;
const IS_LITTLE_ENDIAN = os.endianness() === 'LE';

export type HistogramSumArray = Uint32Array | Float64Array;

export interface HistogramStripePayload {
  pixels: Uint8Array;
  from: number;
  to: number;
  maxColors: number;
  keepsTransparency: boolean;
}

export interface HistogramStripeResult {
  hasTransparent: boolean;
  exact: Int32Array | null;
  counts: Uint32Array;
  sumsR: HistogramSumArray;
  sumsG: HistogramSumArray;
  sumsB: HistogramSumArray;
}

export interface MergedStripeHistogram {
  hasTransparent: boolean;
  opaqueColours: number;
  exact: Int32Array | null;
  counts?: Uint32Array;
  sumsR?: Float64Array;
  sumsG?: Float64Array;
  sumsB?: Float64Array;
}

export function clampColourCount(maxColors: number): number {
  if (!Number.isFinite(maxColors)) return QUANT_MAX_COLORS;
  return Math.max(1, Math.min(QUANT_MAX_COLORS, Math.floor(maxColors)));
}

interface ExactCollector {
  table: Int32Array;
  found: Int32Array;
  limit: number;
  count: number;
  lastKey: number;
  overflowed: boolean;
}

function createExactCollector(limit: number): ExactCollector {
  return {
    table: new Int32Array(EXACT_TABLE_SIZE).fill(-1),
    found: new Int32Array(limit),
    limit,
    count: 0,
    lastKey: -1,
    overflowed: false,
  };
}

/** Inserts `key` (packed `0xRRGGBB`) preserving first-seen order; marks `overflowed` if distinct count exceeds `limit`. */
function recordExactKey(state: ExactCollector, key: number): void {
  if (key === state.lastKey) return;
  state.lastKey = key;
  let slot = (Math.imul(key, 0x9e3779b1) >>> 22) % EXACT_TABLE_SIZE;
  for (;;) {
    const held = state.table[slot];
    if (held === -1) {
      if (state.count === state.limit) {
        state.overflowed = true;
        return;
      }
      state.table[slot] = key;
      state.found[state.count] = key;
      state.count += 1;
      return;
    }
    if (held === key) return;
    slot = (slot + 1) % EXACT_TABLE_SIZE;
  }
}

function binOfRgb(r: number, g: number, b: number): number {
  return ((r >> HISTOGRAM_SHIFT) << (2 * QUANT_HISTOGRAM_BITS)) | ((g >> HISTOGRAM_SHIFT) << QUANT_HISTOGRAM_BITS) | (b >> HISTOGRAM_SHIFT);
}

function alignedU32View(pixels: ArrayLike<number>): Uint32Array | null {
  if (
    IS_LITTLE_ENDIAN &&
    (pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray) &&
    (pixels.byteOffset & 3) === 0
  ) {
    return new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.byteLength >>> 2);
  }
  return null;
}

interface StripeAccumulators {
  counts: Uint32Array;
  sumsR: HistogramSumArray;
  sumsG: HistogramSumArray;
  sumsB: HistogramSumArray;
}

interface ExactChunkParams {
  pixels: ArrayLike<number>;
  u32: Uint32Array | null;
  keepsTransparency: boolean;
  exact: ExactCollector;
  acc: StripeAccumulators;
}

function scanChunkWithExact(ctx: ExactChunkParams, from: number, to: number): boolean {
  const { pixels, u32, keepsTransparency, exact, acc } = ctx;
  const { counts, sumsR, sumsG, sumsB } = acc;
  let hasTransparent = false;
  if (u32 !== null) {
    for (let p = from; p < to; p += 1) {
      const val = u32[p];
      if (keepsTransparency && (val >>> 24) < QUANT_ALPHA_THRESHOLD) {
        hasTransparent = true;
        continue;
      }
      const r = val & 0xff;
      const g = (val >>> 8) & 0xff;
      const b = (val >>> 16) & 0xff;
      if (!exact.overflowed) recordExactKey(exact, (r << 16) | (g << 8) | b);
      const bin = binOfRgb(r, g, b);
      counts[bin] += 1;
      sumsR[bin] += r;
      sumsG[bin] += g;
      sumsB[bin] += b;
    }
    return hasTransparent;
  }
  for (let p = from; p < to; p += 1) {
    const i = p * RGBA_STRIDE;
    if (keepsTransparency && pixels[i + 3] < QUANT_ALPHA_THRESHOLD) {
      hasTransparent = true;
      continue;
    }
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    if (!exact.overflowed) recordExactKey(exact, (r << 16) | (g << 8) | b);
    const bin = binOfRgb(r, g, b);
    counts[bin] += 1;
    sumsR[bin] += r;
    sumsG[bin] += g;
    sumsB[bin] += b;
  }
  return hasTransparent;
}

function countChunkOpaqueU32(u32: Uint32Array, from: number, to: number, acc: StripeAccumulators): void {
  const { counts, sumsR, sumsG, sumsB } = acc;
  for (let p = from; p < to; p += 1) {
    const val = u32[p];
    const r = val & 0xff;
    const g = (val >>> 8) & 0xff;
    const b = (val >>> 16) & 0xff;
    const bin = ((r >> HISTOGRAM_SHIFT) << (2 * QUANT_HISTOGRAM_BITS)) | ((g >> HISTOGRAM_SHIFT) << QUANT_HISTOGRAM_BITS) | (b >> HISTOGRAM_SHIFT);
    counts[bin] += 1;
    sumsR[bin] += r;
    sumsG[bin] += g;
    sumsB[bin] += b;
  }
}

function countChunkAlphaU32(u32: Uint32Array, from: number, to: number, acc: StripeAccumulators): boolean {
  const { counts, sumsR, sumsG, sumsB } = acc;
  let hasTransparent = false;
  for (let p = from; p < to; p += 1) {
    const val = u32[p];
    if ((val >>> 24) < QUANT_ALPHA_THRESHOLD) {
      hasTransparent = true;
      continue;
    }
    const r = val & 0xff;
    const g = (val >>> 8) & 0xff;
    const b = (val >>> 16) & 0xff;
    const bin = ((r >> HISTOGRAM_SHIFT) << (2 * QUANT_HISTOGRAM_BITS)) | ((g >> HISTOGRAM_SHIFT) << QUANT_HISTOGRAM_BITS) | (b >> HISTOGRAM_SHIFT);
    counts[bin] += 1;
    sumsR[bin] += r;
    sumsG[bin] += g;
    sumsB[bin] += b;
  }
  return hasTransparent;
}

function countChunkScalar(
  pixels: ArrayLike<number>,
  range: { from: number; to: number },
  keepsTransparency: boolean,
  acc: StripeAccumulators
): boolean {
  const { from, to } = range;
  const { counts, sumsR, sumsG, sumsB } = acc;
  let hasTransparent = false;
  for (let p = from; p < to; p += 1) {
    const i = p * RGBA_STRIDE;
    if (keepsTransparency && pixels[i + 3] < QUANT_ALPHA_THRESHOLD) {
      hasTransparent = true;
      continue;
    }
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const bin = binOfRgb(r, g, b);
    counts[bin] += 1;
    sumsR[bin] += r;
    sumsG[bin] += g;
    sumsB[bin] += b;
  }
  return hasTransparent;
}

/** Counts transparent pixels, up to `maxColors` exact opaque colours, and 5-bit histogram sums across `[from, to)`. */
export function runHistogramStripe(payload: HistogramStripePayload): HistogramStripeResult {
  const maxPixels = Math.floor(payload.pixels.length / RGBA_STRIDE);
  const from = Math.max(0, Math.min(maxPixels, Math.floor(payload.from)));
  const to = Math.max(from, Math.min(maxPixels, Math.floor(payload.to)));
  const stripePixels = to - from;
  const exactLimit = clampColourCount(payload.maxColors);
  const exact = createExactCollector(exactLimit);

  const SumArray = stripePixels <= UINT32_SUM_MAX_PIXELS ? Uint32Array : Float64Array;
  const acc: StripeAccumulators = {
    counts: new Uint32Array(HISTOGRAM_BINS),
    sumsR: new SumArray(HISTOGRAM_BINS),
    sumsG: new SumArray(HISTOGRAM_BINS),
    sumsB: new SumArray(HISTOGRAM_BINS),
  };
  const u32 = alignedU32View(payload.pixels);
  const exactCtx: ExactChunkParams = {
    pixels: payload.pixels,
    u32,
    keepsTransparency: payload.keepsTransparency,
    exact,
    acc,
  };

  let hasTransparent = false;
  for (let chunkFrom = from; chunkFrom < to; chunkFrom += HISTOGRAM_CHUNK_PIXELS) {
    const chunkTo = Math.min(to, chunkFrom + HISTOGRAM_CHUNK_PIXELS);
    if (!exact.overflowed) {
      if (scanChunkWithExact(exactCtx, chunkFrom, chunkTo)) hasTransparent = true;
      continue;
    }
    if (u32 === null) {
      if (countChunkScalar(payload.pixels, { from: chunkFrom, to: chunkTo }, payload.keepsTransparency, acc)) {
        hasTransparent = true;
      }
      continue;
    }
    if (payload.keepsTransparency) {
      if (countChunkAlphaU32(u32, chunkFrom, chunkTo, acc)) hasTransparent = true;
    } else {
      countChunkOpaqueU32(u32, chunkFrom, chunkTo, acc);
    }
  }

  return {
    hasTransparent,
    exact: exact.overflowed ? null : exact.found.slice(0, exact.count),
    counts: acc.counts,
    sumsR: acc.sumsR,
    sumsG: acc.sumsG,
    sumsB: acc.sumsB,
  };
}

/** Exclusive ArrayBuffers owned by one `HistogramStripeResult` so worker replies move zero-copy. */
export function histogramStripeTransfer(result: HistogramStripeResult): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [
    result.counts.buffer as ArrayBuffer,
    result.sumsR.buffer as ArrayBuffer,
    result.sumsG.buffer as ArrayBuffer,
    result.sumsB.buffer as ArrayBuffer,
  ];
  if (result.exact !== null) buffers.push(result.exact.buffer as ArrayBuffer);
  return buffers;
}

/** Zero-copy transfer list for forwarding stripe histogram results into a merge worker task. */
export function histogramStripesTransfer(stripes: readonly HistogramStripeResult[]): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [];
  for (const stripe of stripes) buffers.push(...histogramStripeTransfer(stripe));
  return buffers;
}

function mergeExactStripes(stripes: readonly HistogramStripeResult[], opaqueColours: number): Int32Array | null {
  for (const stripe of stripes) {
    if (stripe.exact === null) return null;
  }
  const merged = createExactCollector(opaqueColours);
  for (const stripe of stripes) {
    const keys = stripe.exact as Int32Array;
    for (let i = 0; i < keys.length; i += 1) {
      recordExactKey(merged, keys[i]);
      if (merged.overflowed) return null;
    }
  }
  return merged.found.slice(0, merged.count);
}

/** Combines stripe results in stripe order into either the exact colour table or summed 5-bit RGB totals. */
export function mergeHistogramStripes(
  stripes: readonly HistogramStripeResult[],
  maxColors: number,
  keepsTransparency: boolean
): MergedStripeHistogram {
  let hasTransparent = false;
  if (keepsTransparency) {
    for (const stripe of stripes) {
      if (stripe.hasTransparent) {
        hasTransparent = true;
        break;
      }
    }
  }
  const opaqueColours = Math.max(1, clampColourCount(maxColors) - (hasTransparent ? 1 : 0));
  const exact = mergeExactStripes(stripes, opaqueColours);
  if (exact !== null) {
    return { hasTransparent, opaqueColours, exact };
  }

  const counts = new Uint32Array(HISTOGRAM_BINS);
  const sumsR = new Float64Array(HISTOGRAM_BINS);
  const sumsG = new Float64Array(HISTOGRAM_BINS);
  const sumsB = new Float64Array(HISTOGRAM_BINS);
  for (const stripe of stripes) {
    const sC = stripe.counts;
    const sR = stripe.sumsR;
    const sG = stripe.sumsG;
    const sB = stripe.sumsB;
    for (let b = 0; b < HISTOGRAM_BINS; b += 1) {
      const c = sC[b];
      if (c === 0) continue;
      counts[b] += c;
      sumsR[b] += sR[b];
      sumsG[b] += sG[b];
      sumsB[b] += sB[b];
    }
  }
  return { hasTransparent, opaqueColours, exact: null, counts, sumsR, sumsG, sumsB };
}
