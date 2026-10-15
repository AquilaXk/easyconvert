/**
 * Bandlimited multi-stage audio resampler.
 *
 * Method: bandlimited interpolation (J. O. Smith, CCRMA) with a Kaiser-windowed sinc
 * prototype (Kaiser 1974), evaluated as a polyphase filter bank (Crochiere and Rabiner).
 *
 *  - The prototype is a low-pass whose -6 dB point is `cutoff x` the Nyquist frequency of the
 *    LOWER of the two rates. Its half-length therefore grows as 1 / min(1, outRate / inRate)
 *    when decimating, so aliasing stays suppressed for every ratio.
 *  - Kaiser design formulas: beta from the stopband attenuation A, and
 *    N ~ (A - 8) / (2.285 x dw) taps for a transition width of dw rad/sample.
 *  - Output sample n sits at input time n x srcRate / tgtRate. With the integer rates reduced by
 *    their GCD (L = tgt/g, M = src/g) that time is the exact rational n x M / L, advanced with an
 *    integer quotient/remainder accumulator, so there is no floating-point drift on any ratio.
 *  - Small L: one exact coefficient row per phase. Large L: a finely oversampled row set with
 *    linear interpolation between adjacent rows (error far below the stopband floor).
 *  - Factor-of-two parts of a ratio run through cascaded half-band stages (audio-halfband.ts),
 *    which need about a quarter of the multiplies of a direct filter: decimation runs them
 *    before the polyphase stage, interpolation after it. A stage is only used while its
 *    transition band stays clear of the lower Nyquist, so nothing aliases or images into
 *    0..Nyquist; the polyphase stage then handles the remaining ratio (at most 2:1).
 *  - Coefficient tables are built once per (ratio, quality) and kept in a bounded cache.
 *  - Stages pull their input block by block with exact index arithmetic, so memory stays
 *    bounded for long files and block seams are bit-exact.
 *  - Integer output is quantised with seeded TPDF dither; float and 24/32-bit output never is.
 */
import { ConversionFailedError } from '../types';
import { besselI0, kaiserBeta, kaiserLengthEstimate } from './audio-kaiser';
import {
  type HalfBandFilter,
  designVerifiedHalfBand,
  halfBandDecimateBlock,
  halfBandDecimateSpan,
  halfBandInterpolateBlock,
  halfBandInterpolateMaxSpan,
} from './audio-halfband';
import { createMacKernel, MAC_MEMORY_MAX_BYTES, macKernelSupported, type MacKernel } from './wasm/resampler-mac';

export class AudioResampleError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'AudioResampleError';
  }
}

export type ResampleQuality = 'standard' | 'high';
export type ResampleOutputBitDepth = 8 | 16 | 24 | 32 | 'float';

export interface ResampleOptions {
  /** Filter preset. `standard` suits 16-bit output, `high` suits 24-bit and float. */
  quality?: ResampleQuality;
  /**
   * Sample format the result will finally be stored in. 8 and 16 quantise the output to that
   * integer grid with TPDF dither; 24, 32 and `float` leave the resampled values untouched.
   */
  outputBitDepth?: ResampleOutputBitDepth;
  /** Seed of the dither generator; the same seed and input give identical output. */
  ditherSeed?: number;
  /**
   * Multiply-accumulate kernel of the polyphase stage. `auto` (default) uses WebAssembly SIMD when the runtime has it and
   * the stage is mono or stereo; `scalar` forces the TypeScript loops (the reference); `simd` requires the SIMD kernels and
   * fails when they cannot run. The two paths give identical samples. Meant for tests and diagnostics.
   */
  kernel?: ResampleKernel;
  /** When given, filled in with the kernel that processed the signal. */
  report?: ResampleReport;
}

export type ResampleKernel = 'auto' | 'scalar' | 'simd';
export type ResampleKernelUsed = 'simd-f64x2' | 'scalar';

export interface ResampleReport {
  kernel?: ResampleKernelUsed;
}

export interface ResamplerPlanInfo {
  /** Output-rate numerator after GCD reduction (number of polyphase rows in exact mode). */
  upFactor: number;
  /** Input-rate numerator after GCD reduction (input samples consumed per `upFactor` outputs). */
  downFactor: number;
  taps: number;
  mode: 'exact' | 'interpolated';
  phaseRows: number;
  tableEntries: number;
  beta: number;
  /** Cascaded 2:1 (before the polyphase stage) or 1:2 (after it) half-band stages; 0 = direct. */
  halfBandStages: number;
  /** Odd-tap pairs of each half-band stage, in processing order. */
  halfBandPairs: number[];
  /** h(2p + 1) of each half-band stage (the centre tap is 1/2, even taps are 0), copies. */
  halfBandTaps: Float64Array[];
}

// ---------------------------------------------------------------------------------------------
// Limits (all inputs are untrusted)
// ---------------------------------------------------------------------------------------------

export const MIN_RESAMPLE_RATE_HZ = 1000;
export const MAX_RESAMPLE_RATE_HZ = 768000;
/** Largest decimation or interpolation factor; bounds the filter length (taps ~ 160 x ratio). */
export const MAX_RESAMPLE_RATIO = 64;
export const MAX_RESAMPLE_CHANNELS = 32;
/** Upper bound on the bytes of output one call allocates (512 MiB), i.e. minutes of CPU at most. */
export const MAX_RESAMPLE_OUTPUT_BYTES = 512 * 1024 * 1024;
const INT16_BYTES = 2;
const FLOAT32_BYTES = 4;
/** Coefficient doubles one plan may hold (2 MiB); decides exact versus interpolated rows. */
const MAX_TABLE_ENTRIES = 2 ** 18;
const MIN_INTERPOLATED_PHASE_ROWS = 32;
const MAX_INTERPOLATED_PHASE_ROWS = 2048;
/** Coefficient plans kept per process (least recently used evicted first). */
export const MAX_RESAMPLER_PLAN_CACHE_ENTRIES = 8;
/** Output frames per processing block (rounded to whole polyphase periods in exact mode). */
const BLOCK_OUT_FRAMES = 4096;
/** Cap on the interleaved input scratch (doubles) of one block; bounds memory for long files. */
const MAX_SCRATCH_SAMPLES = 2 ** 22;
/** Smallest block the pipeline shrinks to when many channels or deep cascades need less scratch. */
const MIN_BLOCK_FRAMES = 64;
/** A ratio is at most MAX_RESAMPLE_RATIO = 2^6, so at most this many 2:1 stages can apply. */
const MAX_HALF_BAND_STAGES = 6;
/** Per-frame cost of loading, zero-padding and copying in a stage, in multiply equivalents. */
const STAGE_OVERHEAD_MULTIPLIES = 2;
/** Accuracy margin added to the half-band stopband so two cascaded stages still meet the preset. */
const HALF_BAND_EXTRA_ATTENUATION_DB = 1;
const INT16_MIN = -32768;
const INT16_MAX = 32767;
const INT16_BITS = 16;
const SUPPORTED_INT16_OUTPUT_BITS = new Set<number>([8, INT16_BITS]);
const DITHERED_BIT_DEPTHS = new Set<ResampleOutputBitDepth>([8, 16]);
const KNOWN_BIT_DEPTHS = new Set<ResampleOutputBitDepth>([8, 16, 24, 32, 'float']);
const KNOWN_QUALITIES = new Set<ResampleQuality>(['standard', 'high']);
const KNOWN_KERNELS = new Set<ResampleKernel>(['auto', 'scalar', 'simd']);
/** Channel counts the SIMD kernels cover. */
const SIMD_MIN_CHANNELS = 1;
const SIMD_MAX_CHANNELS = 2;
const DOUBLE_BYTES = 8;
const KERNEL_ALIGN_BYTES = 16;
const DEFAULT_DITHER_SEED = 0x2f6e2b1;

