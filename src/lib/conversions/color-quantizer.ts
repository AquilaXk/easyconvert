/**
 * Perceptual palette quantization in Oklab (B. Ottosson, 2020) with linear-light dithering.
 *
 * Palette: a 5-bit-per-channel histogram holds every opaque pixel (nothing is sampled); median cut by variance
 * (P. Heckbert, "Color image quantization for frame buffer display", 1982, with the box chosen and split by
 * weighted variance as in M. Gervautz and W. Purgathofer, 1990) divides it into the requested number of boxes;
 * weighted k-means (S. Lloyd, 1982) over the histogram then refines the centroids until they stop moving.
 * An image that has no more distinct colours than the palette allows keeps them exactly.
 *
 * Mapping: a k-d tree over the palette gives the exact nearest colour in Oklab. Floyd-Steinberg error diffusion
 * (1976) runs serpentine in linear light, so the average light of a dithered area matches the source; Riemersma
 * (1998) dithering follows a Hilbert curve; blue-noise dithering thresholds with a void-and-cluster mask
 * (`blue-noise-mask.ts`).
 *
 * Everything works on typed arrays; no object is allocated per pixel.
 */

import { ConversionFailedError } from '../types';
import { BLUE_NOISE_SIDE, blueNoiseCentred } from './blue-noise-mask';
import { KdTree3 } from './kd-tree';

export interface RgbColor {
  r: number;
  g: number;
  b: number;
  a?: number;
}

export interface OklabColor {
  L: number;
  a: number;
  b: number;
  alpha?: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Limits and constants
// ---------------------------------------------------------------------------------------------------------------

export const QUANT_MAX_COLORS = 256;
/** Bits of each channel the histogram keeps: 32 x 32 x 32 bins. */
export const QUANT_HISTOGRAM_BITS = 5;
/** k-means passes over the histogram; the refinement usually settles in fewer. */
export const QUANT_MAX_ITERATIONS = 16;
/** k-means stops when no centroid moves more than this in Oklab (about a twentieth of a just-noticeable difference). */
export const QUANT_CONVERGENCE_DELTA = 1e-4;
/** A pixel with less alpha than this is transparent when transparency is kept (GIF has one transparent index). */
export const QUANT_ALPHA_THRESHOLD = 128;
/** Rasters of at least this many pixels are mapped through the candidate grid (it costs a few tens of ms to build). */
const GRID_MIN_PIXELS = 100_000;
/** Hilbert-curve error queue length of Riemersma dithering. */
const RIEMERSMA_QUEUE_SIZE = 16;
/** Blue-noise amplitude, as a share of the typical spacing between palette colours. */
const BLUE_NOISE_STRENGTH = 1.0;
/** Offsets that decorrelate the mask samples of the three colour channels. */
const BLUE_NOISE_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [21, 37],
  [43, 11],
];

const HISTOGRAM_SHIFT = 8 - QUANT_HISTOGRAM_BITS;
const HISTOGRAM_BINS = 1 << (3 * QUANT_HISTOGRAM_BITS);
const RGBA_STRIDE = 4;
const RGB_STRIDE = 3;
const BYTE_MAX = 255;
/** Open-addressing table for the exact distinct-colour count: at most four times the palette limit. */
const EXACT_TABLE_SIZE = 4 * QUANT_MAX_COLORS;

// ---------------------------------------------------------------------------------------------------------------
// Colour conversions
// ---------------------------------------------------------------------------------------------------------------

const SRGB_TO_LINEAR_TABLE = (() => {
  const table = new Float32Array(256);
  for (let i = 0; i < 256; i += 1) {
    const norm = i / BYTE_MAX;
    table[i] = norm <= 0.04045 ? norm / 12.92 : Math.pow((norm + 0.055) / 1.055, 2.4);
  }
  return table;
})();

/** Converts an sRGB component (0..255) to linear light RGB (0..1). */
export function srgbToLinear(c: number): number {
  const norm = Math.max(0, Math.min(BYTE_MAX, c)) / BYTE_MAX;
  return norm <= 0.04045 ? norm / 12.92 : Math.pow((norm + 0.055) / 1.055, 2.4);
}

/** Converts a linear light RGB component (0..1) to sRGB (0..255). */
export function linearToSrgb(c: number): number {
  const clamped = Math.max(0, Math.min(1, c));
  const srgb = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * Math.pow(clamped, 1.0 / 2.4) - 0.055;
  return Math.round(Math.max(0, Math.min(BYTE_MAX, srgb * BYTE_MAX)));
}

