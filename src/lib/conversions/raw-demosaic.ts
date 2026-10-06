/**
 * Flat-plane AHD and AMaZE Bayer demosaicing.
 *
 * The frame is walked in square tiles. Each tile is copied once, with a mirrored border, into small flat typed-array
 * planes that are reused for every tile (scratch memory is a few hundred kilobytes, independent of the frame size, and
 * stays in the CPU cache). Every stage then runs over its region of the tile with fixed index offsets: no closure,
 * tuple or object is created per pixel, and the CFA layout is resolved once into row/column parity so the inner loops
 * hold no per-pixel channel branch.
 *
 * Tiling does not change the result. The Bayer grid is reflected about a pixel (x -> -x, x -> 2(n-1)-x), which keeps the
 * CFA parity, and every stage is a mirror-symmetric stencil, so a stage computed on a reflected border equals the
 * reflection of the stage output. A tile therefore equals the same pixels of a whole-frame run as long as the border
 * is at least the combined reach of the stages (TILE_HALO).
 *
 * The arithmetic follows the reference implementation of the two algorithms in image.ts operation by operation
 * (same operand order, same float32 rounding points), so AMaZE is bit-identical to it. AHD differs in how the
 * homogeneity decision is computed, and only in the last bits: CIELab comes from a Hermite-interpolated
 * linearisation table and a table-seeded series cube root (each within 2e-14 relative, far below the float32 rounding the
 * reference applies to its Lab planes), the 3-D distance uses sqrt instead of Math.hypot, and the
 * window sums are accumulated pair by pair (each symmetric pair once) rather than in raster order. These can change a
 * decision only when the two directions score within about 1e-14 of each other; identical neighbourhoods still tie
 * exactly. On the 21 MP and 3 MP real frames and every golden the output is bit-identical.
 *
 * AHD: Hirakawa and Parks, "Adaptive homogeneity-directed demosaicing algorithm", IEEE Trans. Image Processing 14(3), 2005.
 */
import { InvalidRawSensorError } from '../types';
import { RAW_DECODE_MAX_PIXELS } from './raw-formats';
import {
  applyIec61966SrgbGamma,
  resolveBayerColorMatrix,
  validateBayerSensorCalibration,
  type BayerSensorData,
} from './image';

export interface DemosaicOptions {
  /** Edge of the square processing tile in pixels (even, DEMOSAIC_MIN_TILE..DEMOSAIC_MAX_TILE). */
  tileSize?: number;
  /** When false the gamma-encoded 8-bit RGB buffer is not produced and `data` is empty. Default true. */
  buildRgb8?: boolean;
}

export interface DemosaicResult {
  /** Interleaved 8-bit RGB after white balance, colour matrix and (optional) sRGB gamma; empty when buildRgb8 is false. */
  data: Buffer;
  /** Interleaved linear demosaiced RGB, normalised to [0, 1] before white balance and colour transforms. */
  floatData: Float32Array;
  width: number;
  height: number;
}

export const DEMOSAIC_DEFAULT_TILE = 128;
export const DEMOSAIC_MIN_TILE = 16;
export const DEMOSAIC_MAX_TILE = 1024;

/**
 * Border copied around a tile. Reach of the longest stage chain, counted back from an output pixel:
 *   AMaZE: 3x3 median (1) + diff interpolation (1) + green selection window (2) + directional estimate (2) = 6.
 *   AHD:   3x3 median (1) + homogeneity window (2) + R/B reconstruction (1) + green estimate (2) = 6.
 * It must be even so that scratch column parity equals frame column parity.
 */
const TILE_HALO = 6;

const CFA_PATTERNS = new Set(['RGGB', 'BGGR', 'GRBG', 'GBRG']);
const BYTE_RANGE = 255;
const BYTES_PER_16_BIT_SAMPLE = 2;
const CHANNELS = 3;
const AMAZE_SCAN_SAMPLES = 10000;
const AMAZE_BITS_14_MAX = 4095;
const AMAZE_BITS_12_MAX = 1023;
const AMAZE_BITS_10_MAX = 255;
const FULL_16_BIT_MAX = 65535;
const WINDOW_RADIUS = 2;
const WINDOW_SIDE = 2 * WINDOW_RADIUS + 1;
const WINDOW_AREA = WINDOW_SIDE * WINDOW_SIDE;
const FCS_MIN_PASSES = 1;
const FCS_MAX_PASSES = 5;
const FCS_WINDOW_SIDE = 5;
const FCS_WINDOW_AREA = FCS_WINDOW_SIDE * FCS_WINDOW_SIDE;
const FCS_WINDOW_MEDIAN = 12;

// AMaZE direction selection: a direction wins when its homogeneity exceeds the other by this factor.
const AMAZE_DIRECTION_BIAS = 1.15;
const AMAZE_BLEND_FALLBACK_WEIGHT = 0.5;

// CIE Lab constants of the AHD homogeneity metric (sRGB primaries, D65 white).
const SRGB_KNEE = 0.04045;
const SRGB_OFFSET = 0.055;
const SRGB_SCALE = 1.055;
const SRGB_TOE_SLOPE = 12.92;
const SRGB_EXPONENT = 2.4;
const XYZ_RX = 0.4124564;
const XYZ_GX = 0.3575761;
const XYZ_BX = 0.1804375;
const XYZ_RY = 0.2126729;
const XYZ_GY = 0.7151522;
const XYZ_BY = 0.072175;
const XYZ_RZ = 0.0193339;
const XYZ_GZ = 0.119192;
const XYZ_BZ = 0.9503041;
const WHITE_X = 0.95047;
const WHITE_Z = 1.08883;
const LAB_EPSILON = 0.008856;
const LAB_KAPPA = 7.787;
const LAB_OFFSET = 16.0 / 116.0;
const LAB_L_SCALE = 116.0;
const LAB_L_OFFSET = 16.0;
const LAB_A_SCALE = 500.0;
const LAB_B_SCALE = 200.0;

// Linearisation table: values and slopes at sample values 0..LIN_LUT_MAX in 1/LIN_LUT_STEPS increments, cubic Hermite
// interpolated (relative error below 1e-14, six orders under the rounding of the float32 CIELab planes).
const LIN_LUT_MAX = 384;
const LIN_LUT_STEPS = 32;
const LIN_LUT_SIZE = LIN_LUT_MAX * LIN_LUT_STEPS + 2;
const LIN_LUT_STEP = 1 / LIN_LUT_STEPS;
/** The only segment where the transfer curve changes branch; it is evaluated exactly. */
const LIN_KNEE_SEGMENT = Math.floor(SRGB_KNEE * BYTE_RANGE * LIN_LUT_STEPS);

// Cube root: table of the mantissa root (CBRT_MANTISSA_BITS bits) times the root of the power of two as the seed y, then
// cbrt(t) = y * (1 + u)^(1/3) with u = t / y^3 - 1 (|u| < 2e-4) from the binomial series up to u^3 (error below 1e-17).
const CBRT_C1 = 1 / 3;
const CBRT_C2 = -1 / 9;
const CBRT_C3 = 5 / 81;
const CBRT_MANTISSA_BITS = 12;
const CBRT_MANTISSA_SHIFT = 20 - CBRT_MANTISSA_BITS;
const CBRT_MANTISSA_COUNT = 1 << CBRT_MANTISSA_BITS;
const CBRT_EXPONENT_BIAS = 1023;
const CBRT_EXPONENT_MIN = -16;
const CBRT_EXPONENT_MAX = 15;
const CBRT_FAST_MAX = 1 << CBRT_EXPONENT_MAX;
const F64_EXPONENT_MASK = 0x7ff;
const F64_HIGH_MANTISSA_MASK = 0xfffff;
const F64_ONE_HIGH_WORD = 0x3ff00000;