// ---------------------------------------------------------------------------------------------
// Filter design
// ---------------------------------------------------------------------------------------------

interface FilterPreset {
  /** Stopband attenuation A in dB. */
  attenuationDb: number;
  /** -6 dB point as a fraction of the lower Nyquist frequency. */
  cutoff: number;
  /** Transition band width (passband edge to stopband edge) as a fraction of the lower Nyquist. */
  transition: number;
}

/** Passband edge = cutoff - transition/2 = 0.90, stopband edge = cutoff + transition/2 = 1.00. */
const FILTER_PRESETS: Record<ResampleQuality, FilterPreset> = {
  standard: { attenuationDb: 96, cutoff: 0.95, transition: 0.1 },
  high: { attenuationDb: 130, cutoff: 0.95, transition: 0.1 },
};

/** Kernel taps per phase are a multiple of this (unrolled accumulators). */
const TAP_UNROLL = 4;
/** |pi x| below this is treated as the sinc limit 1. */
const SINC_ARGUMENT_EPSILON = 1e-12;

function gcd(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

interface PolyPlan {
  upFactor: number;
  downFactor: number;
  taps: number;
  halfTaps: number;
  mode: 'exact' | 'interpolated';
  phaseRows: number;
  beta: number;
  /** floor(M / L) and M mod L: per-output integer advance of the input position. */
  quotient: number;
  remainder: number;
  /** Interpolated mode: oversampled rows per unit of the remainder, i.e. phaseRows / L. */
  rowScale: number;
  /** Exact mode, per output residue r = n mod L: kernel row index and whole-sample input offset. */
  residueRow: Int32Array;
  residueBase: Int32Array;
  /** Exact mode, per residue: ROW_ASYMMETRIC, ROW_CENTRE_SYMMETRIC or ROW_PALINDROME. */
  residueSymmetry: Uint8Array;
  table: Float64Array;
}

interface ResamplerPlan {
  poly: PolyPlan;
  /** Half-band stages in processing order. */
  halfBands: HalfBandFilter[];
  /** Whether the half-band stages run before (decimation) or after (interpolation) the poly stage. */
  halfBandsFirst: boolean;
  /** Overall reduced ratio: output frames = floor(input frames x totalUp / totalDown). */
  totalUp: number;
  totalDown: number;
}

/**
 * Fill `table` (rows of `taps` coefficients). Row r is the kernel for an output whose input time
 * is `ip + r / rowDenominator`: tap j reads input `ip - halfTaps + 1 + j`.
 */
function buildKernelRows(
  table: Float64Array,
  rows: number,
  rowDenominator: number,
  taps: number,
  halfTaps: number,
  cutoffCyclesPerSample: number,
  beta: number
): void {
  const windowNorm = 1 / besselI0(beta);
  const twoFc = 2 * cutoffCyclesPerSample;
  for (let row = 0; row < rows; row++) {
    const frac = row / rowDenominator;
    const base = row * taps;
    let sum = 0;
    for (let j = 0; j < taps; j++) {
      const u = halfTaps - 1 - j + frac;
      const x = u / halfTaps;
      const inside = 1 - x * x;
      let value = 0;
      if (inside > 0) {
        const arg = Math.PI * twoFc * u;
        const sinc = Math.abs(arg) < SINC_ARGUMENT_EPSILON ? 1 : Math.sin(arg) / arg;
        value = twoFc * sinc * besselI0(beta * Math.sqrt(inside)) * windowNorm;
      }
      table[base + j] = value;
      sum += value;
    }
    // Unity DC gain for every phase removes phase-dependent level ripple.
    const gain = 1 / sum;
    for (let j = 0; j < taps; j++) table[base + j] *= gain;
  }
}

function pow2Floor(n: number): number {
  return 2 ** Math.floor(Math.log2(n));
}

interface PolyGeometry {
  upFactor: number;
  downFactor: number;
  halfTaps: number;
  taps: number;
  cutoff: number;
}

/**
 * Filter geometry of the polyphase stage for the (possibly virtual) rate pair; only the ratio
 * matters. Everything is in cycles per INPUT sample: the lower Nyquist, expressed there, is
 * 0.5 x min(1, tgt/src), which is what makes the filter length scale with 1 / cutoff.
 */
function polyGeometry(srcRate: number, tgtRate: number, quality: ResampleQuality): PolyGeometry {
  const divisor = gcd(srcRate, tgtRate);
  const preset = FILTER_PRESETS[quality];
  const lowerNyquist = 0.5 * Math.min(1, tgtRate / srcRate);
  const transitionWidth = preset.transition * lowerNyquist;
  let halfTaps = Math.ceil(kaiserLengthEstimate(preset.attenuationDb, transitionWidth) / 2);
  if (halfTaps % 2 !== 0) halfTaps++;
  return {
    upFactor: tgtRate / divisor,
    downFactor: srcRate / divisor,
    halfTaps,
    taps: 2 * halfTaps, // multiple of TAP_UNROLL because halfTaps is even
    cutoff: preset.cutoff * lowerNyquist,
  };
}

function buildPolyPlan(srcRate: number, tgtRate: number, quality: ResampleQuality): PolyPlan {
  const { upFactor, downFactor, halfTaps, taps, cutoff } = polyGeometry(srcRate, tgtRate, quality);
  const beta = kaiserBeta(FILTER_PRESETS[quality].attenuationDb);
  const exact = upFactor * taps <= MAX_TABLE_ENTRIES;
  let phaseRows = upFactor;
  if (!exact) {
    phaseRows = Math.min(MAX_INTERPOLATED_PHASE_ROWS, pow2Floor(Math.floor(MAX_TABLE_ENTRIES / taps) - 1));
    if (phaseRows < MIN_INTERPOLATED_PHASE_ROWS) {
      throw new AudioResampleError(
        `Resample ratio ${srcRate}:${tgtRate} needs a ${taps}-tap filter, beyond the supported table size`
      );
    }
  }
  const residueRow = new Int32Array(exact ? upFactor : 0);
  const residueBase = new Int32Array(exact ? upFactor : 0);
  const residueSymmetry = new Uint8Array(exact ? upFactor : 0);
  for (let r = 0; r < residueRow.length; r++) {
    const scaled = r * downFactor;
    residueBase[r] = Math.floor(scaled / upFactor);
    residueRow[r] = scaled - residueBase[r] * upFactor;
    if (residueRow[r] === 0) residueSymmetry[r] = ROW_CENTRE_SYMMETRIC;
    else if (upFactor % 2 === 0 && residueRow[r] === upFactor / 2) residueSymmetry[r] = ROW_PALINDROME;
  }
  const storedRows = exact ? phaseRows : phaseRows + 1;
  const table = new Float64Array(storedRows * taps);
  buildKernelRows(table, storedRows, exact ? upFactor : phaseRows, taps, halfTaps, cutoff, beta);
  return {
    upFactor,
    downFactor,
    taps,
    halfTaps,
    mode: exact ? 'exact' : 'interpolated',
    phaseRows,
    beta,
    quotient: Math.floor(downFactor / upFactor),
    remainder: downFactor % upFactor,
    rowScale: phaseRows / upFactor,
    residueRow,
    residueBase,
    residueSymmetry,
    table,
  };
}

/** Passband edge of a half-band stage running at `stageRate`, in cycles per sample of that rate. */
function halfBandPassEdge(stageRate: number, lowerRate: number): number {
  return lowerRate / (2 * stageRate);
}

function halfBandAttenuation(quality: ResampleQuality): number {
  return FILTER_PRESETS[quality].attenuationDb + HALF_BAND_EXTRA_ATTENUATION_DB;
}

interface CascadeChoice {
  stages: number;
  /** Half-band filters in processing order. */
  filters: HalfBandFilter[];
}

/**
 * Half-band stage count with the lowest estimated multiply count, using verified filter lengths.
 * Level l of the cascade runs at higherRate / 2^l (source side when decimating, target side
 * when interpolating) and its transition starts at the lower Nyquist, so it must stay positive.
 * The same level has the same filter for every stage count, so each level is designed once.
 */
function chooseHalfBandStages(srcRate: number, tgtRate: number, quality: ResampleQuality): CascadeChoice {
  const decimating = srcRate > tgtRate;
  const lowerRate = Math.min(srcRate, tgtRate);
  const higherRate = Math.max(srcRate, tgtRate);
  const attenuation = halfBandAttenuation(quality);
  const levels: HalfBandFilter[] = [];
  let best: CascadeChoice = { stages: 0, filters: [] };
  let bestCost = Number.POSITIVE_INFINITY;
  let levelCost = 0;
  for (let k = 0; k <= MAX_HALF_BAND_STAGES; k++) {
    if (k > 0) {
      const level = k - 1;
      const stageRate = higherRate / 2 ** level;
      // The slowest stage rate is higherRate / 2^(k-1) and its output/input must exceed lowerRate.
      if (higherRate / 2 ** k <= lowerRate) break;
      const filter = designVerifiedHalfBand(attenuation, halfBandPassEdge(stageRate, lowerRate));
      if (filter === null) break;
      levels.push(filter);
      levelCost += decimating
        ? (filter.pairs + 1 + STAGE_OVERHEAD_MULTIPLIES) * (stageRate / 2)
        : (filter.pairs / 2 + STAGE_OVERHEAD_MULTIPLIES) * stageRate;
    }
    const poly = decimating
      ? polyGeometry(srcRate, tgtRate * 2 ** k, quality)
      : polyGeometry(srcRate * 2 ** k, tgtRate, quality);
    const polyOutputRate = decimating ? tgtRate : tgtRate / 2 ** k;
    const cost = poly.taps * polyOutputRate + levelCost;
    if (cost < bestCost) {
      bestCost = cost;
      best = { stages: k, filters: decimating ? levels.slice(0, k) : levels.slice(0, k).reverse() };
    }
  }
  return best;
}

function designPlan(srcRate: number, tgtRate: number, quality: ResampleQuality): ResamplerPlan {
  const divisor = gcd(srcRate, tgtRate);
  const decimating = srcRate > tgtRate;
  const { stages, filters } = chooseHalfBandStages(srcRate, tgtRate, quality);
  const poly = decimating
    ? buildPolyPlan(srcRate, tgtRate * 2 ** stages, quality)
    : buildPolyPlan(srcRate * 2 ** stages, tgtRate, quality);
  return {
    poly,
    halfBands: filters,
    halfBandsFirst: decimating,
    totalUp: tgtRate / divisor,
    totalDown: srcRate / divisor,
  };
}

const planCache = new Map<string, ResamplerPlan>();

function getPlan(srcRate: number, tgtRate: number, quality: ResampleQuality): ResamplerPlan {
  const key = `${srcRate}:${tgtRate}:${quality}`;
  const cached = planCache.get(key);
  if (cached) {
    planCache.delete(key);
    planCache.set(key, cached); // refresh recency
    return cached;
  }
  const plan = designPlan(srcRate, tgtRate, quality);
  planCache.set(key, plan);
  if (planCache.size > MAX_RESAMPLER_PLAN_CACHE_ENTRIES) {
    const oldest = planCache.keys().next().value;
    if (oldest !== undefined) planCache.delete(oldest);
  }
  return plan;
}

/** Number of cached coefficient plans (diagnostics and tests). */
export function resamplerPlanCacheSize(): number {
  return planCache.size;
}

/**
 * Design summary for a ratio (also validates the rates); used by tests and diagnostics. The
 * rate fields describe the polyphase stage, which handles what the half-band stages leave.
 */
export function describeResamplerPlan(
  srcRate: number,
  tgtRate: number,
  quality: ResampleQuality = 'standard'
): ResamplerPlanInfo {
  validateRates(srcRate, tgtRate);
  validateQuality(quality);
  const { poly, halfBands } = getPlan(srcRate, tgtRate, quality);
  return {
    upFactor: poly.upFactor,
    downFactor: poly.downFactor,
    taps: poly.taps,
    mode: poly.mode,
    phaseRows: poly.phaseRows,
    tableEntries: poly.table.length,
    beta: poly.beta,
    halfBandStages: halfBands.length,
    halfBandPairs: halfBands.map((h) => h.pairs),
    halfBandTaps: halfBands.map((h) => Float64Array.from(h.odd)),
  };
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

function validateRates(srcRate: number, tgtRate: number): void {
  for (const [name, rate] of [
    ['source', srcRate],
    ['target', tgtRate],
  ] as const) {
    if (!Number.isInteger(rate) || rate < MIN_RESAMPLE_RATE_HZ || rate > MAX_RESAMPLE_RATE_HZ) {
      throw new AudioResampleError(
        `Invalid ${name} sample rate ${rate}: expected an integer between ${MIN_RESAMPLE_RATE_HZ} and ${MAX_RESAMPLE_RATE_HZ} Hz`
      );
    }
  }
  const ratio = Math.max(srcRate / tgtRate, tgtRate / srcRate);
  if (ratio > MAX_RESAMPLE_RATIO) {
    throw new AudioResampleError(
      `Unsupported resample ratio ${srcRate}:${tgtRate}: the factor may not exceed ${MAX_RESAMPLE_RATIO}`
    );
  }
}

function validateChannels(channels: number): void {
  if (!Number.isInteger(channels) || channels < 1 || channels > MAX_RESAMPLE_CHANNELS) {
    throw new AudioResampleError(
      `Invalid channel count ${channels}: expected an integer between 1 and ${MAX_RESAMPLE_CHANNELS}`
    );
  }
}

function validateQuality(quality: string): asserts quality is ResampleQuality {
  if (!KNOWN_QUALITIES.has(quality as ResampleQuality)) {
    throw new AudioResampleError(`Unknown resample quality "${quality}"`);
  }
}

function validateOutputFrames(
  inputFrames: number,
  plan: ResamplerPlan,
  channels: number,
  bytesPerSample: number
): number {
  const product = inputFrames * plan.totalUp;
  if (!Number.isSafeInteger(product)) {
    throw new AudioResampleError(`Input of ${inputFrames} frames is too long to resample`);
  }
  const outFrames = Math.floor(product / plan.totalDown);
  const outputBytes = outFrames * channels * bytesPerSample;
  if (outputBytes > MAX_RESAMPLE_OUTPUT_BYTES) {
    throw new AudioResampleError(
      `Resampled output of ${outputBytes} bytes exceeds the ${MAX_RESAMPLE_OUTPUT_BYTES} byte limit`
    );
  }
  return outFrames;
}

// ---------------------------------------------------------------------------------------------
// TPDF dither
// ---------------------------------------------------------------------------------------------

const DITHER_HALF_BITS = 16;
const DITHER_HALF_MASK = 0xffff;
const DITHER_UNIT = 1 / 2 ** DITHER_HALF_BITS;
const MULBERRY_INCREMENT = 0x6d2b79f5;
const MULBERRY_SHIFT_A = 15;
const MULBERRY_SHIFT_B = 7;
const MULBERRY_SHIFT_C = 14;
const MULBERRY_MIX = 61;
const HALF = 0.5;

/** Deterministic 32-bit generator (mulberry32). */
class NoiseSource {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next32(): number {
    this.state = (this.state + MULBERRY_INCREMENT) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> MULBERRY_SHIFT_A), t | 1);
    t ^= t + Math.imul(t ^ (t >>> MULBERRY_SHIFT_B), t | MULBERRY_MIX);
    return (t ^ (t >>> MULBERRY_SHIFT_C)) >>> 0;
  }
}