/** Oklab of linear sRGB components, written to `out[offset..offset + 2]`. */
function linearToOklab(r: number, g: number, b: number, out: Float64Array, offset: number): void {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  out[offset] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  out[offset + 1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  out[offset + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
}

/** Converts 24-bit sRGB color into Ottosson's Oklab perceptual color space. */
export function rgbToOklab(rgb: RgbColor): OklabColor {
  const out = new Float64Array(3);
  linearToOklab(srgbToLinear(rgb.r), srgbToLinear(rgb.g), srgbToLinear(rgb.b), out, 0);
  return { L: out[0], a: out[1], b: out[2], alpha: rgb.a !== undefined ? rgb.a : BYTE_MAX };
}

/** Converts Oklab color back to 24-bit sRGB space. */
export function oklabToRgb(oklab: OklabColor): RgbColor {
  const { L, a, b, alpha } = oklab;
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return {
    r: linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    a: alpha !== undefined ? alpha : BYTE_MAX,
  };
}

/** Perceptual Euclidean distance Delta E_OK between two Oklab colors. */
export function deltaEOk(c1: OklabColor, c2: OklabColor): number {
  const dL = c1.L - c2.L;
  const da = c1.a - c2.a;
  const db = c1.b - c2.b;
  return Math.sqrt(dL * dL + da * da + db * db);
}

/** Perceptual Delta E_OK directly between two RGB colors. */
export function deltaEOkRgb(rgb1: RgbColor, rgb2: RgbColor): number {
  return deltaEOk(rgbToOklab(rgb1), rgbToOklab(rgb2));
}

/** Index of the nearest color in an Oklab palette to a given Oklab target (a linear scan for small lists). */
export function findNearestColorIndexOklab(target: OklabColor, paletteOklab: OklabColor[]): number {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < paletteOklab.length; i++) {
    const dist = deltaEOk(target, paletteOklab[i]);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
      if (dist === 0) break;
    }
  }
  return bestIdx;
}

// ---------------------------------------------------------------------------------------------------------------
// Palette construction
// ---------------------------------------------------------------------------------------------------------------

export type DitherKind = 'none' | 'floyd-steinberg' | 'riemersma' | 'blue-noise';

export interface QuantizeOptions {
  dither?: DitherKind;
  /**
   * 'ignore' (default): alpha plays no part and every pixel is mapped. 'threshold': a pixel below
   * `QUANT_ALPHA_THRESHOLD` maps to a reserved transparent index and leaves the palette and dither alone.
   */
  transparency?: 'ignore' | 'threshold';
  /**
   * Without dithering only: a pixel keeps the colour of the pixel before it when that colour is at most (1 + runTolerance)
   * times as far from it as the nearest colour is (0, the default, maps every pixel to its nearest colour). Where the
   * nearest colour flips between two neighbours of nearly equal distance the file gains a run for the LZW coder, as
   * a lossy GIF writer does, and the picture moves by less than the palette's own rounding.
   */
  runTolerance?: number;
}

export interface IndexedImage {
  /** Palette colours as r, g, b triples, transparent entry (if any) last as 0, 0, 0. */
  palette: Uint8Array;
  paletteSize: number;
  indices: Uint8Array;
  /** Index that stands for transparent pixels, or -1 when the image keeps none. */
  transparentIndex: number;
}

function assertRaster(pixels: ArrayLike<number>, width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new ConversionFailedError(`Palette quantization needs a positive integer size; got ${width} x ${height}.`);
  }
  if (pixels.length < width * height * RGBA_STRIDE) {
    throw new ConversionFailedError(`Palette quantization needs ${width * height * RGBA_STRIDE} bytes of RGBA pixels, got ${pixels.length}.`);
  }
}

function clampColourCount(maxColors: number): number {
  if (!Number.isFinite(maxColors)) return QUANT_MAX_COLORS;
  return Math.max(1, Math.min(QUANT_MAX_COLORS, Math.floor(maxColors)));
}

/** The image's distinct opaque colours as packed 0xRRGGBB when there are at most `limit`; otherwise null. */
function exactColours(pixels: ArrayLike<number>, pixelCount: number, limit: number, ignoreTransparent: boolean): Int32Array | null {
  const table = new Int32Array(EXACT_TABLE_SIZE).fill(-1);
  const found = new Int32Array(limit);
  let count = 0;
  let lastKey = -1;
  for (let p = 0; p < pixelCount; p += 1) {
    const i = p * RGBA_STRIDE;
    if (ignoreTransparent && pixels[i + 3] < QUANT_ALPHA_THRESHOLD) continue;
    const key = (pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2];
    if (key === lastKey) continue;
    lastKey = key;
    let slot = Math.imul(key, 0x9e3779b1) >>> 22;
    slot %= EXACT_TABLE_SIZE;
    for (;;) {
      const held = table[slot];
      if (held === -1) {
        if (count === limit) return null;
        table[slot] = key;
        found[count] = key;
        count += 1;
        break;
      }
      if (held === key) break;
      slot = (slot + 1) % EXACT_TABLE_SIZE;
    }
  }
  return found.subarray(0, count);
}

interface Histogram {
  /** Occupied bins: pixel count, and mean colour in Oklab (L, a, b interleaved). */
  size: number;
  weight: Float64Array;
  lab: Float64Array;
}