// 8-bit sRGB encoding by threshold table: the coarse index has GAMMA_COARSE_CELLS cells over [0, 1].
const GAMMA_COARSE_CELLS = 4096;
const GAMMA_BISECTION_STEPS = 80;
const GAMMA_LEVELS = 255;

/** Offsets of the 5x5 window that are 'ahead' of a pixel in raster order: one representative of each +/- pair. */
const PAIR_DX = new Int8Array([1, 2, -2, -1, 0, 1, 2, -2, -1, 0, 1, 2]);
const PAIR_DY = new Int8Array([0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2]);
const PAIR_OFFSET_COUNT = PAIR_DX.length;

/** Half-pixel weights of the AMaZE and AHD 5x5 windows, row-major from (-2,-2). Built with the reference expressions. */
const AMAZE_SPATIAL_WEIGHT = new Float64Array(WINDOW_AREA);
const AHD_SPATIAL_WEIGHT = new Float64Array(WINDOW_AREA);
for (let dy = -WINDOW_RADIUS; dy <= WINDOW_RADIUS; dy += 1) {
  for (let dx = -WINDOW_RADIUS; dx <= WINDOW_RADIUS; dx += 1) {
    const k = (dy + WINDOW_RADIUS) * WINDOW_SIDE + dx + WINDOW_RADIUS;
    AMAZE_SPATIAL_WEIGHT[k] = 1.0 / (1.0 + Math.hypot(dx, dy));
    AHD_SPATIAL_WEIGHT[k] = 1.0 / (1.0 + (dx * dx + dy * dy) * 0.25);
  }
}

function exactLinear(c: number): number {
  const v = c / BYTE_RANGE;
  return v > SRGB_KNEE ? Math.pow((v + SRGB_OFFSET) / SRGB_SCALE, SRGB_EXPONENT) : v / SRGB_TOE_SLOPE;
}

/** d/dc of exactLinear, for c given in sample units. */
function exactLinearSlope(c: number): number {
  const v = c / BYTE_RANGE;
  if (v <= SRGB_KNEE) return 1 / (SRGB_TOE_SLOPE * BYTE_RANGE);
  return (SRGB_EXPONENT * Math.pow((v + SRGB_OFFSET) / SRGB_SCALE, SRGB_EXPONENT - 1)) / (SRGB_SCALE * BYTE_RANGE);
}

const LIN_LUT = new Float64Array(LIN_LUT_SIZE);
/** Slope times the grid step, as the Hermite form uses it. */
const LIN_LUT_SLOPE = new Float64Array(LIN_LUT_SIZE);
for (let i = 0; i < LIN_LUT_SIZE; i += 1) {
  LIN_LUT[i] = exactLinear(i / LIN_LUT_STEPS);
  LIN_LUT_SLOPE[i] = exactLinearSlope(i / LIN_LUT_STEPS) * LIN_LUT_STEP;
}

const CBRT_MANTISSA = new Float64Array(CBRT_MANTISSA_COUNT);
for (let i = 0; i < CBRT_MANTISSA_COUNT; i += 1) CBRT_MANTISSA[i] = Math.cbrt(1 + (i + 0.5) / CBRT_MANTISSA_COUNT);
const CBRT_EXPONENT = new Float64Array(CBRT_EXPONENT_MAX - CBRT_EXPONENT_MIN + 1);
for (let e = CBRT_EXPONENT_MIN; e <= CBRT_EXPONENT_MAX; e += 1) CBRT_EXPONENT[e - CBRT_EXPONENT_MIN] = Math.cbrt(2 ** e);

const F64_VIEW = new Float64Array(1);
const U32_VIEW = new Uint32Array(F64_VIEW.buffer);
F64_VIEW[0] = 1;
const HIGH_WORD = U32_VIEW[1] === F64_ONE_HIGH_WORD ? 1 : 0;

/** Cube root of t in (LAB_EPSILON, CBRT_FAST_MAX): table seed plus one binomial-series correction. */
function fastCbrt(t: number): number {
  if (t >= CBRT_FAST_MAX) return Math.cbrt(t);
  F64_VIEW[0] = t;
  const high = U32_VIEW[HIGH_WORD];
  const exponent = ((high >>> 20) & F64_EXPONENT_MASK) - CBRT_EXPONENT_BIAS;
  const y = CBRT_MANTISSA[(high & F64_HIGH_MANTISSA_MASK) >>> CBRT_MANTISSA_SHIFT] * CBRT_EXPONENT[exponent - CBRT_EXPONENT_MIN];
  const u = t / (y * y * y) - 1;
  return y * (1 + u * (CBRT_C1 + u * (CBRT_C2 + u * CBRT_C3)));
}

/** sRGB-encoded sample value (0..255 scale) to linear light, by Hermite interpolation of a table. Exported for the accuracy test. */
export function linearizeSrgbSample(c: number): number {
  if (c >= LIN_LUT_MAX) return exactLinear(c);
  const pos = c * LIN_LUT_STEPS;
  const i = pos | 0;
  if (i === LIN_KNEE_SEGMENT) return exactLinear(c);
  const t = pos - i;
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * LIN_LUT[i] +
    (t3 - 2 * t2 + t) * LIN_LUT_SLOPE[i] +
    (3 * t2 - 2 * t3) * LIN_LUT[i + 1] +
    (t3 - t2) * LIN_LUT_SLOPE[i + 1]
  );
}

/** CIE Lab companding function f(t). Exported for the accuracy test. */
export function cieLabF(t: number): number {
  return t > LAB_EPSILON ? fastCbrt(t) : LAB_KAPPA * t + LAB_OFFSET;
}

function storeLab(r: number, g: number, b: number, lp: Float32Array, ap: Float32Array, bp: Float32Array, i: number): void {
  const rL = linearizeSrgbSample(r);
  const gL = linearizeSrgbSample(g);
  const bL = linearizeSrgbSample(b);
  const fx = cieLabF((XYZ_RX * rL + XYZ_GX * gL + XYZ_BX * bL) / WHITE_X);
  // The Y white is exactly 1, so dividing by it is the identity.
  const fy = cieLabF(XYZ_RY * rL + XYZ_GY * gL + XYZ_BY * bL);
  const fz = cieLabF((XYZ_RZ * rL + XYZ_GZ * gL + XYZ_BZ * bL) / WHITE_Z);
  lp[i] = LAB_L_SCALE * fy - LAB_L_OFFSET;
  ap[i] = LAB_A_SCALE * (fx - fy);
  bp[i] = LAB_B_SCALE * (fy - fz);
}

// ---------------------------------------------------------------------------------------------------------------------
// Medians (sorting networks: min/max only, no data-dependent branch)
// ---------------------------------------------------------------------------------------------------------------------

const SIGN_BIT_SHIFT = 31;
const MAGNITUDE_MASK = 0x7fffffff;

