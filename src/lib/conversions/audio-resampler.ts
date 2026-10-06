/**
 * Bandlimited polyphase audio resampler.
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
 *  - Coefficient tables are built once per (ratio, quality) and kept in a bounded cache.
 *  - Integer output is quantised with seeded TPDF dither; float and 24/32-bit output never is.
 */
import { ConversionFailedError } from '../types';

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
}

// ---------------------------------------------------------------------------------------------
// Limits (all inputs are untrusted)
// ---------------------------------------------------------------------------------------------

export const MIN_RESAMPLE_RATE_HZ = 1000;
export const MAX_RESAMPLE_RATE_HZ = 768000;
/** Largest decimation or interpolation factor; bounds the filter length (taps ~ 160 x ratio). */
export const MAX_RESAMPLE_RATIO = 64;
export const MAX_RESAMPLE_CHANNELS = 32;
/** Upper bound on output samples (frames x channels) allocated by one call. */
export const MAX_RESAMPLE_OUTPUT_SAMPLES = 2 ** 30;
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
const INT16_MIN = -32768;
const INT16_MAX = 32767;
const INT16_BITS = 16;
const SUPPORTED_INT16_OUTPUT_BITS = new Set<number>([8, INT16_BITS]);
const DITHERED_BIT_DEPTHS = new Set<ResampleOutputBitDepth>([8, 16]);
const KNOWN_BIT_DEPTHS = new Set<ResampleOutputBitDepth>([8, 16, 24, 32, 'float']);
const KNOWN_QUALITIES = new Set<ResampleQuality>(['standard', 'high']);
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

const KAISER_BETA_HIGH_ATTENUATION_DB = 50;
const KAISER_BETA_LOW_ATTENUATION_DB = 21;
const KAISER_BETA_SLOPE = 0.1102;
const KAISER_BETA_OFFSET_DB = 8.7;
const KAISER_BETA_MID_EXPONENT = 0.4;
const KAISER_BETA_MID_COEFFICIENT_A = 0.5842;
const KAISER_BETA_MID_COEFFICIENT_B = 0.07886;
const KAISER_LENGTH_OFFSET_DB = 8;
const KAISER_LENGTH_SLOPE = 2.285;
const BESSEL_MAX_TERMS = 200;
const BESSEL_TOLERANCE = 1e-17;
const TWO_PI = 2 * Math.PI;
/** Kernel taps per phase are a multiple of this (unrolled accumulators). */
const TAP_UNROLL = 4;
/** |pi x| below this is treated as the sinc limit 1. */
const SINC_ARGUMENT_EPSILON = 1e-12;

/** Kaiser window shape parameter for a stopband attenuation in dB (Kaiser 1974). */
function kaiserBeta(attenuationDb: number): number {
  if (attenuationDb > KAISER_BETA_HIGH_ATTENUATION_DB) {
    return KAISER_BETA_SLOPE * (attenuationDb - KAISER_BETA_OFFSET_DB);
  }
  if (attenuationDb >= KAISER_BETA_LOW_ATTENUATION_DB) {
    const d = attenuationDb - KAISER_BETA_LOW_ATTENUATION_DB;
    return KAISER_BETA_MID_COEFFICIENT_A * d ** KAISER_BETA_MID_EXPONENT + KAISER_BETA_MID_COEFFICIENT_B * d;
  }
  return 0;
}

/** Zeroth-order modified Bessel function of the first kind, by its power series. */
function besselI0(x: number): number {
  const q = (x * x) / 4;
  let term = 1;
  let sum = 1;
  for (let k = 1; k <= BESSEL_MAX_TERMS; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * BESSEL_TOLERANCE) break;
  }
  return sum;
}

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