function buildHistogram(pixels: ArrayLike<number>, pixelCount: number, ignoreTransparent: boolean): Histogram {
  const counts = new Uint32Array(HISTOGRAM_BINS);
  const sums = new Float64Array(HISTOGRAM_BINS * RGB_STRIDE);
  for (let p = 0; p < pixelCount; p += 1) {
    const i = p * RGBA_STRIDE;
    if (ignoreTransparent && pixels[i + 3] < QUANT_ALPHA_THRESHOLD) continue;
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const bin = ((r >> HISTOGRAM_SHIFT) << (2 * QUANT_HISTOGRAM_BITS)) | ((g >> HISTOGRAM_SHIFT) << QUANT_HISTOGRAM_BITS) | (b >> HISTOGRAM_SHIFT);
    counts[bin] += 1;
    sums[bin * RGB_STRIDE] += r;
    sums[bin * RGB_STRIDE + 1] += g;
    sums[bin * RGB_STRIDE + 2] += b;
  }
  let occupied = 0;
  for (let bin = 0; bin < HISTOGRAM_BINS; bin += 1) if (counts[bin] > 0) occupied += 1;
  const weight = new Float64Array(occupied);
  const lab = new Float64Array(occupied * RGB_STRIDE);
  let k = 0;
  for (let bin = 0; bin < HISTOGRAM_BINS; bin += 1) {
    const n = counts[bin];
    if (n === 0) continue;
    weight[k] = n;
    linearToOklab(
      srgbToLinear(sums[bin * RGB_STRIDE] / n),
      srgbToLinear(sums[bin * RGB_STRIDE + 1] / n),
      srgbToLinear(sums[bin * RGB_STRIDE + 2] / n),
      lab,
      k * RGB_STRIDE
    );
    k += 1;
  }
  return { size: occupied, weight, lab };
}

interface Box {
  start: number;
  end: number;
  /** Sum over the box of weight x squared distance to the box's mean: the error this box would leave. */
  error: number;
}

/** Weighted mean and total squared error of the histogram entries order[start..end). */
function boxStatistics(histogram: Histogram, order: Uint32Array, start: number, end: number, mean: Float64Array): number {
  let weightSum = 0;
  mean[0] = 0;
  mean[1] = 0;
  mean[2] = 0;
  for (let i = start; i < end; i += 1) {
    const e = order[i];
    const w = histogram.weight[e];
    weightSum += w;
    mean[0] += w * histogram.lab[e * RGB_STRIDE];
    mean[1] += w * histogram.lab[e * RGB_STRIDE + 1];
    mean[2] += w * histogram.lab[e * RGB_STRIDE + 2];
  }
  mean[0] /= weightSum;
  mean[1] /= weightSum;
  mean[2] /= weightSum;
  let error = 0;
  for (let i = start; i < end; i += 1) {
    const e = order[i];
    const dL = histogram.lab[e * RGB_STRIDE] - mean[0];
    const da = histogram.lab[e * RGB_STRIDE + 1] - mean[1];
    const db = histogram.lab[e * RGB_STRIDE + 2] - mean[2];
    error += histogram.weight[e] * (dL * dL + da * da + db * db);
  }
  return error;
}

/** Divides the histogram into at most `k` boxes by repeatedly splitting the box with the most error at its weighted median. */
function medianCut(histogram: Histogram, k: number): { order: Uint32Array; boxes: Box[] } {
  const order = new Uint32Array(histogram.size);
  for (let i = 0; i < histogram.size; i += 1) order[i] = i;
  const mean = new Float64Array(RGB_STRIDE);
  const boxes: Box[] = [{ start: 0, end: histogram.size, error: boxStatistics(histogram, order, 0, histogram.size, mean) }];
  while (boxes.length < k) {
    let pick = -1;
    let pickError = 0;
    for (let b = 0; b < boxes.length; b += 1) {
      if (boxes[b].end - boxes[b].start > 1 && boxes[b].error > pickError) {
        pickError = boxes[b].error;
        pick = b;
      }
    }
    if (pick === -1) break;
    const box = boxes[pick];
    // Split along the axis with the largest weighted variance.
    boxStatistics(histogram, order, box.start, box.end, mean);
    let axis = 0;
    let axisVariance = -1;
    for (let d = 0; d < RGB_STRIDE; d += 1) {
      let variance = 0;
      for (let i = box.start; i < box.end; i += 1) {
        const e = order[i];
        const delta = histogram.lab[e * RGB_STRIDE + d] - mean[d];
        variance += histogram.weight[e] * delta * delta;
      }
      if (variance > axisVariance) {
        axisVariance = variance;
        axis = d;
      }
    }
    order.subarray(box.start, box.end).sort((x, y) => histogram.lab[x * RGB_STRIDE + axis] - histogram.lab[y * RGB_STRIDE + axis] || x - y);
    // Weighted median: the first entry at which half of the box's weight is reached.
    let total = 0;
    for (let i = box.start; i < box.end; i += 1) total += histogram.weight[order[i]];
    let running = 0;
    let cut = box.start + 1;
    for (let i = box.start; i < box.end - 1; i += 1) {
      running += histogram.weight[order[i]];
      cut = i + 1;
      if (running * 2 >= total) break;
    }
    const left: Box = { start: box.start, end: cut, error: boxStatistics(histogram, order, box.start, cut, mean) };
    const right: Box = { start: cut, end: box.end, error: boxStatistics(histogram, order, cut, box.end, mean) };
    boxes.splice(pick, 1, left, right);
  }
  return { order, boxes };
}