/**
 * 3x3 median of `src` over the rectangle [x0, x1) x [y0, y1) into `dst` (same layout, row stride S, one pixel of
 * neighbourhood readable around the rectangle). Each column of three is sorted once and shared by the three windows that
 * contain it; the median of nine is then the median of (largest of the column minima, median of the column medians,
 * smallest of the column maxima). The result is one of the nine inputs, as with a full sort.
 *
 * The comparisons run on integer keys: the IEEE-754 bit pattern with the magnitude bits inverted for negative values
 * orders exactly like the float total order (-0 below +0), and integer compares avoid the NaN and signed-zero handling
 * of Math.min / Math.max. `src` is converted in place and is not usable as floats afterwards.
 */
function median3x3(
  src: Float32Array,
  dst: Float32Array,
  S: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  colLo: Int32Array,
  colMid: Int32Array,
  colHi: Int32Array
): void {
  const sk = new Int32Array(src.buffer, src.byteOffset, src.length);
  const dk = new Int32Array(dst.buffer, dst.byteOffset, dst.length);
  for (let y = y0 - 1; y <= y1; y += 1) {
    const row = y * S;
    for (let x = x0 - 1; x <= x1; x += 1) {
      const bits = sk[row + x];
      sk[row + x] = bits ^ ((bits >> SIGN_BIT_SHIFT) & MAGNITUDE_MASK);
    }
  }
  for (let y = y0; y < y1; y += 1) {
    const row = y * S;
    for (let x = x0 - 1; x <= x1; x += 1) {
      const a = sk[row - S + x];
      const b = sk[row + x];
      const c = sk[row + S + x];
      const mn = a < b ? a : b;
      const mx = a < b ? b : a;
      colLo[x] = mn < c ? mn : c;
      const t = mn < c ? c : mn;
      colMid[x] = t < mx ? t : mx;
      colHi[x] = t < mx ? mx : t;
    }
    for (let x = x0; x < x1; x += 1) {
      let low = colLo[x - 1];
      const l1 = colLo[x];
      const l2 = colLo[x + 1];
      low = low > l1 ? low : l1;
      low = low > l2 ? low : l2;
      let high = colHi[x - 1];
      const h1 = colHi[x];
      const h2 = colHi[x + 1];
      high = high < h1 ? high : h1;
      high = high < h2 ? high : h2;
      const m0 = colMid[x - 1];
      const m1 = colMid[x];
      const m2 = colMid[x + 1];
      const lowMid = m0 < m1 ? m0 : m1;
      const highMid = m0 < m1 ? m1 : m0;
      const mid = highMid < m2 ? highMid : lowMid > m2 ? lowMid : m2;
      const lowest = low < mid ? low : mid;
      const highest = low < mid ? mid : low;
      const key = highest < high ? highest : lowest > high ? lowest : high;
      dk[row + x] = key ^ ((key >> SIGN_BIT_SHIFT) & MAGNITUDE_MASK);
    }
  }
}

/** Compare-exchange pairs of the 25-input median network (Devillard, after Smith); the median ends in element 12. */
const MEDIAN25_PAIRS = new Uint8Array([
  0, 1, 3, 4, 2, 4, 2, 3, 6, 7, 5, 7, 5, 6, 9, 10, 8, 10, 8, 9, 12, 13, 11, 13, 11, 12, 15, 16, 14, 16, 14, 15, 18, 19, 17, 19, 17, 18,
  21, 22, 20, 22, 20, 21, 23, 24, 2, 5, 3, 6, 0, 6, 0, 3, 4, 7, 1, 7, 1, 4, 11, 14, 8, 14, 8, 11, 12, 15, 9, 15, 9, 12, 13, 16, 10, 16,
  10, 13, 20, 23, 17, 23, 17, 20, 21, 24, 18, 24, 18, 21, 19, 22, 8, 17, 9, 18, 0, 18, 0, 9, 10, 19, 1, 19, 1, 10, 11, 20, 2, 20, 2, 11,
  12, 21, 3, 21, 3, 12, 13, 22, 4, 22, 4, 13, 14, 23, 5, 23, 5, 14, 15, 24, 6, 24, 6, 15, 7, 16, 7, 19, 13, 21, 15, 23, 7, 13, 7, 15, 1,
  9, 3, 11, 5, 17, 11, 17, 9, 17, 4, 10, 6, 12, 7, 14, 4, 6, 4, 7, 12, 14, 10, 14, 6, 7, 10, 12, 6, 10, 6, 17, 12, 17, 7, 17, 7, 10, 12,
  18, 7, 12, 10, 18, 12, 20, 10, 20, 10, 12,
]);

/** Median of the first 25 values of `w` (reorders them). Exported for the sort-based oracle in the unit test. */
export function medianOf25(w: Float32Array): number {
  for (let k = 0; k < MEDIAN25_PAIRS.length; k += 2) {
    const a = MEDIAN25_PAIRS[k];
    const b = MEDIAN25_PAIRS[k + 1];
    const lo = Math.min(w[a], w[b]);
    w[b] = Math.max(w[a], w[b]);
    w[a] = lo;
  }
  return w[FCS_WINDOW_MEDIAN];
}

// ---------------------------------------------------------------------------------------------------------------------
// Input handling
// ---------------------------------------------------------------------------------------------------------------------

type SampleKind = 'direct' | 'bytes16';

interface SensorInput {
  samples: ArrayLike<number>;
  kind: SampleKind;
}

interface CfaLayout {
  /** (x + y) parity of the green sites. */
  greenParity: number;
  /** Parity of the rows that hold the red sites (blue sits in the other rows). */
  redRowParity: number;
}

function resolveCfa(pattern: string): CfaLayout {
  return { greenParity: pattern[0] === 'G' ? 0 : 1, redRowParity: pattern.indexOf('R') >> 1 };
}

/** Parity-preserving symmetric reflection about the first and last pixel. */
function mirrorCoord(v: number, max: number): number {
  if (max <= 1) return 0;
  let c = v;
  while (c < 0 || c >= max) {
    c = c < 0 ? -c : 2 * (max - 1) - c;
  }
  return c;
}

function checkTileSize(options?: DemosaicOptions): number {
  const tile = options?.tileSize ?? DEMOSAIC_DEFAULT_TILE;
  if (!Number.isInteger(tile) || tile < DEMOSAIC_MIN_TILE || tile > DEMOSAIC_MAX_TILE || tile % 2 !== 0) {
    throw new InvalidRawSensorError(
      `Invalid demosaic tile size ${tile}: expected an even integer between ${DEMOSAIC_MIN_TILE} and ${DEMOSAIC_MAX_TILE}.`
    );
  }
  return tile;
}

function checkPixelBudget(width: number, height: number): void {
  if (width * height > RAW_DECODE_MAX_PIXELS) {
    throw new InvalidRawSensorError(`Sensor of ${width}x${height} pixels exceeds the ${RAW_DECODE_MAX_PIXELS} pixel demosaic limit.`);
  }
}

/** Per-parity (row & 1, column & 1) black level and range, indexed (rowParity << 1) | columnParity. */
interface Calibration {
  black: Float64Array;
  range: Float64Array;
}


/** Scratch shared by both engines: tile geometry, mirrored coordinate maps and one row of raw samples. */
interface TileFrame {
  width: number;
  height: number;
  rowMap: Int32Array;
  colMap: Int32Array;
  rowSamples: Float64Array;
}