/** Rounds to a grid of `lsb`, adding TPDF noise: the sum of two independent uniforms of 1 LSB. */
class DitherQuantizer {
  private readonly noise: NoiseSource;

  constructor(
    private readonly lsb: number,
    private readonly low: number,
    private readonly high: number,
    seed: number
  ) {
    this.noise = new NoiseSource(seed);
  }

  quantize(src: Float64Array, count: number, dst: Float64Array): void {
    const { lsb, low, high, noise } = this;
    const inverse = 1 / lsb;
    for (let i = 0; i < count; i++) {
      // Two independent 16-bit uniforms u1, u2 in [0, 1): u1 + u2 - 1 is TPDF on [-1, 1).
      const bits = noise.next32();
      const dither = ((bits & DITHER_HALF_MASK) + (bits >>> DITHER_HALF_BITS) + 1) * DITHER_UNIT - 1;
      let q = Math.floor(src[i] * inverse + dither + HALF) * lsb;
      if (q < low) q = low;
      else if (q > high) q = high;
      dst[i] = q;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Convolution core
// ---------------------------------------------------------------------------------------------

const STEREO = 2;

/** One output sample of one channel; taps is a multiple of TAP_UNROLL. */
function dotMono(row: Float64Array, rowOffset: number, x: Float64Array, xOffset: number, taps: number): number {
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  for (let j = 0; j < taps; j += TAP_UNROLL) {
    s0 += row[rowOffset + j] * x[xOffset + j];
    s1 += row[rowOffset + j + 1] * x[xOffset + j + 1];
    s2 += row[rowOffset + j + 2] * x[xOffset + j + 2];
    s3 += row[rowOffset + j + 3] * x[xOffset + j + 3];
  }
  return s0 + s1 + s2 + s3;
}

/** One stereo output frame; each coefficient is loaded once and applied to both channels. */
function dotStereo(
  row: Float64Array,
  rowOffset: number,
  x: Float64Array,
  xOffset: number,
  taps: number,
  out: Float64Array,
  outOffset: number
): void {
  let left0 = 0;
  let left1 = 0;
  let left2 = 0;
  let left3 = 0;
  let right0 = 0;
  let right1 = 0;
  let right2 = 0;
  let right3 = 0;
  for (let j = 0; j < taps; j += TAP_UNROLL) {
    const c0 = row[rowOffset + j];
    const c1 = row[rowOffset + j + 1];
    const c2 = row[rowOffset + j + 2];
    const c3 = row[rowOffset + j + 3];
    const q = xOffset + STEREO * j;
    left0 += c0 * x[q];
    right0 += c0 * x[q + 1];
    left1 += c1 * x[q + 2];
    right1 += c1 * x[q + 3];
    left2 += c2 * x[q + 4];
    right2 += c2 * x[q + 5];
    left3 += c3 * x[q + 6];
    right3 += c3 * x[q + 7];
  }
  out[outOffset] = left0 + left1 + left2 + left3;
  out[outOffset + 1] = right0 + right1 + right2 + right3;
}

/** One output sample of channel (xOffset % channels) from channel-interleaved input. */
function dotStrided(
  row: Float64Array,
  rowOffset: number,
  x: Float64Array,
  xOffset: number,
  stride: number,
  taps: number
): number {
  let s0 = 0;
  let s1 = 0;
  for (let j = 0; j < taps; j += 2) {
    s0 += row[rowOffset + j] * x[xOffset + j * stride];
    s1 += row[rowOffset + j + 1] * x[xOffset + (j + 1) * stride];
  }
  return s0 + s1;
}

/** One output frame for every channel; `xFrame` is the first input frame of the kernel window. */
function dotFrame(
  row: Float64Array,
  rowOffset: number,
  x: Float64Array,
  xFrame: number,
  channels: number,
  taps: number,
  out: Float64Array,
  outFrame: number
): void {
  if (channels === 1) {
    out[outFrame] = dotMono(row, rowOffset, x, xFrame, taps);
  } else if (channels === STEREO) {
    dotStereo(row, rowOffset, x, xFrame * STEREO, taps, out, outFrame * STEREO);
  } else {
    for (let c = 0; c < channels; c++) {
      out[outFrame * channels + c] = dotStrided(row, rowOffset, x, xFrame * channels + c, channels, taps);
    }
  }
}

/**
 * Kernel rows are not all different: a row whose fractional offset is 0 is symmetric about its
 * centre tap (halfTaps - 1) and a row at offset 1/2 is a palindrome, so those outputs fold
 * x[j] + x[mirror] and need half the multiplies.
 */
const ROW_ASYMMETRIC = 0;
const ROW_CENTRE_SYMMETRIC = 1;
const ROW_PALINDROME = 2;

/** Outputs k x L + firstOutput for k in [firstPeriod, periods) with an arbitrary kernel row. */
function convolveRowAsymmetric(
  plan: PolyPlan,
  x: Float64Array,
  channels: number,
  out: Float64Array,
  rowOffset: number,
  base: number,
  firstPeriod: number,
  periods: number,
  firstOutput: number,
  count: number
): void {
  const { taps, table, upFactor, downFactor } = plan;
  for (let k = firstPeriod; k < periods; k++) {
    const n = (k * upFactor + firstOutput) | 0;
    if (n >= count) break;
    const xFrame = (k * downFactor + base) | 0;
    if (channels === STEREO && n + upFactor < count) {
      // Two consecutive periods share the kernel row: one coefficient load feeds four sums.
      let la0 = 0;
      let la1 = 0;
      let ra0 = 0;
      let ra1 = 0;
      let lb0 = 0;
      let lb1 = 0;
      let rb0 = 0;
      let rb1 = 0;
      let qa = (xFrame * STEREO) | 0;
      let qb = (qa + downFactor * STEREO) | 0;
      for (let j = 0; j < taps; j += 2) {
        const t = (rowOffset + j) | 0;
        const c0 = table[t];
        const c1 = table[t + 1];
        la0 += c0 * x[qa];
        ra0 += c0 * x[qa + 1];
        lb0 += c0 * x[qb];
        rb0 += c0 * x[qb + 1];
        la1 += c1 * x[qa + 2];
        ra1 += c1 * x[qa + 3];
        lb1 += c1 * x[qb + 2];
        rb1 += c1 * x[qb + 3];
        qa = (qa + 2 * STEREO) | 0;
        qb = (qb + 2 * STEREO) | 0;
      }
      out[n * STEREO] = la0 + la1;
      out[n * STEREO + 1] = ra0 + ra1;
      out[(n + upFactor) * STEREO] = lb0 + lb1;
      out[(n + upFactor) * STEREO + 1] = rb0 + rb1;
      k++;
    } else if (channels === STEREO) {
      let left0 = 0;
      let left1 = 0;
      let left2 = 0;
      let left3 = 0;
      let right0 = 0;
      let right1 = 0;
      let right2 = 0;
      let right3 = 0;
      let q = (xFrame * STEREO) | 0;
      for (let j = 0; j < taps; j += TAP_UNROLL) {
        const t = (rowOffset + j) | 0;
        const c0 = table[t];
        const c1 = table[t + 1];
        const c2 = table[t + 2];
        const c3 = table[t + 3];
        left0 += c0 * x[q];
        right0 += c0 * x[q + 1];
        left1 += c1 * x[q + 2];
        right1 += c1 * x[q + 3];
        left2 += c2 * x[q + 4];
        right2 += c2 * x[q + 5];
        left3 += c3 * x[q + 6];
        right3 += c3 * x[q + 7];
        q = (q + 2 * TAP_UNROLL) | 0;
      }
      out[n * STEREO] = left0 + left1 + (left2 + left3);
      out[n * STEREO + 1] = right0 + right1 + (right2 + right3);
    } else if (channels === 1) {
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      let s3 = 0;
      let q = xFrame;
      for (let j = 0; j < taps; j += TAP_UNROLL) {
        const t = (rowOffset + j) | 0;
        s0 += table[t] * x[q];
        s1 += table[t + 1] * x[q + 1];
        s2 += table[t + 2] * x[q + 2];
        s3 += table[t + 3] * x[q + 3];
        q = (q + TAP_UNROLL) | 0;
      }
      out[n] = s0 + s1 + (s2 + s3);
    } else {
      dotFrame(table, rowOffset, x, xFrame, channels, taps, out, n);
    }
  }
}

/** Same outputs for a row symmetric about its centre tap c = halfTaps - 1 (the last tap is zero). */
function convolveRowCentreSymmetric(
  plan: PolyPlan,
  x: Float64Array,
  channels: number,
  out: Float64Array,
  rowOffset: number,
  base: number,
  firstPeriod: number,
  periods: number,
  firstOutput: number,
  count: number
): void {
  const { halfTaps, table, upFactor, downFactor, taps } = plan;
  const centre = (halfTaps - 1) | 0;
  const pairs = centre; // odd: taps 0 .. centre - 1 mirror taps 2 centre .. centre + 1
  const centreCoefficient = table[rowOffset + centre];
  for (let k = firstPeriod; k < periods; k++) {
    const n = (k * upFactor + firstOutput) | 0;
    if (n >= count) break;
    const xFrame = (k * downFactor + base) | 0;
    if (channels === STEREO) {
      let l0 = 0;
      let l1 = 0;
      let r0 = 0;
      let r1 = 0;
      let lo = (xFrame * STEREO) | 0;
      let hi = ((xFrame + 2 * centre) * STEREO) | 0;
      let j = 0;
      for (; j + 1 < pairs; j += 2) {
        const h0 = table[rowOffset + j];
        const h1 = table[rowOffset + j + 1];
        l0 += h0 * (x[lo] + x[hi]);
        r0 += h0 * (x[lo + 1] + x[hi + 1]);
        l1 += h1 * (x[lo + 2] + x[hi - 2]);
        r1 += h1 * (x[lo + 3] + x[hi - 1]);
        lo = (lo + 2 * STEREO) | 0;
        hi = (hi - 2 * STEREO) | 0;
      }
      const hLast = table[rowOffset + j];
      l0 += hLast * (x[lo] + x[hi]);
      r0 += hLast * (x[lo + 1] + x[hi + 1]);
      const mid = ((xFrame + centre) * STEREO) | 0;
      out[n * STEREO] = centreCoefficient * x[mid] + (l0 + l1);
      out[n * STEREO + 1] = centreCoefficient * x[mid + 1] + (r0 + r1);
    } else if (channels === 1) {
      let s0 = 0;
      let s1 = 0;
      let lo = xFrame;
      let hi = (xFrame + 2 * centre) | 0;
      let j = 0;
      for (; j + 1 < pairs; j += 2) {
        s0 += table[rowOffset + j] * (x[lo] + x[hi]);
        s1 += table[rowOffset + j + 1] * (x[lo + 1] + x[hi - 1]);
        lo = (lo + 2) | 0;
        hi = (hi - 2) | 0;
      }
      s0 += table[rowOffset + j] * (x[lo] + x[hi]);
      out[n] = centreCoefficient * x[xFrame + centre] + (s0 + s1);
    } else {
      dotFrame(table, rowOffset, x, xFrame, channels, taps, out, n);
    }
  }
}

/** Same outputs for a palindromic row: tap j equals tap taps - 1 - j. */
function convolveRowPalindrome(
  plan: PolyPlan,
  x: Float64Array,
  channels: number,
  out: Float64Array,
  rowOffset: number,
  base: number,
  firstPeriod: number,
  periods: number,
  firstOutput: number,
  count: number
): void {
  const { taps, table, upFactor, downFactor } = plan;
  const pairs = (taps / 2) | 0; // even
  for (let k = firstPeriod; k < periods; k++) {
    const n = (k * upFactor + firstOutput) | 0;
    if (n >= count) break;
    const xFrame = (k * downFactor + base) | 0;
    if (channels === STEREO) {
      let l0 = 0;
      let l1 = 0;
      let r0 = 0;
      let r1 = 0;
      let lo = (xFrame * STEREO) | 0;
      let hi = ((xFrame + taps - 1) * STEREO) | 0;
      for (let j = 0; j < pairs; j += 2) {
        const h0 = table[rowOffset + j];
        const h1 = table[rowOffset + j + 1];
        l0 += h0 * (x[lo] + x[hi]);
        r0 += h0 * (x[lo + 1] + x[hi + 1]);
        l1 += h1 * (x[lo + 2] + x[hi - 2]);
        r1 += h1 * (x[lo + 3] + x[hi - 1]);
        lo = (lo + 2 * STEREO) | 0;
        hi = (hi - 2 * STEREO) | 0;
      }
      out[n * STEREO] = l0 + l1;
      out[n * STEREO + 1] = r0 + r1;
    } else if (channels === 1) {
      let s0 = 0;
      let s1 = 0;
      let lo = xFrame;
      let hi = (xFrame + taps - 1) | 0;
      for (let j = 0; j < pairs; j += 2) {
        s0 += table[rowOffset + j] * (x[lo] + x[hi]);
        s1 += table[rowOffset + j + 1] * (x[lo + 1] + x[hi - 1]);
        lo = (lo + 2) | 0;
        hi = (hi - 2) | 0;
      }
      out[n] = s0 + s1;
    } else {
      dotFrame(table, rowOffset, x, xFrame, channels, taps, out, n);
    }
  }
}

/**
 * One polyphase stage's view of a WebAssembly kernel instance: the coefficient table, the stage input and the stage output
 * live in the kernel's linear memory, and the input and output arrays of the stage are views onto it, so the scalar rows
 * (symmetric ones) and the SIMD rows read and write the same bytes and nothing is copied per row.
 */
class SimdPolyState {
  private constructor(
    readonly kernel: MacKernel,
    readonly tablePtr: number,
    readonly xPtr: number,
    readonly outPtr: number,
    readonly xView: Float64Array,
    readonly outView: Float64Array
  ) {}

  /** Returns null when the kernels cannot be used for this stage (no SIMD here, other channel count, memory bound). */
  static create(plan: PolyPlan, channels: number, inputSamples: number, outputSamples: number): SimdPolyState | null {
    if (plan.mode !== 'exact' || channels < SIMD_MIN_CHANNELS || channels > SIMD_MAX_CHANNELS || !macKernelSupported()) return null;
    const align = (bytes: number): number => Math.ceil(bytes / KERNEL_ALIGN_BYTES) * KERNEL_ALIGN_BYTES;
    const tableBytes = align(plan.table.length * DOUBLE_BYTES);
    const xBytes = align(inputSamples * DOUBLE_BYTES);
    const outBytes = align(outputSamples * DOUBLE_BYTES);
    if (tableBytes + xBytes + outBytes > MAC_MEMORY_MAX_BYTES) return null;
    const kernel = createMacKernel(tableBytes + xBytes + outBytes);
    if (kernel === null) return null;
    const xPtr = tableBytes;
    const outPtr = tableBytes + xBytes;
    new Float64Array(kernel.memory.buffer, 0, plan.table.length).set(plan.table);
    return new SimdPolyState(
      kernel,
      0,
      xPtr,
      outPtr,
      new Float64Array(kernel.memory.buffer, xPtr, inputSamples),
      new Float64Array(kernel.memory.buffer, outPtr, outputSamples)
    );
  }
}

/**
 * Exact polyphase for output frames [start, start + count): output n = k x L + r uses kernel row
 * (r x M) mod L at input offset k x M + floor(r x M / L) (relative to the first output's
 * position). Residue-major order keeps one kernel row hot in cache across the block's periods.
 * Hot loops are written out in full: the JIT inliner is not relied on (when it declined,
 * throughput dropped by a third).
 */
function convolveExactBlock(
  plan: PolyPlan,
  x: Float64Array,
  channels: number,
  start: number,
  count: number,
  dst: Float64Array,
  simd: SimdPolyState | null
): void {
  const { taps, upFactor, downFactor, residueRow, residueBase, residueSymmetry } = plan;
  // With the SIMD kernels the block is computed in kernel memory and copied to `dst` once, after every row is done.
  const out = simd === null || count * channels > simd.outView.length ? dst : simd.outView;
  const useSimd = simd !== null && out === simd.outView;
  const periodStart = Math.floor(start / upFactor);
  // Block-local quantities are small, so they are forced to int32 for index arithmetic.
  const periods = (Math.floor((start + count - 1) / upFactor) - periodStart + 1) | 0;
  const startResidue = (start - periodStart * upFactor) | 0;
  const periodInput = (periodStart * downFactor - Math.floor((start * downFactor) / upFactor)) | 0;
  for (let r = 0; r < upFactor; r++) {
    const rowOffset = (residueRow[r] * taps) | 0;
    const base = (periodInput + residueBase[r]) | 0;
    // The first period holds outputs from `startResidue` on; earlier residues start one period later.
    const firstPeriod = r >= startResidue ? 0 : 1;
    const firstOutput = (r - startResidue) | 0;
    const symmetry = residueSymmetry[r];
    if (symmetry === ROW_CENTRE_SYMMETRIC) {
      convolveRowCentreSymmetric(plan, x, channels, out, rowOffset, base, firstPeriod, periods, firstOutput, count);
    } else if (symmetry === ROW_PALINDROME) {
      convolveRowPalindrome(plan, x, channels, out, rowOffset, base, firstPeriod, periods, firstOutput, count);
    } else if (useSimd) {
      const row = simd.tablePtr + rowOffset * DOUBLE_BYTES;
      const run = channels === STEREO ? simd.kernel.rowStereo : simd.kernel.rowMono;
      try {
        run(row, simd.xPtr, simd.outPtr, taps, upFactor, downFactor, base, firstPeriod, periods, firstOutput, count);
      } catch (error) {
        throw new AudioResampleError(`The SIMD resampler kernel failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      convolveRowAsymmetric(plan, x, channels, out, rowOffset, base, firstPeriod, periods, firstOutput, count);
    }
  }
  if (useSimd) dst.set(out.subarray(0, count * channels));
}

/** Oversampled rows: the row for each output is linearly interpolated once, then shared by all channels. */
function convolveInterpolatedBlock(
  plan: PolyPlan,
  x: Float64Array,
  channels: number,
  rem0: number,
  count: number,
  out: Float64Array,
  rowScratch: Float64Array
): void {
  const { taps, table, upFactor, quotient, remainder, rowScale } = plan;
  let pos = 0;
  let rem = rem0;
  for (let i = 0; i < count; i++) {
    const position = rem * rowScale;
    const lowRow = Math.floor(position);
    const weight = position - lowRow;
    const rowA = lowRow * taps;
    const rowB = rowA + taps;
    for (let j = 0; j < taps; j++) {
      const a = table[rowA + j];
      rowScratch[j] = a + weight * (table[rowB + j] - a);
    }
    dotFrame(rowScratch, 0, x, pos, channels, taps, out, i);
    pos += quotient;
    rem += remainder;
    if (rem >= upFactor) {
      rem -= upFactor;
      pos++;
    }
  }
}

/** Channel-interleaved sample access, called once per block (never per sample). */
interface ChannelIo {
  readonly channels: number;
  /** Fill dst[0 .. count x channels) with input frames [start, start + count); zeros outside the signal. */
  load(start: number, count: number, dst: Float64Array): void;
  /** Write `count` finished frames, starting at output frame `start`, from channel-interleaved `src`. */
  store(start: number, count: number, src: Float64Array): void;
}

// ---------------------------------------------------------------------------------------------
// Pull pipeline: every stage computes frames [start, start + count) of its own signal on demand
// from the stage before it, so no whole-signal intermediate buffer exists.
// ---------------------------------------------------------------------------------------------

interface FrameSource {
  /** Fill dst[0 .. count x channels) with frames [start, start + count); zeros outside [0, length). */
  produce(start: number, count: number, dst: Float64Array): void;
}

class SignalSource implements FrameSource {
  constructor(private readonly io: ChannelIo) {}

  produce(start: number, count: number, dst: Float64Array): void {
    this.io.load(start, count, dst);
  }
}

class HalfBandDecimateStage implements FrameSource {
  private readonly input: Float64Array;

  constructor(
    private readonly upstream: FrameSource,
    private readonly filter: HalfBandFilter,
    private readonly channels: number,
    inputSpan: number
  ) {
    this.input = new Float64Array(inputSpan * channels);
  }

  produce(start: number, count: number, dst: Float64Array): void {
    const span = halfBandDecimateSpan(this.filter, count);
    this.upstream.produce(2 * start - this.filter.reach, span, this.input);
    halfBandDecimateBlock(this.filter, this.input, this.channels, count, dst);
  }
}

class HalfBandInterpolateStage implements FrameSource {
  private readonly input: Float64Array;

  constructor(
    private readonly upstream: FrameSource,
    private readonly filter: HalfBandFilter,
    private readonly channels: number,
    inputSpan: number
  ) {
    this.input = new Float64Array(inputSpan * channels);
  }

  produce(start: number, count: number, dst: Float64Array): void {
    const firstInput = Math.floor(start / 2) - this.filter.pairs + 1;
    const lastInput = Math.floor((start + count - 1) / 2) + this.filter.pairs;
    this.upstream.produce(firstInput, lastInput - firstInput + 1, this.input);
    halfBandInterpolateBlock(this.filter, this.input, this.channels, start, count, dst);
  }
}

class PolyphaseStage implements FrameSource {
  private readonly input: Float64Array;
  private readonly rowScratch: Float64Array;

  constructor(
    private readonly upstream: FrameSource,
    private readonly plan: PolyPlan,
    private readonly channels: number,
    inputSpan: number,
    private readonly simd: SimdPolyState | null
  ) {
    // The upstream stage writes straight into kernel memory when the SIMD kernels run this stage.
    this.input = simd === null ? new Float64Array(inputSpan * channels) : simd.xView;
    this.rowScratch = new Float64Array(plan.mode === 'exact' ? 0 : plan.taps);
  }

  produce(start: number, count: number, dst: Float64Array): void {
    const { halfTaps, upFactor, downFactor, mode } = this.plan;
    // Exact rational input position start x M / L as integer quotient and remainder.
    const scaled = start * downFactor;
    let pos0 = Math.floor(scaled / upFactor);
    let rem0 = scaled - pos0 * upFactor;
    while (rem0 < 0) {
      pos0--;
      rem0 += upFactor;
    }
    while (rem0 >= upFactor) {
      pos0++;
      rem0 -= upFactor;
    }
    const firstInput = pos0 - halfTaps + 1;
    const lastPos = pos0 + Math.floor((rem0 + (count - 1) * downFactor) / upFactor);
    this.upstream.produce(firstInput, lastPos + halfTaps - firstInput + 1, this.input);
    if (mode === 'exact') {
      convolveExactBlock(this.plan, this.input, this.channels, start, count, dst, this.simd);
    } else {
      convolveInterpolatedBlock(this.plan, this.input, this.channels, rem0, count, dst, this.rowScratch);
    }
  }

  static inputSpan(plan: PolyPlan, count: number): number {
    return Math.ceil((count * plan.downFactor) / plan.upFactor) + plan.taps + 2;
  }
}

/**
 * Builds the stage chain for `plan` and returns its last stage plus the output block size.
 * Stage input scratch sizes follow from the block size backwards through the chain.
 */
function buildPipeline(
  plan: ResamplerPlan,
  io: ChannelIo,
  kernel: ResampleKernel
): { source: FrameSource; blockFrames: number; kernelUsed: ResampleKernelUsed } {
  const { poly, halfBands, halfBandsFirst } = plan;
  const channels = io.channels;
  const exactPoly = poly.mode === 'exact';
  const polyLast = halfBandsFirst || halfBands.length === 0;
  // An exact polyphase last stage works on whole periods of L outputs; otherwise any block size.
  const wholePeriods = polyLast && exactPoly;

  type Kind = { kind: 'decimate' | 'interpolate'; filter: HalfBandFilter } | { kind: 'poly' };
  const order: Kind[] = [];
  const halfBandKinds: Kind[] = halfBands.map((filter) => ({
    kind: halfBandsFirst ? 'decimate' : 'interpolate',
    filter,
  }));
  if (halfBandsFirst) order.push(...halfBandKinds, { kind: 'poly' });
  else order.push({ kind: 'poly' }, ...halfBandKinds);

  // Scratch needed by stage i = frames it requests from stage i - 1, derived from the last stage.
  const requestsFor = (blockSize: number): number[] => {
    const requests = new Array<number>(order.length);
    let count = blockSize;
    for (let i = order.length - 1; i >= 0; i--) {
      const stage = order[i];
      if (stage.kind === 'poly') count = PolyphaseStage.inputSpan(poly, count);
      else if (stage.kind === 'decimate') count = halfBandDecimateSpan(stage.filter, count);
      else count = halfBandInterpolateMaxSpan(stage.filter, count);
      requests[i] = count;
    }
    return requests;
  };

  // Halve the block until the scratch of every stage fits: channels x cascade depth x ratio.
  let periods = Math.max(1, Math.floor(BLOCK_OUT_FRAMES / poly.upFactor));
  let blockFrames = wholePeriods ? periods * poly.upFactor : BLOCK_OUT_FRAMES;
  let requests = requestsFor(blockFrames);
  const scratchOf = (frames: number[]): number => frames.reduce((sum, n) => sum + n * channels, 0);
  while (scratchOf(requests) > MAX_SCRATCH_SAMPLES) {
    if (wholePeriods && periods > 1) {
      periods = Math.floor(periods / 2);
      blockFrames = periods * poly.upFactor;
    } else if (!wholePeriods && blockFrames > MIN_BLOCK_FRAMES) {
      blockFrames = Math.max(MIN_BLOCK_FRAMES, Math.floor(blockFrames / 2));
    } else {
      throw new AudioResampleError(
        `Resampling ${channels} channels at ratio ${plan.totalUp}:${plan.totalDown} exceeds the supported block size`
      );
    }
    requests = requestsFor(blockFrames);
  }

  // Stages are not truncated at the signal edges: each one computes its response to the
  // zero-extended signal, so a cascade matches the same signal padded with silence.
  let source: FrameSource = new SignalSource(io);
  let kernelUsed: ResampleKernelUsed = 'scalar';
  for (let i = 0; i < order.length; i++) {
    const stage = order[i];
    if (stage.kind === 'poly') {
      // Most output frames this stage is asked for in one call: the block, or what the next stage requests of it.
      const outputFrames = i === order.length - 1 ? blockFrames : requests[i + 1];
      const simd = kernel === 'scalar' ? null : SimdPolyState.create(poly, channels, requests[i] * channels, outputFrames * channels);
      if (simd === null && kernel === 'simd') {
        throw new AudioResampleError('The SIMD resampler kernel was requested but is not available for this stage');
      }
      if (simd !== null) kernelUsed = 'simd-f64x2';
      source = new PolyphaseStage(source, poly, channels, requests[i], simd);
    } else if (stage.kind === 'decimate') source = new HalfBandDecimateStage(source, stage.filter, channels, requests[i]);
    else source = new HalfBandInterpolateStage(source, stage.filter, channels, requests[i]);
  }
  return { source, blockFrames, kernelUsed };
}

function runResampler(
  plan: ResamplerPlan,
  io: ChannelIo,
  outFrames: number,
  quantizer: DitherQuantizer | null,
  options: ResampleOptions
): void {
  const channels = io.channels;
  const { source, blockFrames, kernelUsed } = buildPipeline(plan, io, resolveKernel(options));
  if (options.report !== undefined) options.report.kernel = kernelUsed;
  const raw = new Float64Array(blockFrames * channels);
  const quantized = quantizer ? new Float64Array(blockFrames * channels) : raw;
  for (let n0 = 0; n0 < outFrames; n0 += blockFrames) {
    const count = Math.min(blockFrames, outFrames - n0);
    source.produce(n0, count, raw);
    if (quantizer) quantizer.quantize(raw, count * channels, quantized);
    io.store(n0, count, quantized);
  }
}

function resolveOutputBitDepth(options: ResampleOptions, fallback: ResampleOutputBitDepth): ResampleOutputBitDepth {
  const depth = options.outputBitDepth ?? fallback;
  if (!KNOWN_BIT_DEPTHS.has(depth)) {
    throw new AudioResampleError(`Unsupported output bit depth ${String(depth)}`);
  }
  return depth;
}

function resolveKernel(options: ResampleOptions): ResampleKernel {
  const kernel = options.kernel ?? 'auto';
  if (!KNOWN_KERNELS.has(kernel)) {
    throw new AudioResampleError(`Unsupported resampler kernel ${String(kernel)}`);
  }
  return kernel;
}

function resolveSeed(options: ResampleOptions): number {
  const seed = options.ditherSeed ?? DEFAULT_DITHER_SEED;
  if (!Number.isInteger(seed)) {
    throw new AudioResampleError(`Dither seed must be an integer, got ${seed}`);
  }
  return seed;
}

function resolveQuality(options: ResampleOptions): ResampleQuality {
  const quality = options.quality ?? 'standard';
  validateQuality(quality);
  return quality;
}

/** Samples quantised per pass when the rates are equal and only the output depth changes. */
const IDENTITY_CHUNK_SAMPLES = 4096;

/** Copies `src` into a new array, rounding to the dither grid when `quantizer` is given. */
function copyQuantized<T extends Int16Array | Float32Array>(
  src: T,
  create: (length: number) => T,
  quantizer: DitherQuantizer | null
): T {
  if (quantizer === null) return src.slice() as T;
  const out = create(src.length);
  const chunk = new Float64Array(IDENTITY_CHUNK_SAMPLES);
  const rounded = new Float64Array(IDENTITY_CHUNK_SAMPLES);
  for (let start = 0; start < src.length; start += IDENTITY_CHUNK_SAMPLES) {
    const count = Math.min(IDENTITY_CHUNK_SAMPLES, src.length - start);
    for (let i = 0; i < count; i++) chunk[i] = src[start + i];
    quantizer.quantize(chunk, count, rounded);
    for (let i = 0; i < count; i++) out[start + i] = rounded[i];
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

/**
 * Resample planar float channels (nominal full scale +-1). Output is Float32 unless
 * `outputBitDepth` is 8 or 16, in which case values are quantised to that grid with TPDF dither.
 */
export function resamplePlanarFloat(
  channelData: Float32Array[],
  srcRate: number,
  tgtRate: number,
  options: ResampleOptions = {}
): Float32Array[] {
  validateRates(srcRate, tgtRate);
  if (channelData.length === 0) {
    throw new AudioResampleError('At least one audio channel is required');
  }
  validateChannels(channelData.length);
  const quality = resolveQuality(options);
  const depth = resolveOutputBitDepth(options, 'float');
  const seed = resolveSeed(options);
  const inFrames = channelData[0].length;
  for (const ch of channelData) {
    if (ch.length !== inFrames) {
      throw new AudioResampleError('All audio channels must have the same length');
    }
  }
  let quantizer: DitherQuantizer | null = null;
  if (DITHERED_BIT_DEPTHS.has(depth)) {
    const bits = depth as number;
    const lsb = 2 ** (1 - bits);
    quantizer = new DitherQuantizer(lsb, -1, 1 - lsb, seed);
  }
  if (srcRate === tgtRate || inFrames === 0) {
    // Equal rates: still copy (never alias the caller's data) and honour the requested depth.
    return channelData.map((ch) => copyQuantized(ch, (n) => new Float32Array(n), quantizer));
  }

  const plan = getPlan(srcRate, tgtRate, quality);
  const outFrames = validateOutputFrames(inFrames, plan, channelData.length, FLOAT32_BYTES);
  const outputs = channelData.map(() => new Float32Array(outFrames));

  const channels = channelData.length;
  const io: ChannelIo = {
    channels,
    load(start, count, dst) {
      const from = Math.max(0, start);
      const to = Math.min(inFrames, start + count);
      dst.fill(0, 0, count * channels);
      for (let c = 0; c < channels; c++) {
        const src = channelData[c];
        for (let i = from; i < to; i++) {
          const v = src[i];
          if (!Number.isFinite(v)) {
            throw new AudioResampleError(`Non-finite audio sample at frame ${i} of channel ${c}`);
          }
          dst[(i - start) * channels + c] = v;
        }
      }
    },
    store(start, count, src) {
      for (let c = 0; c < channels; c++) {
        const out = outputs[c];
        for (let i = 0; i < count; i++) out[start + i] = src[i * channels + c];
      }
    },
  };

  runResampler(plan, io, outFrames, quantizer, options);
  return outputs;
}

/**
 * Resample interleaved 16-bit PCM. Output is 16-bit PCM quantised with TPDF dither at 1 LSB
 * (`outputBitDepth` 16, default) or at the 8-bit step (`outputBitDepth` 8).
 */
export function resampleInterleavedInt16(
  data: Int16Array,
  srcRate: number,
  tgtRate: number,
  channels: number,
  options: ResampleOptions = {}
): Int16Array {
  validateRates(srcRate, tgtRate);
  validateChannels(channels);
  const quality = resolveQuality(options);
  const depth = resolveOutputBitDepth(options, INT16_BITS);
  if (!SUPPORTED_INT16_OUTPUT_BITS.has(depth as number)) {
    throw new AudioResampleError(`Int16 resampling supports 8 or 16 bit output, got ${String(depth)}`);
  }
  const seed = resolveSeed(options);
  if (data.length % channels !== 0) {
    throw new AudioResampleError(
      `Interleaved sample count ${data.length} is not a multiple of the channel count ${channels}`
    );
  }
  const lsb = 2 ** (INT16_BITS - (depth as number));
  if (srcRate === tgtRate || data.length === 0) {
    // Equal rates: a new array; 16-bit samples already sit on the 16-bit grid, 8-bit output is dithered.
    const identityQuantizer = lsb > 1 ? new DitherQuantizer(lsb, INT16_MIN, INT16_MAX + 1 - lsb, seed) : null;
    return copyQuantized(data, (n) => new Int16Array(n), identityQuantizer);
  }

  const inFrames = data.length / channels;
  const plan = getPlan(srcRate, tgtRate, quality);
  const outFrames = validateOutputFrames(inFrames, plan, channels, INT16_BYTES);
  const output = new Int16Array(outFrames * channels);

  const io: ChannelIo = {
    channels,
    load(start, count, dst) {
      const from = Math.max(0, start);
      const to = Math.min(inFrames, start + count);
      dst.fill(0, 0, count * channels);
      const dstBase = (from - start) * channels;
      const srcBase = from * channels;
      const length = (to - from) * channels;
      for (let t = 0; t < length; t++) dst[dstBase + t] = data[srcBase + t];
    },
    store(start, count, src) {
      const base = start * channels;
      const length = count * channels;
      for (let t = 0; t < length; t++) output[base + t] = src[t];
    },
  };

  const quantizer = new DitherQuantizer(lsb, INT16_MIN, INT16_MAX + 1 - lsb, seed);
  runResampler(plan, io, outFrames, quantizer, options);
  return output;
}