/** Weighted k-means over the histogram from the median-cut centroids; returns the refined centroids (L, a, b). */
function refineCentroids(histogram: Histogram, initial: Float64Array, count: number): Float64Array {
  let centroids = Float64Array.from(initial);
  const sums = new Float64Array(count * RGB_STRIDE);
  const weights = new Float64Array(count);
  const assigned = new Int32Array(histogram.size);
  for (let iteration = 0; iteration < QUANT_MAX_ITERATIONS; iteration += 1) {
    const tree = new KdTree3(centroids, count);
    sums.fill(0);
    weights.fill(0);
    let worst = -1;
    let worstDistance = -1;
    for (let e = 0; e < histogram.size; e += 1) {
      const o = e * RGB_STRIDE;
      const c = tree.nearestIndex(histogram.lab[o], histogram.lab[o + 1], histogram.lab[o + 2]);
      assigned[e] = c;
      const w = histogram.weight[e];
      weights[c] += w;
      sums[c * RGB_STRIDE] += w * histogram.lab[o];
      sums[c * RGB_STRIDE + 1] += w * histogram.lab[o + 1];
      sums[c * RGB_STRIDE + 2] += w * histogram.lab[o + 2];
      if (tree.lastDistance2 * w > worstDistance) {
        worstDistance = tree.lastDistance2 * w;
        worst = e;
      }
    }
    const next = new Float64Array(count * RGB_STRIDE);
    let maxShift = 0;
    for (let c = 0; c < count; c += 1) {
      const o = c * RGB_STRIDE;
      if (weights[c] > 0) {
        next[o] = sums[o] / weights[c];
        next[o + 1] = sums[o + 1] / weights[c];
        next[o + 2] = sums[o + 2] / weights[c];
      } else if (worst >= 0) {
        // An empty cluster moves to the entry that is worst served, once per pass.
        next[o] = histogram.lab[worst * RGB_STRIDE];
        next[o + 1] = histogram.lab[worst * RGB_STRIDE + 1];
        next[o + 2] = histogram.lab[worst * RGB_STRIDE + 2];
        worst = -1;
      } else {
        next[o] = centroids[o];
        next[o + 1] = centroids[o + 1];
        next[o + 2] = centroids[o + 2];
      }
      maxShift = Math.max(maxShift, Math.hypot(next[o] - centroids[o], next[o + 1] - centroids[o + 1], next[o + 2] - centroids[o + 2]));
    }
    centroids = next;
    if (maxShift < QUANT_CONVERGENCE_DELTA) break;
  }
  return centroids;
}

/** Palette (r, g, b triples) for the image's opaque pixels, at most `maxColors` colours. */
function buildPalette(pixels: ArrayLike<number>, pixelCount: number, maxColors: number, ignoreTransparent: boolean): Uint8Array {
  const exact = exactColours(pixels, pixelCount, maxColors, ignoreTransparent);
  if (exact !== null) {
    if (exact.length === 0) return Uint8Array.of(0, 0, 0);
    const palette = new Uint8Array(exact.length * RGB_STRIDE);
    for (let i = 0; i < exact.length; i += 1) {
      palette[i * RGB_STRIDE] = (exact[i] >> 16) & BYTE_MAX;
      palette[i * RGB_STRIDE + 1] = (exact[i] >> 8) & BYTE_MAX;
      palette[i * RGB_STRIDE + 2] = exact[i] & BYTE_MAX;
    }
    return palette;
  }
  const histogram = buildHistogram(pixels, pixelCount, ignoreTransparent);
  const { order, boxes } = medianCut(histogram, maxColors);
  const initial = new Float64Array(boxes.length * RGB_STRIDE);
  const mean = new Float64Array(RGB_STRIDE);
  boxes.forEach((box, i) => {
    boxStatistics(histogram, order, box.start, box.end, mean);
    initial.set(mean, i * RGB_STRIDE);
  });
  const centroids = refineCentroids(histogram, initial, boxes.length);
  const palette = new Uint8Array(boxes.length * RGB_STRIDE);
  for (let i = 0; i < boxes.length; i += 1) {
    const rgb = oklabToRgb({ L: centroids[i * RGB_STRIDE], a: centroids[i * RGB_STRIDE + 1], b: centroids[i * RGB_STRIDE + 2] });
    palette[i * RGB_STRIDE] = rgb.r;
    palette[i * RGB_STRIDE + 1] = rgb.g;
    palette[i * RGB_STRIDE + 2] = rgb.b;
  }
  return palette;
}

// ---------------------------------------------------------------------------------------------------------------
// Mapping and dithering
// ---------------------------------------------------------------------------------------------------------------

/** A palette prepared for lookups: Oklab and linear-light copies, and the k-d tree over the Oklab points. */
interface PaletteModel {
  size: number;
  tree: KdTree3;
  linear: Float32Array;
  oklab: Float64Array;
}