interface ResamplerPlan extends ResamplerPlanInfo {
  halfTaps: number;
  /** floor(M / L) and M mod L: per-output integer advance of the input position. */
  quotient: number;
  remainder: number;
  /** Interpolated mode: oversampled rows per unit of the remainder, i.e. phaseRows / L. */
  rowScale: number;
  /** Exact mode, per output residue r = n mod L: kernel row index and whole-sample input offset. */
  residueRow: Int32Array;
  residueBase: Int32Array;
  table: Float64Array;
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

function designPlan(srcRate: number, tgtRate: number, quality: ResampleQuality): ResamplerPlan {
  const divisor = gcd(srcRate, tgtRate);
  const upFactor = tgtRate / divisor;
  const downFactor = srcRate / divisor;
  const preset = FILTER_PRESETS[quality];
  const beta = kaiserBeta(preset.attenuationDb);

  // Everything below is in cycles per INPUT sample. The lower Nyquist, expressed there, is
  // 0.5 x min(1, tgt/src): this is what makes the filter length scale with 1 / cutoff.
  const lowerNyquist = 0.5 * Math.min(1, tgtRate / srcRate);
  const cutoff = preset.cutoff * lowerNyquist;
  const transitionWidth = preset.transition * lowerNyquist;
  const tapEstimate =
    (preset.attenuationDb - KAISER_LENGTH_OFFSET_DB) / (KAISER_LENGTH_SLOPE * TWO_PI * transitionWidth);
  let halfTaps = Math.ceil(tapEstimate / 2);
  if (halfTaps % 2 !== 0) halfTaps++;
  const taps = 2 * halfTaps; // multiple of TAP_UNROLL because halfTaps is even

  const exactEntries = upFactor * taps;
  const exact = exactEntries <= MAX_TABLE_ENTRIES;
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
  for (let r = 0; r < residueRow.length; r++) {
    const scaled = r * downFactor;
    residueBase[r] = Math.floor(scaled / upFactor);
    residueRow[r] = scaled - residueBase[r] * upFactor;
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
    tableEntries: table.length,
    beta,
    quotient: Math.floor(downFactor / upFactor),
    remainder: downFactor % upFactor,
    rowScale: phaseRows / upFactor,
    residueRow,
    residueBase,
    table,
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

/** Design summary for a ratio (also validates the rates); used by tests and diagnostics. */
export function describeResamplerPlan(
  srcRate: number,
  tgtRate: number,
  quality: ResampleQuality = 'standard'
): ResamplerPlanInfo {
  validateRates(srcRate, tgtRate);
  validateQuality(quality);
  const { upFactor, downFactor, taps, mode, phaseRows, tableEntries, beta } = getPlan(srcRate, tgtRate, quality);
  return { upFactor, downFactor, taps, mode, phaseRows, tableEntries, beta };
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

function validateOutputFrames(inputFrames: number, plan: ResamplerPlan, channels: number): number {
  const product = inputFrames * plan.upFactor;
  if (!Number.isSafeInteger(product)) {
    throw new AudioResampleError(`Input of ${inputFrames} frames is too long to resample`);
  }
  const outFrames = Math.floor(product / plan.downFactor);
  if (outFrames * channels > MAX_RESAMPLE_OUTPUT_SAMPLES) {
    throw new AudioResampleError(
      `Resampled output of ${outFrames * channels} samples exceeds the ${MAX_RESAMPLE_OUTPUT_SAMPLES} sample limit`
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
 * Exact polyphase: a block is a whole number of periods of `upFactor` outputs, so output
 * n = k x L + r always uses kernel row (r x M) mod L at input offset k x M + floor(r x M / L).
 * Residue-major order keeps one 1 KiB-scale row hot in cache for every period of the block.
 */
function convolveExactBlock(plan: ResamplerPlan, x: Float64Array, channels: number, count: number, out: Float64Array): void {
  const { taps, table, upFactor, downFactor, residueRow, residueBase } = plan;
  const periods = Math.ceil(count / upFactor);
  for (let r = 0; r < upFactor; r++) {
    const rowOffset = residueRow[r] * taps;
    const base = residueBase[r];
    for (let k = 0; k < periods; k++) {
      const n = k * upFactor + r;
      if (n >= count) break;
      dotFrame(table, rowOffset, x, k * downFactor + base, channels, taps, out, n);
    }
  }
}

/** Oversampled rows: the row for each output is linearly interpolated once, then shared by all channels. */
function convolveInterpolatedBlock(
  plan: ResamplerPlan,
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

function runResampler(
  plan: ResamplerPlan,
  io: ChannelIo,
  outFrames: number,
  quantizer: DitherQuantizer | null
): void {
  const { halfTaps, taps, upFactor, downFactor, mode } = plan;
  const channels = io.channels;
  const exact = mode === 'exact';
  const blockFrames = exact ? Math.max(1, Math.floor(BLOCK_OUT_FRAMES / upFactor)) * upFactor : BLOCK_OUT_FRAMES;
  const maxSpan = Math.ceil((blockFrames * downFactor) / upFactor) + taps + 2;
  if (maxSpan * channels > MAX_SCRATCH_SAMPLES) {
    throw new AudioResampleError(
      `Resampling ${channels} channels at ratio ${upFactor}:${downFactor} exceeds the supported block size`
    );
  }
  const input = new Float64Array(maxSpan * channels);
  const raw = new Float64Array(blockFrames * channels);
  const quantized = quantizer ? new Float64Array(blockFrames * channels) : raw;
  const rowScratch = new Float64Array(exact ? 0 : taps);

  for (let n0 = 0; n0 < outFrames; n0 += blockFrames) {
    const count = Math.min(blockFrames, outFrames - n0);
    // Exact rational input position n0 x M / L as integer quotient and remainder.
    const scaled = n0 * downFactor;
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
    io.load(firstInput, lastPos + halfTaps - firstInput + 1, input);
    if (exact) {
      convolveExactBlock(plan, input, channels, count, raw);
    } else {
      convolveInterpolatedBlock(plan, input, channels, rem0, count, raw, rowScratch);
    }
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
  if (srcRate === tgtRate || inFrames === 0) return channelData.map((ch) => ch.slice());

  const plan = getPlan(srcRate, tgtRate, quality);
  const outFrames = validateOutputFrames(inFrames, plan, channelData.length);
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

  let quantizer: DitherQuantizer | null = null;
  if (DITHERED_BIT_DEPTHS.has(depth)) {
    const bits = depth as number;
    const lsb = 2 ** (1 - bits);
    quantizer = new DitherQuantizer(lsb, -1, 1 - lsb, seed);
  }
  runResampler(plan, io, outFrames, quantizer);
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
  if (srcRate === tgtRate || data.length === 0) return data;

  const inFrames = data.length / channels;
  const plan = getPlan(srcRate, tgtRate, quality);
  const outFrames = validateOutputFrames(inFrames, plan, channels);
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

  const lsb = 2 ** (INT16_BITS - (depth as number));
  const high = INT16_MAX + 1 - lsb;
  const quantizer = new DitherQuantizer(lsb, INT16_MIN, high, seed);
  runResampler(plan, io, outFrames, quantizer);
  return output;
}