function createTileFrame(width: number, height: number, tile: number): TileFrame {
  const maxSide = tile + 2 * TILE_HALO;
  return { width, height, rowMap: new Int32Array(maxSide), colMap: new Int32Array(maxSide), rowSamples: new Float64Array(maxSide) };
}

function loadRowSamples(input: SensorInput, rowBase: number, colMap: Int32Array, count: number, out: Float64Array): void {
  const src = input.samples;
  if (input.kind === 'bytes16') {
    for (let k = 0; k < count; k += 1) {
      const at = (rowBase + colMap[k]) * BYTES_PER_16_BIT_SAMPLE;
      out[k] = src[at] | (src[at + 1] << 8);
    }
  } else {
    for (let k = 0; k < count; k += 1) out[k] = src[rowBase + colMap[k]];
  }
}

/**
 * Copies the tile plus border of raw samples into `norm` as ((max(black, v) - black) / range) * 255, mirrored at the
 * frame edge. `norm` is float32 (AMaZE) or float64 (AHD): the store applies the rounding of the respective reference.
 */
function gatherNormalized(
  f: TileFrame,
  input: SensorInput,
  cal: Calibration,
  x0: number,
  y0: number,
  rows: number,
  cols: number,
  norm: Float32Array | Float64Array
): void {
  for (let k = 0; k < rows; k += 1) f.rowMap[k] = mirrorCoord(y0 - TILE_HALO + k, f.height);
  for (let k = 0; k < cols; k += 1) f.colMap[k] = mirrorCoord(x0 - TILE_HALO + k, f.width);
  const { black, range } = cal;
  for (let sy = 0; sy < rows; sy += 1) {
    loadRowSamples(input, f.rowMap[sy] * f.width, f.colMap, cols, f.rowSamples);
    const parityRow = (sy & 1) << 1;
    const out = sy * cols;
    for (let sx = 0; sx < cols; sx += 1) {
      const idx = parityRow | (sx & 1);
      const bl = black[idx];
      norm[out + sx] = ((Math.max(bl, f.rowSamples[sx]) - bl) / range[idx]) * BYTE_RANGE;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Output stage: float planes, white balance, colour matrix, sRGB encoding
// ---------------------------------------------------------------------------------------------------------------------

interface GammaTables {
  /** thresholds[k] is the smallest linear value whose reference 8-bit encoding is at least k (index 0 unused). */
  thresholds: Float64Array;
  /** coarse[j] is the encoding of j / GAMMA_COARSE_CELLS (a lower bound inside cell j). */
  coarse: Uint8Array;
}

let gammaTables: GammaTables | null = null;

/** Built on first use: it calls the reference transfer function of image.ts, which is not initialised at module load. */
function getGammaTables(): GammaTables {
  if (gammaTables) return gammaTables;
  const thresholds = new Float64Array(GAMMA_LEVELS + 2);
  const code = (x: number): number => Math.round(applyIec61966SrgbGamma(x) * BYTE_RANGE);
  for (let k = 1; k <= GAMMA_LEVELS; k += 1) {
    let lo = 0;
    let hi = 1;
    for (let step = 0; step < GAMMA_BISECTION_STEPS; step += 1) {
      const mid = (lo + hi) / 2;
      if (code(mid) >= k) hi = mid;
      else lo = mid;
    }
    thresholds[k] = hi;
  }
  thresholds[GAMMA_LEVELS + 1] = Infinity;
  const coarse = new Uint8Array(GAMMA_COARSE_CELLS + 1);
  let level = 0;
  for (let j = 0; j <= GAMMA_COARSE_CELLS; j += 1) {
    while (level < GAMMA_LEVELS && thresholds[level + 1] <= j / GAMMA_COARSE_CELLS) level += 1;
    coarse[j] = level;
  }
  gammaTables = { thresholds, coarse };
  return gammaTables;
}

function encodeSrgb8(x: number, thresholds: Float64Array, coarse: Uint8Array): number {
  if (!(x > 0)) return 0;
  if (x >= 1) return GAMMA_LEVELS;
  let level = coarse[(x * GAMMA_COARSE_CELLS) | 0];
  while (x >= thresholds[level + 1]) level += 1;
  return level;
}

interface OutputStage {
  width: number;
  floatOut: Float32Array;
  /** null when the 8-bit buffer is not requested. */
  rgb8: Buffer | null;
  wbR: number;
  wbG: number;
  wbB: number;
  matrix: readonly number[] | null;
  gamma: boolean;
  /** AHD stores the reconstructed red and blue in float32 planes before output; AMaZE keeps them in double. */
  roundToFloat32: boolean;
}

const IDENTITY_MATRIX: readonly number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function createOutputStage(
  sensor: BayerSensorData,
  options: DemosaicOptions | undefined,
  wb: readonly number[],
  gamma: boolean,
  roundToFloat32: boolean
): OutputStage {
  const { width, height } = sensor;
  const buildRgb8 = options?.buildRgb8 !== false;
  return {
    width,
    floatOut: new Float32Array(width * height * CHANNELS),
    rgb8: buildRgb8 ? Buffer.alloc(width * height * CHANNELS) : null,
    wbR: wb[0],
    wbG: wb[1],
    wbB: wb[2],
    matrix: sensor.colorMatrix || resolveBayerColorMatrix(sensor),
    gamma,
    roundToFloat32,
  };
}

/** Writes one tile (or the whole frame) of reconstructed colour to the output buffers. */
function emitRegion(
  o: OutputStage,
  g: Float32Array,
  dr: Float32Array,
  db: Float32Array,
  base: number,
  stride: number,
  x0: number,
  y0: number,
  tw: number,
  th: number
): void {
  const { floatOut, rgb8, wbR, wbG, wbB, matrix, gamma, roundToFloat32 } = o;
  const tables = rgb8 !== null && gamma ? getGammaTables() : null;
  const thresholds = tables ? tables.thresholds : new Float64Array(0);
  const coarse = tables ? tables.coarse : new Uint8Array(0);
  const hasMatrix = matrix !== null;
  const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = matrix ?? IDENTITY_MATRIX;
  for (let ly = 0; ly < th; ly += 1) {
    let src = base + ly * stride;
    let dst = ((y0 + ly) * o.width + x0) * CHANNELS;
    for (let lx = 0; lx < tw; lx += 1) {
      const gv = g[src];
      let r = Math.max(0, gv + dr[src]);
      let b = Math.max(0, gv + db[src]);
      if (roundToFloat32) {
        r = Math.fround(r);
        b = Math.fround(b);
      }
      floatOut[dst] = r / BYTE_RANGE;
      floatOut[dst + 1] = gv / BYTE_RANGE;
      floatOut[dst + 2] = b / BYTE_RANGE;
      if (rgb8 !== null) {
        let rLin = (r * wbR) / BYTE_RANGE;
        let gLin = (gv * wbG) / BYTE_RANGE;
        let bLin = (b * wbB) / BYTE_RANGE;
        if (hasMatrix) {
          const rT = m0 * rLin + m1 * gLin + m2 * bLin;
          const gT = m3 * rLin + m4 * gLin + m5 * bLin;
          const bT = m6 * rLin + m7 * gLin + m8 * bLin;
          rLin = Math.max(0, rT);
          gLin = Math.max(0, gT);
          bLin = Math.max(0, bT);
        }
        if (gamma) {
          rgb8[dst] = encodeSrgb8(rLin, thresholds, coarse);
          rgb8[dst + 1] = encodeSrgb8(gLin, thresholds, coarse);
          rgb8[dst + 2] = encodeSrgb8(bLin, thresholds, coarse);
        } else {
          rgb8[dst] = Math.max(0, Math.min(BYTE_RANGE, Math.round(rLin * BYTE_RANGE)));
          rgb8[dst + 1] = Math.max(0, Math.min(BYTE_RANGE, Math.round(gLin * BYTE_RANGE)));
          rgb8[dst + 2] = Math.max(0, Math.min(BYTE_RANGE, Math.round(bLin * BYTE_RANGE)));
        }
      }
      src += 1;
      dst += CHANNELS;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// False colour suppression: 5x5 median of the colour-difference planes, whole frame
// ---------------------------------------------------------------------------------------------------------------------

function medianFilter5x5(src: Float32Array, dst: Float32Array, width: number, height: number, rows: Float32Array[], win: Float32Array): void {
  for (let y = 0; y < height; y += 1) {
    for (let dy = 0; dy < FCS_WINDOW_SIDE; dy += 1) {
      const rowBuf = rows[dy];
      const from = mirrorCoord(y + dy - WINDOW_RADIUS, height) * width;
      rowBuf.set(src.subarray(from, from + width), WINDOW_RADIUS);
      for (let k = 1; k <= WINDOW_RADIUS; k += 1) {
        rowBuf[WINDOW_RADIUS - k] = src[from + mirrorCoord(-k, width)];
        rowBuf[WINDOW_RADIUS + width - 1 + k] = src[from + mirrorCoord(width - 1 + k, width)];
      }
    }
    const out = y * width;
    for (let x = 0; x < width; x += 1) {
      let q = 0;
      for (let dy = 0; dy < FCS_WINDOW_SIDE; dy += 1) {
        const rowBuf = rows[dy];
        for (let dx = 0; dx < FCS_WINDOW_SIDE; dx += 1) {
          win[q] = rowBuf[x + dx];
          q += 1;
        }
      }
      dst[out + x] = medianOf25(win);
    }
  }
}

/** Same result as applyFalseColorSuppression in image.ts (passes rounded and clamped to 1..5). */
function suppressFalseColor(
  red: Float32Array,
  blue: Float32Array,
  width: number,
  height: number,
  passes: number
): { red: Float32Array; blue: Float32Array } {
  const count = Math.max(FCS_MIN_PASSES, Math.min(FCS_MAX_PASSES, Math.round(passes)));
  const rows: Float32Array[] = [];
  for (let k = 0; k < FCS_WINDOW_SIDE; k += 1) rows.push(new Float32Array(width + 2 * WINDOW_RADIUS));
  const win = new Float32Array(FCS_WINDOW_AREA);
  const pixels = width * height;
  const bufR = [new Float32Array(pixels), count > 1 ? new Float32Array(pixels) : red];
  const bufB = [new Float32Array(pixels), count > 1 ? new Float32Array(pixels) : blue];
  let curR = red;
  let curB = blue;
  for (let p = 0; p < count; p += 1) {
    const dstR = bufR[p % 2];
    const dstB = bufB[p % 2];
    medianFilter5x5(curR, dstR, width, height, rows, win);
    medianFilter5x5(curB, dstB, width, height, rows, win);
    curR = dstR;
    curB = dstB;
  }
  return { red: curR, blue: curB };
}

// ---------------------------------------------------------------------------------------------------------------------
// Tile driver
// ---------------------------------------------------------------------------------------------------------------------

interface TileEngine {
  /** Planes holding the finished tile at [TILE_HALO, TILE_HALO] with the tile's row stride. */
  green: Float32Array;
  redDiff: Float32Array;
  blueDiff: Float32Array;
  compute(x0: number, y0: number, tw: number, th: number): void;
}

function copyTile(dst: Float32Array, dstWidth: number, src: Float32Array, base: number, stride: number, x0: number, y0: number, tw: number, th: number): void {
  for (let ly = 0; ly < th; ly += 1) {
    const from = base + ly * stride;
    dst.set(src.subarray(from, from + tw), (y0 + ly) * dstWidth + x0);
  }
}

function runFrame(width: number, height: number, tile: number, engine: TileEngine, out: OutputStage, falseColorPasses: number): void {
  const pixels = width * height;
  const suppress = falseColorPasses > 0;
  const gFull = suppress ? new Float32Array(pixels) : null;
  const rFull = suppress ? new Float32Array(pixels) : null;
  const bFull = suppress ? new Float32Array(pixels) : null;
  for (let y0 = 0; y0 < height; y0 += tile) {
    const th = Math.min(tile, height - y0);
    for (let x0 = 0; x0 < width; x0 += tile) {
      const tw = Math.min(tile, width - x0);
      const stride = tw + 2 * TILE_HALO;
      const base = TILE_HALO * stride + TILE_HALO;
      engine.compute(x0, y0, tw, th);
      if (gFull && rFull && bFull) {
        copyTile(gFull, width, engine.green, base, stride, x0, y0, tw, th);
        copyTile(rFull, width, engine.redDiff, base, stride, x0, y0, tw, th);
        copyTile(bFull, width, engine.blueDiff, base, stride, x0, y0, tw, th);
      } else {
        emitRegion(out, engine.green, engine.redDiff, engine.blueDiff, base, stride, x0, y0, tw, th);
      }
    }
  }
  if (gFull && rFull && bFull) {
    const filtered = suppressFalseColor(rFull, bFull, width, height, falseColorPasses);
    emitRegion(out, gFull, filtered.red, filtered.blue, 0, width, 0, 0, width, height);
  }
}

function falseColorPassCount(sensor: BayerSensorData): number {
  if (!sensor.falseColorSuppression) return 0;
  return typeof sensor.falseColorSuppression === 'number' ? sensor.falseColorSuppression : 1;
}

function buildCalibration(
  cal: { defaultBLevel: number; wLevel: number; hasArrayBlackLevel: boolean; blackLevelArr?: number[] },
  engine: 'amaze' | 'ahd'
): Calibration {
  const black = new Float64Array(4);
  const range = new Float64Array(4);
  const arr = cal.blackLevelArr;
  for (let idx = 0; idx < 4; idx += 1) {
    let level = cal.defaultBLevel;
    if (engine === 'amaze' && cal.hasArrayBlackLevel && arr) {
      level = arr[idx % arr.length] ?? cal.defaultBLevel;
    } else if (engine === 'ahd' && cal.hasArrayBlackLevel && arr && arr.length === 4) {
      level = arr[idx];
    }
    black[idx] = level;
    range[idx] = engine === 'amaze' ? Math.max(1, cal.wLevel - level) : cal.wLevel - level;
  }
  return { black, range };
}

/** First column at or after xlo of the sites in row y whose (x + y) parity equals `parity`. */
function firstSite(xlo: number, y: number, parity: number): number {
  return ((xlo + y) & 1) === parity ? xlo : xlo + 1;
}

// ---------------------------------------------------------------------------------------------------------------------
// AMaZE
// ---------------------------------------------------------------------------------------------------------------------

function createAmazeEngine(f: TileFrame, input: SensorInput, cal: Calibration, layout: CfaLayout, tile: number): TileEngine {
  const maxSide = tile + 2 * TILE_HALO;
  const norm = new Float32Array(maxSide * maxSide);
  const ghEst = new Float32Array(maxSide * maxSide);
  const gvEst = new Float32Array(maxSide * maxSide);
  const green = new Float32Array(maxSide * maxSide);
  const interpRed = new Float32Array(maxSide * maxSide);
  const interpBlue = new Float32Array(maxSide * maxSide);
  // The directional estimates are dead once green is chosen: their storage carries the colour differences, and later
  // the filtered differences (the difference planes are dead once interpolated).
  const redDiff = ghEst;
  const blueDiff = gvEst;
  const filteredRed = ghEst;
  const filteredBlue = gvEst;
  const greenParity = layout.greenParity;
  const nonGreenParity = greenParity ^ 1;
  const redRow = layout.redRowParity;
  const H = TILE_HALO;
  const colLo = new Int32Array(maxSide);
  const colMid = new Int32Array(maxSide);
  const colHi = new Int32Array(maxSide);

  const compute = (x0: number, y0: number, tw: number, th: number): void => {
    const S = tw + 2 * H;
    gatherNormalized(f, input, cal, x0, y0, th + 2 * H, S, norm);

    // Directional green estimates with second-derivative correction, tile + 4.
    for (let sy = H - 4; sy < H + th + 4; sy += 1) {
      const row = sy * S;
      const xhi = H + tw + 4;
      for (let sx = firstSite(H - 4, sy, greenParity); sx < xhi; sx += 2) {
        const i = row + sx;
        const p = norm[i];
        ghEst[i] = p;
        gvEst[i] = p;
      }
      for (let sx = firstSite(H - 4, sy, nonGreenParity); sx < xhi; sx += 2) {
        const i = row + sx;
        const p = norm[i];
        const gh = (norm[i - 1] + norm[i + 1]) / 2 + (2 * p - norm[i - 2] - norm[i + 2]) / 4;
        const gv = (norm[i - S] + norm[i + S]) / 2 + (2 * p - norm[i - 2 * S] - norm[i + 2 * S]) / 4;
        ghEst[i] = Math.max(0, gh);
        gvEst[i] = Math.max(0, gv);
      }
    }

    // Direction selection by 5x5 local homogeneity, tile + 2.
    for (let sy = H - 2; sy < H + th + 2; sy += 1) {
      const row = sy * S;
      const xhi = H + tw + 2;
      for (let sx = firstSite(H - 2, sy, greenParity); sx < xhi; sx += 2) green[row + sx] = norm[row + sx];
      for (let sx = firstSite(H - 2, sy, nonGreenParity); sx < xhi; sx += 2) {
        const i = row + sx;
        const p = norm[i];
        const gh = ghEst[i];
        const gv = gvEst[i];
        const centerH = Math.abs(p - gh);
        const centerV = Math.abs(p - gv);
        let homH = 0;
        let homV = 0;
        let k = 0;
        for (let dy = -WINDOW_RADIUS; dy <= WINDOW_RADIUS; dy += 1) {
          let n = i + dy * S - WINDOW_RADIUS;
          for (let dx = 0; dx < WINDOW_SIDE; dx += 1) {
            const nGh = ghEst[n];
            const nGv = gvEst[n];
            const nPix = norm[n];
            const diffH = Math.abs(nPix - nGh) - centerH;
            const diffV = Math.abs(nPix - nGv) - centerV;
            const w = AMAZE_SPATIAL_WEIGHT[k];
            homH += w / (1.0 + Math.abs(diffH) + Math.abs(nGh - gh));
            homV += w / (1.0 + Math.abs(diffV) + Math.abs(nGv - gv));
            n += 1;
            k += 1;
          }
        }
        if (homH > homV * AMAZE_DIRECTION_BIAS) {
          green[i] = gh;
        } else if (homV > homH * AMAZE_DIRECTION_BIAS) {
          green[i] = gv;
        } else {
          const sum = homH + homV;
          const wH = sum > 0 ? homH / sum : AMAZE_BLEND_FALLBACK_WEIGHT;
          const wV = sum > 0 ? homV / sum : AMAZE_BLEND_FALLBACK_WEIGHT;
          green[i] = Math.max(0, wH * gh + wV * gv);
        }
      }
    }

    // Colour differences at the red and blue sites, tile + 2.
    for (let sy = H - 2; sy < H + th + 2; sy += 1) {
      const row = sy * S;
      const target = (sy & 1) === redRow ? redDiff : blueDiff;
      const xhi = H + tw + 2;
      for (let sx = firstSite(H - 2, sy, nonGreenParity); sx < xhi; sx += 2) {
        const i = row + sx;
        target[i] = norm[i] - green[i];
      }
    }

    // Missing differences from the neighbouring sites, tile + 1.
    for (let sy = H - 1; sy < H + th + 1; sy += 1) {
      const row = sy * S;
      const inRedRow = (sy & 1) === redRow;
      const xhi = H + tw + 1;
      for (let sx = firstSite(H - 1, sy, nonGreenParity); sx < xhi; sx += 2) {
        const i = row + sx;
        if (inRedRow) {
          interpRed[i] = redDiff[i];
          interpBlue[i] = (blueDiff[i - S - 1] + blueDiff[i - S + 1] + blueDiff[i + S - 1] + blueDiff[i + S + 1]) / 4;
        } else {
          interpBlue[i] = blueDiff[i];
          interpRed[i] = (redDiff[i - S - 1] + redDiff[i - S + 1] + redDiff[i + S - 1] + redDiff[i + S + 1]) / 4;
        }
      }
      for (let sx = firstSite(H - 1, sy, greenParity); sx < xhi; sx += 2) {
        const i = row + sx;
        if (inRedRow) {
          interpRed[i] = (redDiff[i - 1] + redDiff[i + 1]) / 2;
          interpBlue[i] = (blueDiff[i - S] + blueDiff[i + S]) / 2;
        } else {
          interpBlue[i] = (blueDiff[i - 1] + blueDiff[i + 1]) / 2;
          interpRed[i] = (redDiff[i - S] + redDiff[i + S]) / 2;
        }
      }
    }

    // 3x3 median of the interpolated differences removes zipper artefacts, tile only.
    median3x3(interpRed, filteredRed, S, H, H + tw, H, H + th, colLo, colMid, colHi);
    median3x3(interpBlue, filteredBlue, S, H, H + tw, H, H + th, colLo, colMid, colHi);
  };

  return { green, redDiff: filteredRed, blueDiff: filteredBlue, compute };
}

function amazeNormalizationMax(sensor: BayerSensorData): number {
  const { data, bitsPerSample } = sensor;
  if (bitsPerSample) return (1 << bitsPerSample) - 1;
  if (!(data instanceof Uint16Array)) return BYTE_RANGE;
  let maxVal = 0;
  const len = Math.min(data.length, AMAZE_SCAN_SAMPLES);
  for (let i = 0; i < len; i += 1) {
    if (data[i] > maxVal) maxVal = data[i];
  }
  if (maxVal > AMAZE_BITS_14_MAX) return FULL_16_BIT_MAX;
  if (maxVal > AMAZE_BITS_12_MAX) return AMAZE_BITS_14_MAX;
  if (maxVal > AMAZE_BITS_10_MAX) return AMAZE_BITS_12_MAX;
  return BYTE_RANGE;
}

/**
 * AMaZE-style Bayer demosaicing: directional green estimates chosen by 5x5 local homogeneity, colour differences
 * interpolated from neighbouring sites and median-filtered, optional false-colour suppression, then white balance,
 * colour matrix and sRGB encoding. Numerically identical to the reference in image.ts.
 */
export function demosaicAmazeBayerCfa(sensor: BayerSensorData, options?: DemosaicOptions): DemosaicResult {
  const { width, height, pattern, data, whiteBalance, applySrgbGamma } = sensor;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || (width & 1) !== 0 || (height & 1) !== 0) {
    throw new InvalidRawSensorError(`Invalid sensor dimensions: ${width}x${height}. Minimum 2x2 with even dimensions required.`);
  }
  if (!CFA_PATTERNS.has(pattern)) {
    throw new InvalidRawSensorError(`Unsupported Bayer CFA pattern: '${pattern}'. Expected RGGB, BGGR, GRBG, or GBRG.`);
  }
  checkPixelBudget(width, height);
  if (!data || data.length < width * height) {
    throw new InvalidRawSensorError(`Bayer sensor buffer underflow: expected at least ${width * height} samples, got ${data ? data.length : 0}.`);
  }
  const tile = checkTileSize(options);
  const calibration = buildCalibration(validateBayerSensorCalibration(sensor, amazeNormalizationMax(sensor)), 'amaze');
  const out = createOutputStage(sensor, options, whiteBalance ?? [1, 1, 1], Boolean(applySrgbGamma), false);
  const frame = createTileFrame(width, height, tile);
  const engine = createAmazeEngine(frame, { samples: data, kind: 'direct' }, calibration, resolveCfa(pattern), tile);
  runFrame(width, height, tile, engine, out, falseColorPassCount(sensor));
  return { data: out.rgb8 ?? Buffer.alloc(0), floatData: out.floatOut, width, height };
}

// ---------------------------------------------------------------------------------------------------------------------
// AHD
// ---------------------------------------------------------------------------------------------------------------------

function createAhdEngine(f: TileFrame, input: SensorInput, cal: Calibration, layout: CfaLayout, tile: number): TileEngine {
  const maxSide = tile + 2 * TILE_HALO;
  const planeSize = maxSide * maxSide;
  const norm = new Float64Array(planeSize);
  const gH = new Float32Array(planeSize);
  const gV = new Float32Array(planeSize);
  const rH = new Float32Array(planeSize);
  const rV = new Float32Array(planeSize);
  const bH = new Float32Array(planeSize);
  const bV = new Float32Array(planeSize);
  const krH = new Float32Array(planeSize);
  const krV = new Float32Array(planeSize);
  const kbH = new Float32Array(planeSize);
  const kbV = new Float32Array(planeSize);
  const labVA = new Float32Array(planeSize);
  const labVB = new Float32Array(planeSize);
  const finalGreen = new Float32Array(planeSize);
  const useVertical = new Uint8Array(planeSize);
  // Homogeneity sums. The float64 raw plane is dead once the colour fields are built, so it carries the first sum.
  const homeH = norm;
  const homeV = new Float64Array(planeSize);
  // The colour-difference planes are dead once the red and blue fields are built, so CIELab, then the selected
  // differences, then their medians reuse their storage.
  const labHL = krH;
  const labHA = krV;
  const labHB = kbH;
  const labVL = kbV;
  const diffRed = labHL;
  const diffBlue = labHA;
  const medianRed = labHB;
  const medianBlue = labVL;
  const greenParity = layout.greenParity;
  const nonGreenParity = greenParity ^ 1;
  const redRow = layout.redRowParity;
  const H = TILE_HALO;
  const colLo = new Int32Array(maxSide);
  const colMid = new Int32Array(maxSide);
  const colHi = new Int32Array(maxSide);

  const compute = (x0: number, y0: number, tw: number, th: number): void => {
    const S = tw + 2 * H;
    gatherNormalized(f, input, cal, x0, y0, th + 2 * H, S, norm);

    // Horizontal and vertical green with second-derivative correction, tile + 4.
    for (let sy = H - 4; sy < H + th + 4; sy += 1) {
      const row = sy * S;
      const xhi = H + tw + 4;
      for (let sx = firstSite(H - 4, sy, greenParity); sx < xhi; sx += 2) {
        const i = row + sx;
        gH[i] = norm[i];
        gV[i] = norm[i];
      }
      for (let sx = firstSite(H - 4, sy, nonGreenParity); sx < xhi; sx += 2) {
        const i = row + sx;
        const p = norm[i];
        gH[i] = Math.max(0, (norm[i - 1] + norm[i + 1]) * 0.5 + (2.0 * p - norm[i - 2] - norm[i + 2]) * 0.25);
        gV[i] = Math.max(0, (norm[i - S] + norm[i + S]) * 0.5 + (2.0 * p - norm[i - 2 * S] - norm[i + 2 * S]) * 0.25);
      }
    }

    // Red-green and blue-green differences at the red and blue sites for both directions, tile + 4.
    for (let sy = H - 4; sy < H + th + 4; sy += 1) {
      const row = sy * S;
      const xhi = H + tw + 4;
      const diffH = (sy & 1) === redRow ? krH : kbH;
      const diffV = (sy & 1) === redRow ? krV : kbV;
      for (let sx = firstSite(H - 4, sy, nonGreenParity); sx < xhi; sx += 2) {
        const i = row + sx;
        diffH[i] = norm[i] - gH[i];
        diffV[i] = norm[i] - gV[i];
      }
    }

    // Full red and blue fields for both directions, tile + 3.
    for (let sy = H - 3; sy < H + th + 3; sy += 1) {
      const row = sy * S;
      const xhi = H + tw + 3;
      const inRedRow = (sy & 1) === redRow;
      for (let sx = firstSite(H - 3, sy, nonGreenParity); sx < xhi; sx += 2) {
        const i = row + sx;
        const p = norm[i];
        if (inRedRow) {
          rH[i] = p;
          rV[i] = p;
          bH[i] = Math.max(0, gH[i] + (kbH[i - S - 1] + kbH[i - S + 1] + kbH[i + S - 1] + kbH[i + S + 1]) * 0.25);
          bV[i] = Math.max(0, gV[i] + (kbV[i - S - 1] + kbV[i - S + 1] + kbV[i + S - 1] + kbV[i + S + 1]) * 0.25);
        } else {
          bH[i] = p;
          bV[i] = p;
          rH[i] = Math.max(0, gH[i] + (krH[i - S - 1] + krH[i - S + 1] + krH[i + S - 1] + krH[i + S + 1]) * 0.25);
          rV[i] = Math.max(0, gV[i] + (krV[i - S - 1] + krV[i - S + 1] + krV[i + S - 1] + krV[i + S + 1]) * 0.25);
        }
      }
      for (let sx = firstSite(H - 3, sy, greenParity); sx < xhi; sx += 2) {
        const i = row + sx;
        if (inRedRow) {
          rH[i] = Math.max(0, gH[i] + (krH[i - 1] + krH[i + 1]) * 0.5);
          rV[i] = Math.max(0, gV[i] + (krV[i - 1] + krV[i + 1]) * 0.5);
          bH[i] = Math.max(0, gH[i] + (kbH[i - S] + kbH[i + S]) * 0.5);
          bV[i] = Math.max(0, gV[i] + (kbV[i - S] + kbV[i + S]) * 0.5);
        } else {
          bH[i] = Math.max(0, gH[i] + (kbH[i - 1] + kbH[i + 1]) * 0.5);
          bV[i] = Math.max(0, gV[i] + (kbV[i - 1] + kbV[i + 1]) * 0.5);
          rH[i] = Math.max(0, gH[i] + (krH[i - S] + krH[i + S]) * 0.5);
          rV[i] = Math.max(0, gV[i] + (krV[i - S] + krV[i + S]) * 0.5);
        }
      }
    }

    // CIELab of both candidate fields, tile + 3.
    for (let sy = H - 3; sy < H + th + 3; sy += 1) {
      const row = sy * S;
      for (let sx = H - 3; sx < H + tw + 3; sx += 1) {
        const i = row + sx;
        storeLab(rH[i], gH[i], bH[i], labHL, labHA, labHB, i);
        storeLab(rV[i], gV[i], bV[i], labVL, labVA, labVB, i);
      }
    }

    // Homogeneity of each direction over the 5x5 window; the more homogeneous field wins, tile + 1. The distance of a
    // pixel pair is symmetric, so each pair inside the Lab region is evaluated once and credited to both pixels. The
    // centre term of the window (distance 0, weight 1) seeds the sums.
    for (let sy = H - 3; sy < H + th + 3; sy += 1) {
      const row = sy * S;
      for (let sx = H - 3; sx < H + tw + 3; sx += 1) {
        homeH[row + sx] = 1.0;
        homeV[row + sx] = 1.0;
      }
    }
    for (let o = 0; o < PAIR_OFFSET_COUNT; o += 1) {
      const dx = PAIR_DX[o];
      const dy = PAIR_DY[o];
      const w = AHD_SPATIAL_WEIGHT[(dy + WINDOW_RADIUS) * WINDOW_SIDE + dx + WINDOW_RADIUS];
      const shift = dy * S + dx;
      const colFrom = H - 3 + Math.max(0, -dx);
      const colTo = H + tw + 3 - Math.max(0, dx);
      for (let sy = H - 3; sy < H + th + 3 - dy; sy += 1) {
        const row = sy * S;
        for (let c = row + colFrom; c < row + colTo; c += 1) {
          const n = c + shift;
          const hL = labHL[n] - labHL[c];
          const hA = labHA[n] - labHA[c];
          const hB = labHB[n] - labHB[c];
          const vL = labVL[n] - labVL[c];
          const vA = labVA[n] - labVA[c];
          const vB = labVB[n] - labVB[c];
          const termH = w / (1.0 + Math.sqrt(hL * hL + hA * hA + hB * hB));
          const termV = w / (1.0 + Math.sqrt(vL * vL + vA * vA + vB * vB));
          homeH[c] += termH;
          homeH[n] += termH;
          homeV[c] += termV;
          homeV[n] += termV;
        }
      }
    }
    for (let sy = H - 1; sy < H + th + 1; sy += 1) {
      const row = sy * S;
      for (let sx = H - 1; sx < H + tw + 1; sx += 1) {
        const i = row + sx;
        const vertical = homeH[i] >= homeV[i] ? 0 : 1;
        useVertical[i] = vertical;
        finalGreen[i] = vertical === 0 ? gH[i] : gV[i];
      }
    }

    // Colour differences of the selected field, tile + 1.
    for (let sy = H - 1; sy < H + th + 1; sy += 1) {
      const row = sy * S;
      for (let sx = H - 1; sx < H + tw + 1; sx += 1) {
        const i = row + sx;
        const vertical = useVertical[i] === 1;
        diffRed[i] = (vertical ? rV[i] : rH[i]) - finalGreen[i];
        diffBlue[i] = (vertical ? bV[i] : bH[i]) - finalGreen[i];
      }
    }

    // 3x3 median of the colour differences, tile only.
    median3x3(diffRed, medianRed, S, H, H + tw, H, H + th, colLo, colMid, colHi);
    median3x3(diffBlue, medianBlue, S, H, H + tw, H, H + th, colLo, colMid, colHi);
  };

  return { green: finalGreen, redDiff: medianRed, blueDiff: medianBlue, compute };
}

interface AhdInput {
  sensorData: SensorInput;
  maxVal: number;
}

/** Legacy field aliases of the reference AHD: `rawData` for `data` and `bitDepth` for `bitsPerSample`. */
interface LegacyAhdFields {
  rawData?: BayerSensorData['data'];
  bitDepth?: number;
}

function resolveAhdInput(sensor: BayerSensorData, width: number, height: number): AhdInput {
  const legacy = sensor as BayerSensorData & LegacyAhdFields;
  const raw = sensor.data ?? legacy.rawData;
  if (!raw || raw.length === 0) {
    throw new InvalidRawSensorError('Bayer sensor buffer empty or undefined.');
  }
  const bitDepth = sensor.bitsPerSample ?? legacy.bitDepth ?? (raw instanceof Uint16Array ? 16 : 8);
  const packedBytes = !(raw instanceof Uint16Array) && !(raw instanceof Float32Array) && bitDepth > 8;
  const needed = packedBytes ? width * height * BYTES_PER_16_BIT_SAMPLE : width * height;
  if (raw.length < needed) {
    throw new InvalidRawSensorError(`Bayer sensor buffer underflow: expected at least ${needed} samples, got ${raw.length}.`);
  }
  return { sensorData: { samples: raw, kind: packedBytes ? 'bytes16' : 'direct' }, maxVal: (1 << bitDepth) - 1 };
}

/**
 * Adaptive Homogeneity-Directed demosaicing (Hirakawa and Parks, 2005): two complete candidate fields (green
 * interpolated horizontally or vertically, red and blue from colour differences), compared in CIELab by the
 * homogeneity of their 5x5 neighbourhoods, then a 3x3 median of the colour differences. Numerically equivalent to the
 * reference in image.ts (see the header for the single difference in the homogeneity arithmetic).
 */
export function demosaicAhdBayerCfa(sensor: BayerSensorData, options?: DemosaicOptions): DemosaicResult {
  const { width, height } = sensor;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) {
    throw new InvalidRawSensorError(`Invalid sensor dimensions: ${width}x${height}. Minimum 2x2 required.`);
  }
  const pattern = String(sensor.pattern).toUpperCase();
  if (!CFA_PATTERNS.has(pattern)) {
    throw new InvalidRawSensorError(`Unsupported Bayer CFA pattern: '${sensor.pattern}'. Expected RGGB, BGGR, GRBG, or GBRG.`);
  }
  checkPixelBudget(width, height);
  const { sensorData, maxVal } = resolveAhdInput(sensor, width, height);
  const tile = checkTileSize(options);
  const calibration = buildCalibration(validateBayerSensorCalibration(sensor, maxVal), 'ahd');
  const out = createOutputStage(sensor, options, sensor.whiteBalance ?? [1, 1, 1], sensor.applySrgbGamma ?? true, true);
  const frame = createTileFrame(width, height, tile);
  const engine = createAhdEngine(frame, sensorData, calibration, resolveCfa(pattern), tile);
  runFrame(width, height, tile, engine, out, falseColorPassCount(sensor));
  return { data: out.rgb8 ?? Buffer.alloc(0), floatData: out.floatOut, width, height };
}