function modelOf(palette: Uint8Array, size: number): PaletteModel {
  const linear = new Float32Array(size * RGB_STRIDE);
  const oklab = new Float64Array(size * RGB_STRIDE);
  for (let i = 0; i < size; i += 1) {
    const r = SRGB_TO_LINEAR_TABLE[palette[i * RGB_STRIDE]];
    const g = SRGB_TO_LINEAR_TABLE[palette[i * RGB_STRIDE + 1]];
    const b = SRGB_TO_LINEAR_TABLE[palette[i * RGB_STRIDE + 2]];
    linear[i * RGB_STRIDE] = r;
    linear[i * RGB_STRIDE + 1] = g;
    linear[i * RGB_STRIDE + 2] = b;
    linearToOklab(r, g, b, oklab, i * RGB_STRIDE);
  }
  return { size, tree: new KdTree3(oklab, size), linear, oklab };
}

/** Typical distance between neighbouring palette colours, in linear light and in Oklab. */
function paletteSpacing(model: PaletteModel): { linear: number; oklab: number } {
  if (model.size < 2) return { linear: 0, oklab: 0 };
  const linear: number[] = [];
  const perceptual: number[] = [];
  for (let i = 0; i < model.size; i += 1) {
    let bestLinear = Infinity;
    let bestOklab = Infinity;
    for (let j = 0; j < model.size; j += 1) {
      if (i === j) continue;
      let dl = 0;
      let dk = 0;
      for (let d = 0; d < RGB_STRIDE; d += 1) {
        dl += (model.linear[i * RGB_STRIDE + d] - model.linear[j * RGB_STRIDE + d]) ** 2;
        dk += (model.oklab[i * RGB_STRIDE + d] - model.oklab[j * RGB_STRIDE + d]) ** 2;
      }
      if (dl < bestLinear) bestLinear = dl;
      if (dk < bestOklab) bestOklab = dk;
    }
    linear.push(Math.sqrt(bestLinear));
    perceptual.push(Math.sqrt(bestOklab));
  }
  const median = (values: number[]): number => values.sort((a, b) => a - b)[values.length >> 1];
  return { linear: median(linear), oklab: median(perceptual) };
}

function mapNearest(pixels: ArrayLike<number>, pixelCount: number, model: PaletteModel, transparentIndex: number, runTolerance = 0): Uint8Array {
  const out = new Uint8Array(pixelCount);
  if (pixelCount >= GRID_MIN_PIXELS) model.tree.enableGrid();
  const lab = new Float64Array(RGB_STRIDE);
  const keepsRuns = runTolerance > 0;
  const distanceFactor = (1 + runTolerance) ** 2;
  let lastKey = -1;
  let lastIndex = 0;
  let previousIndex = -1;
  for (let p = 0; p < pixelCount; p += 1) {
    const i = p * RGBA_STRIDE;
    if (transparentIndex >= 0 && pixels[i + 3] < QUANT_ALPHA_THRESHOLD) {
      out[p] = transparentIndex;
      previousIndex = -1;
      continue;
    }
    const key = (pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2];
    if (key !== lastKey) {
      linearToOklab(SRGB_TO_LINEAR_TABLE[pixels[i]], SRGB_TO_LINEAR_TABLE[pixels[i + 1]], SRGB_TO_LINEAR_TABLE[pixels[i + 2]], lab, 0);
      lastIndex = model.tree.nearestIndex(lab[0], lab[1], lab[2], lastIndex);
      if (keepsRuns && previousIndex >= 0 && previousIndex !== lastIndex) {
        const at = previousIndex * RGB_STRIDE;
        const dx = lab[0] - model.oklab[at];
        const dy = lab[1] - model.oklab[at + 1];
        const dz = lab[2] - model.oklab[at + 2];
        if (dx * dx + dy * dy + dz * dz <= model.tree.lastDistance2 * distanceFactor) lastIndex = previousIndex;
      }
      lastKey = key;
    }
    out[p] = lastIndex;
    previousIndex = lastIndex;
  }
  return out;
}

function clampUnit(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * A palette that does not surround the picture's colours (four greys for a colour picture) leaves residuals
 * that diffusion would grow without bound; a residual beyond this share of full scale is cut to it.
 */
const MAX_DIFFUSED_ERROR = 1;
/**
 * Share of each residual that is passed on. Full diffusion (1.0) conserves light exactly but adds noise that
 * lowers PSNR; 0.9 sits where the result is both closer than ImageMagick's Floyd-Steinberg on PSNR (+0.1 to
 * +4.5 dB on five test pictures, against -1.1 to +1.4 dB at 1.0) and on mean Delta E_OK (0.69 to 0.84 times
 * its). The area average of a flat region still lands within 0.03 of the source light.
 */
const FS_ERROR_DAMPING = 0.9;
function diffusedError(error: number): number {
  if (error > MAX_DIFFUSED_ERROR) return MAX_DIFFUSED_ERROR * FS_ERROR_DAMPING;
  if (error < -MAX_DIFFUSED_ERROR) return -MAX_DIFFUSED_ERROR * FS_ERROR_DAMPING;
  return error * FS_ERROR_DAMPING;
}

/** Floyd-Steinberg weights (7, 3, 5, 1) / 16 of one channel's error: ahead on this row, behind/below/ahead on the next. */
function diffuse(
  error: number,
  channel: number,
  current: Float32Array,
  following: Float32Array,
  forwardNeighbour: number,
  backwardNeighbour: number,
  here: number
): void {
  current[forwardNeighbour + channel] += (error * 7) / 16;
  following[backwardNeighbour + channel] += (error * 3) / 16;
  following[here + channel] += (error * 5) / 16;
  following[forwardNeighbour + channel] += error / 16;
}

/** Serpentine Floyd-Steinberg error diffusion in linear light. */
function mapFloydSteinberg(pixels: ArrayLike<number>, width: number, height: number, model: PaletteModel, transparentIndex: number): Uint8Array {
  const out = new Uint8Array(width * height);
  if (width * height >= GRID_MIN_PIXELS) model.tree.enableGrid();
  // Error rows carry a one-pixel margin on each side so the kernel needs no bounds checks.
  let current = new Float32Array((width + 2) * RGB_STRIDE);
  let following = new Float32Array((width + 2) * RGB_STRIDE);
  const lab = new Float64Array(RGB_STRIDE);
  let hint = 0;
  for (let y = 0; y < height; y += 1) {
    const forward = (y & 1) === 0;
    const direction = forward ? 1 : -1;
    following.fill(0);
    for (let step = 0; step < width; step += 1) {
      const x = forward ? step : width - 1 - step;
      const p = y * width + x;
      const i = p * RGBA_STRIDE;
      if (transparentIndex >= 0 && pixels[i + 3] < QUANT_ALPHA_THRESHOLD) {
        out[p] = transparentIndex;
        continue;
      }
      const e = (x + 1) * RGB_STRIDE;
      // The error is measured from the unclamped value, so none of it is lost where the diffusion pushes a
      // colour out of gamut; the palette search sees the colour clipped to the gamut.
      const r = SRGB_TO_LINEAR_TABLE[pixels[i]] + current[e];
      const g = SRGB_TO_LINEAR_TABLE[pixels[i + 1]] + current[e + 1];
      const b = SRGB_TO_LINEAR_TABLE[pixels[i + 2]] + current[e + 2];
      linearToOklab(clampUnit(r), clampUnit(g), clampUnit(b), lab, 0);
      hint = model.tree.nearestIndex(lab[0], lab[1], lab[2], hint, y > 0 ? out[p - width] : -1);
      out[p] = hint;
      const q = hint * RGB_STRIDE;
      const forwardNeighbour = (x + 1 + direction) * RGB_STRIDE;
      const backwardNeighbour = (x + 1 - direction) * RGB_STRIDE;
      diffuse(diffusedError(r - model.linear[q]), 0, current, following, forwardNeighbour, backwardNeighbour, e);
      diffuse(diffusedError(g - model.linear[q + 1]), 1, current, following, forwardNeighbour, backwardNeighbour, e);
      diffuse(diffusedError(b - model.linear[q + 2]), 2, current, following, forwardNeighbour, backwardNeighbour, e);
    }
    const swap = current;
    current = following;
    following = swap;
  }
  return out;
}

/** Hilbert-curve coordinates of the index d on an n x n grid (n a power of two). */
function hilbertToXy(n: number, d: number, out: Int32Array): void {
  let t = d;
  let x = 0;
  let y = 0;
  for (let s = 1; s < n; s <<= 1) {
    const rx = 1 & (t >> 1);
    const ry = 1 & (t ^ rx);
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      const swap = x;
      x = y;
      y = swap;
    }
    x += s * rx;
    y += s * ry;
    t >>= 2;
  }
  out[0] = x;
  out[1] = y;
}

/** Hilbert-curve Riemersma error diffusion in Oklab, with a 16-entry exponentially decaying error queue. */
function mapRiemersma(pixels: ArrayLike<number>, width: number, height: number, model: PaletteModel, transparentIndex: number): Uint8Array {
  const out = new Uint8Array(width * height);
  const ratio = Math.pow(16, -1 / (RIEMERSMA_QUEUE_SIZE - 1));
  const weights = new Float64Array(RIEMERSMA_QUEUE_SIZE);
  let weightSum = 0;
  for (let i = 0; i < RIEMERSMA_QUEUE_SIZE; i += 1) {
    weights[i] = Math.pow(ratio, i);
    weightSum += weights[i];
  }
  for (let i = 0; i < RIEMERSMA_QUEUE_SIZE; i += 1) weights[i] /= weightSum;
  const queue = new Float64Array(RIEMERSMA_QUEUE_SIZE * RGB_STRIDE);
  let head = 0;
  const lab = new Float64Array(RGB_STRIDE);
  const xy = new Int32Array(2);
  let side = 1;
  while (side < Math.max(width, height)) side <<= 1;
  let hint = 0;
  for (let d = 0; d < side * side; d += 1) {
    hilbertToXy(side, d, xy);
    const x = xy[0];
    const y = xy[1];
    if (x >= width || y >= height) continue;
    const p = y * width + x;
    const i = p * RGBA_STRIDE;
    if (transparentIndex >= 0 && pixels[i + 3] < QUANT_ALPHA_THRESHOLD) {
      out[p] = transparentIndex;
      continue;
    }
    linearToOklab(SRGB_TO_LINEAR_TABLE[pixels[i]], SRGB_TO_LINEAR_TABLE[pixels[i + 1]], SRGB_TO_LINEAR_TABLE[pixels[i + 2]], lab, 0);
    let eL = 0;
    let eA = 0;
    let eB = 0;
    for (let k = 0; k < RIEMERSMA_QUEUE_SIZE; k += 1) {
      const slot = ((head + k) % RIEMERSMA_QUEUE_SIZE) * RGB_STRIDE;
      eL += weights[k] * queue[slot];
      eA += weights[k] * queue[slot + 1];
      eB += weights[k] * queue[slot + 2];
    }
    const L = Math.max(0, Math.min(1, lab[0] + eL));
    const a = lab[1] + eA;
    const b = lab[2] + eB;
    hint = model.tree.nearestIndex(L, a, b, hint);
    const q = hint * RGB_STRIDE;
    out[p] = hint;
    head = (head + RIEMERSMA_QUEUE_SIZE - 1) % RIEMERSMA_QUEUE_SIZE;
    const slot = head * RGB_STRIDE;
    queue[slot] = L - model.oklab[q];
    queue[slot + 1] = a - model.oklab[q + 1];
    queue[slot + 2] = b - model.oklab[q + 2];
  }
  return out;
}

/** Ordered dithering with the void-and-cluster mask, the threshold applied in linear light. */
function mapBlueNoise(pixels: ArrayLike<number>, width: number, height: number, model: PaletteModel, transparentIndex: number): Uint8Array {
  const out = new Uint8Array(width * height);
  const mask = blueNoiseCentred();
  const amplitude = BLUE_NOISE_STRENGTH * paletteSpacing(model).linear;
  const lab = new Float64Array(RGB_STRIDE);
  const channel = new Float64Array(RGB_STRIDE);
  let hint = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = y * width + x;
      const i = p * RGBA_STRIDE;
      if (transparentIndex >= 0 && pixels[i + 3] < QUANT_ALPHA_THRESHOLD) {
        out[p] = transparentIndex;
        continue;
      }
      for (let d = 0; d < RGB_STRIDE; d += 1) {
        const mx = (x + BLUE_NOISE_OFFSETS[d][0]) % BLUE_NOISE_SIDE;
        const my = (y + BLUE_NOISE_OFFSETS[d][1]) % BLUE_NOISE_SIDE;
        const noise = mask[my * BLUE_NOISE_SIDE + mx] * amplitude;
        channel[d] = Math.min(1, Math.max(0, SRGB_TO_LINEAR_TABLE[pixels[i + d]] + noise));
      }
      linearToOklab(channel[0], channel[1], channel[2], lab, 0);
      hint = model.tree.nearestIndex(lab[0], lab[1], lab[2], hint);
      out[p] = hint;
    }
  }
  return out;
}

/**
 * Quantizes RGBA pixels to a palette of at most `maxColors` colours and maps every pixel to it. Throws
 * ConversionFailedError for a raster that is not `width` x `height` RGBA bytes.
 */
export function quantizeImage(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  maxColors: number = QUANT_MAX_COLORS,
  options: QuantizeOptions = {}
): IndexedImage {
  assertRaster(pixels, width, height);
  const pixelCount = width * height;
  const keepsTransparency = options.transparency === 'threshold';
  let hasTransparent = false;
  if (keepsTransparency) {
    for (let p = 0; p < pixelCount; p += 1) {
      if (pixels[p * RGBA_STRIDE + 3] < QUANT_ALPHA_THRESHOLD) {
        hasTransparent = true;
        break;
      }
    }
  }
  // A transparent index takes one of the slots, so the opaque palette is one colour smaller.
  const opaqueColours = Math.max(1, clampColourCount(maxColors) - (hasTransparent ? 1 : 0));
  const opaque = buildPalette(pixels, pixelCount, opaqueColours, hasTransparent);
  const opaqueSize = opaque.length / RGB_STRIDE;
  const transparentIndex = hasTransparent ? opaqueSize : -1;
  const palette = new Uint8Array((opaqueSize + (hasTransparent ? 1 : 0)) * RGB_STRIDE);
  palette.set(opaque);
  const indices = mapToPalette(pixels, width, height, opaque, opaqueSize, options.dither ?? 'none', transparentIndex, options.runTolerance);
  return { palette, paletteSize: palette.length / RGB_STRIDE, indices, transparentIndex };
}

/**
 * Maps every pixel of an RGBA raster to the nearest colour of a given palette (r, g, b triples, `paletteSize`
 * of them) in Oklab, dithered as asked. With `transparentIndex` set, pixels below `QUANT_ALPHA_THRESHOLD` alpha
 * take that index and take no part in the dither.
 */
export function mapToPalette(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  palette: Uint8Array,
  paletteSize: number,
  dither: DitherKind = 'none',
  transparentIndex: number = -1,
  runTolerance: number = 0
): Uint8Array {
  assertRaster(pixels, width, height);
  if (!Number.isInteger(paletteSize) || paletteSize < 1 || paletteSize > QUANT_MAX_COLORS || palette.length < paletteSize * RGB_STRIDE) {
    throw new ConversionFailedError(`A palette holds 1 to ${QUANT_MAX_COLORS} colours; got ${paletteSize}.`);
  }
  const model = modelOf(palette, paletteSize);
  if (dither === 'floyd-steinberg') return mapFloydSteinberg(pixels, width, height, model, transparentIndex);
  if (dither === 'riemersma') return mapRiemersma(pixels, width, height, model, transparentIndex);
  if (dither === 'blue-noise') return mapBlueNoise(pixels, width, height, model, transparentIndex);
  return mapNearest(pixels, width * height, model, transparentIndex, runTolerance);
}

function paletteColours(image: IndexedImage): RgbColor[] {
  const colours: RgbColor[] = [];
  for (let i = 0; i < image.paletteSize; i += 1) {
    colours.push({ r: image.palette[i * RGB_STRIDE], g: image.palette[i * RGB_STRIDE + 1], b: image.palette[i * RGB_STRIDE + 2] });
  }
  return colours;
}

/** Oklab palette of at most `maxColors` colours for the RGBA pixels. */
export function quantizePaletteOklab(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  maxColors: number = QUANT_MAX_COLORS
): RgbColor[] {
  if (width * height === 0) return [{ r: 0, g: 0, b: 0, a: BYTE_MAX }];
  return paletteColours(quantizeImage(pixels, width, height, maxColors, { dither: 'none' })).map((c) => ({ ...c, a: BYTE_MAX }));
}

/** Hilbert space-filling curve coordinates for an arbitrary width x height image. */
export function generateHilbertCurveOrder(width: number, height: number): { x: number; y: number }[] {
  if (width <= 0 || height <= 0) return [];
  let side = 1;
  while (side < Math.max(width, height)) side <<= 1;
  const result: { x: number; y: number }[] = [];
  const xy = new Int32Array(2);
  for (let d = 0; d < side * side; d += 1) {
    hilbertToXy(side, d, xy);
    if (xy[0] < width && xy[1] < height) result.push({ x: xy[0], y: xy[1] });
  }
  return result;
}

/** Riemersma error-diffusion dithering of RGBA pixels to a given palette. */
export function riemersmaDither(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  palette: RgbColor[]
): { indexed: Uint8Array; rgba: Uint8ClampedArray } {
  const pixelCount = width * height;
  if (palette.length === 0 || pixelCount === 0) {
    return { indexed: new Uint8Array(pixelCount), rgba: new Uint8ClampedArray(pixelCount * RGBA_STRIDE) };
  }
  const packed = new Uint8Array(palette.length * RGB_STRIDE);
  palette.forEach((c, i) => packed.set([c.r, c.g, c.b], i * RGB_STRIDE));
  const indexed = mapRiemersma(pixels, width, height, modelOf(packed, palette.length), -1);
  return { indexed, rgba: rgbaOf(pixels, indexed, packed, pixelCount) };
}

function rgbaOf(source: ArrayLike<number>, indexed: Uint8Array, palette: Uint8Array, pixelCount: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(pixelCount * RGBA_STRIDE);
  for (let p = 0; p < pixelCount; p += 1) {
    const q = indexed[p] * RGB_STRIDE;
    rgba[p * RGBA_STRIDE] = palette[q];
    rgba[p * RGBA_STRIDE + 1] = palette[q + 1];
    rgba[p * RGBA_STRIDE + 2] = palette[q + 2];
    rgba[p * RGBA_STRIDE + 3] = source[p * RGBA_STRIDE + 3] !== undefined ? source[p * RGBA_STRIDE + 3] : BYTE_MAX;
  }
  return rgba;
}

/**
 * Quantizes RGBA image data and maps it to the palette. `dither` true uses serpentine Floyd-Steinberg in linear
 * light unless `method` names another; the returned `rgba` keeps each pixel's own alpha.
 */
export function applyOklabQuantizationAndDither(
  imageData: { data: Uint8ClampedArray | Uint8Array; width: number; height: number },
  maxColors: number = QUANT_MAX_COLORS,
  dither: boolean = true,
  method: Exclude<DitherKind, 'none'> = 'floyd-steinberg'
): {
  palette: RgbColor[];
  indexed: Uint8Array;
  rgba: Uint8ClampedArray;
} {
  const { data, width, height } = imageData;
  const image = quantizeImage(data, width, height, maxColors, { dither: dither ? method : 'none' });
  return {
    palette: paletteColours(image),
    indexed: image.indices,
    rgba: rgbaOf(data, image.indices, image.palette, width * height),
  };
}
