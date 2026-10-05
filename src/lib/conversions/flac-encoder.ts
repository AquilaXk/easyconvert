/**
 * Pure TypeScript FLAC encoder (RFC 9639).
 *
 * Per frame and channel the encoder picks the cheapest of constant, verbatim and fixed
 * (orders 0-4) subframes, removes wasted low bits, and codes residuals with partitioned
 * Rice codes (partition order 0-8, an exact parameter per partition, escape partitions
 * when raw residuals are cheaper).
 *
 * Hot paths work on preallocated Int32Array/Uint32Array/Float64Array buffers and a single
 * fixed-capacity bit writer with a 32-bit accumulator; nothing is allocated per sample.
 * Everything the input can drive is bounded by the named limits below, and unsupported
 * input is rejected with a FlacInputError (a ConversionFailedError).
 */

import crypto from 'node:crypto';
import os from 'node:os';
import { ConversionFailedError } from '../types';

// ============================================================================
// 1. Input contract
// ============================================================================

/** Channel counts the subframe writer implements: mono and stereo. */
export const FLAC_SUPPORTED_CHANNELS: ReadonlySet<number> = new Set([1, 2]);
/** Sample sizes with a frame header code (RFC 9639 section 9.1.4) that the encoder implements. */
export const FLAC_SUPPORTED_BITS_PER_SAMPLE: ReadonlySet<number> = new Set([8, 12, 16, 20, 24]);
export const FLAC_DEFAULT_BITS_PER_SAMPLE = 16;
/** STREAMINFO stores the sample rate in 20 bits and forbids 0 (RFC 9639 section 8.2). */
export const FLAC_MAX_SAMPLE_RATE = (1 << 20) - 1;
export const FLAC_MIN_SAMPLE_RATE = 1;

export class FlacInputError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'FlacInputError';
  }
}

export interface FlacEncodeOptions {
  /** Bits per sample of the values in the input array; defaults to 16. */
  bitsPerSample?: number;
}

function assertSamplesFitBitDepth(samples: Int16Array | Int32Array, bitsPerSample: number): void {
  if (samples instanceof Int16Array && bitsPerSample >= 16) return;
  const low = -(2 ** (bitsPerSample - 1));
  const high = 2 ** (bitsPerSample - 1) - 1;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    if (v < low || v > high) {
      throw new FlacInputError(
        `FLAC sample ${v} at index ${i} is outside the ${bitsPerSample}-bit range [${low}, ${high}].`
      );
    }
  }
}

/**
 * Validates the encoder inputs and returns the number of sample frames (samples per channel).
 */
export function validateFlacInput(
  samples: Int16Array | Int32Array,
  sampleRate: number,
  channels: number,
  bitsPerSample: number
): number {
  if (!(samples instanceof Int16Array) && !(samples instanceof Int32Array)) {
    throw new FlacInputError('FLAC encoder input must be an Int16Array or Int32Array of PCM samples.');
  }
  if (!Number.isInteger(channels) || !FLAC_SUPPORTED_CHANNELS.has(channels)) {
    throw new FlacInputError(
      `FLAC encoder supports only mono and stereo input, received ${channels} channels (Fail-Closed).`
    );
  }
  if (
    !Number.isInteger(sampleRate) ||
    sampleRate < FLAC_MIN_SAMPLE_RATE ||
    sampleRate > FLAC_MAX_SAMPLE_RATE
  ) {
    throw new FlacInputError(
      `FLAC sample rate must be an integer from ${FLAC_MIN_SAMPLE_RATE} to ${FLAC_MAX_SAMPLE_RATE} Hz, received ${sampleRate}.`
    );
  }
  if (!FLAC_SUPPORTED_BITS_PER_SAMPLE.has(bitsPerSample)) {
    throw new FlacInputError(
      `FLAC encoder does not support ${bitsPerSample} bits per sample (supported: ${[...FLAC_SUPPORTED_BITS_PER_SAMPLE].join(', ')}).`
    );
  }
  if (samples.length % channels !== 0) {
    throw new FlacInputError(
      `FLAC input holds ${samples.length} samples, which is not a whole number of ${channels}-channel frames.`
    );
  }
  assertSamplesFitBitDepth(samples, bitsPerSample);
  return samples.length / channels;
}

// ============================================================================
// 2. Format constants (RFC 9639)
// ============================================================================

/** Samples per block; the last block holds the remainder. */
export const FLAC_BLOCK_SIZE = 4096;
/** STREAMINFO block sizes below this are invalid (RFC 9639 section 8.2). */
const FLAC_MIN_STREAMINFO_BLOCK_SIZE = 16;
const MAX_FIXED_ORDER = 4;
const MAX_PARTITION_ORDER = 8;
const PARTITION_SCRATCH_ENTRIES = 2 << MAX_PARTITION_ORDER;

const RICE_PARAM_BITS = 4;
const RICE2_PARAM_BITS = 5;
const RICE_ESCAPE_CODE = 15;
const RICE2_ESCAPE_CODE = 31;
const RICE_MAX_PARAM = 14;
const RICE2_MAX_PARAM = 30;
const ESCAPE_WIDTH_BITS = 5;
const ESCAPE_MAX_WIDTH = 31;
/** Marks an escaped partition in ResidualCoding.params. */
const ESCAPE_MARK = 255;
const RESIDUAL_HEADER_BITS = 6;
const SUBFRAME_HEADER_BITS = 8;
/** Residuals are folded into uint32; keeping them below 2^30 keeps every sum exact. */
const MAX_RESIDUAL_MAGNITUDE = 2 ** 30;
/** Blocks this short pick their fixed order by trying each order directly. */
const SMALL_BLOCK_SAMPLES = 32;

const SUBFRAME_CONSTANT = 0;
const SUBFRAME_VERBATIM = 1;
const SUBFRAME_FIXED = 2;
const SUBFRAME_LPC = 3;
const TYPE_CODE_CONSTANT = 0;
const TYPE_CODE_VERBATIM = 1;
const TYPE_CODE_FIXED = 8;
const TYPE_CODE_LPC = 32;

/** Highest LPC order (RFC 9639 allows 32; 12 is where gains flatten for 16-bit audio). */
export const FLAC_MAX_LPC_ORDER = 12;
/** Blocks shorter than this use fixed predictors only; warm-up and coefficients would cost more. */
const LPC_MIN_BLOCK_SAMPLES = 32;
/** Prediction sums below this magnitude cannot overflow int32 arithmetic. */
const INT32_SUM_LIMIT = 2 ** 31;
const LPC_TAPS_SMALL = 4;
const LPC_TAPS_MEDIUM = 8;
const LPC_TAPS_LARGE = 12;
/**
 * Fixed predictors are coded for real only when their estimated size is within this factor of
 * the best LPC estimate: LPC quantisation costs accuracy on very smooth signals, where exact
 * integer fixed coefficients can win, but far-worse estimates cannot catch up.
 */
const FIXED_CANDIDATE_RATIO = 1.1;
/** Estimates are unreliable near zero residual; below this rate fixed predictors are always tried. */
const FIXED_ALWAYS_BELOW_BITS_PER_SAMPLE = 0.5;
const MIN_QLP_PRECISION = 5;
const MAX_QLP_PRECISION = 15;
const QLP_PRECISION_FIELD_BITS = 4;
const QLP_SHIFT_FIELD_BITS = 5;
const MAX_QLP_SHIFT = 15;
/** Coefficient precisions tried above the default, stopping at the first that does not help. */
const QLP_PRECISION_SEARCH_STEPS = 1;
/** Orders, ranked by estimated bits, that are coded for real and compared. */
const LPC_EXACT_ORDER_CANDIDATES = 1;
const SLOT_LEFT = 0;
const SLOT_RIGHT = 1;
const SLOT_MID = 2;
const SLOT_SIDE = 3;
const STEREO_SLOTS = 4;
/** Tukey window cosine-taper fraction (0.5 = half the block is tapered). */
const TUKEY_TAPER_FRACTION = 0.5;
/** White-noise correction keeping the normal equations well conditioned on pure tones. */
const LPC_REGULARIZATION = 1e-9;
const WINDOW_CACHE_LIMIT = 4;
/** Default precision by block size for 16-bit audio: [largest block size, precision]. */
const QLP_PRECISION_BY_BLOCK: ReadonlyArray<readonly [number, number]> = [
  [192, 7],
  [384, 8],
  [576, 9],
  [1152, 10],
  [2304, 11],
  [4608, 12],
];
const QLP_PRECISION_LARGE_BLOCK = 13;
const QLP_PRECISION_WIDE_SAMPLES = 15;
const QLP_PRECISION_NARROW_FLOOR = 5;

const SYNC_FIXED_BLOCKING = 0xfff8;
const SAMPLE_SIZE_CODES: ReadonlyMap<number, number> = new Map([
  [8, 1],
  [12, 2],
  [16, 4],
  [20, 5],
  [24, 6],
]);
const BLOCK_SIZE_CODES: ReadonlyMap<number, number> = new Map([
  [192, 1],
  [576, 2],
  [1152, 3],
  [2304, 4],
  [4608, 5],
  [256, 8],
  [512, 9],
  [1024, 10],
  [2048, 11],
  [4096, 12],
  [8192, 13],
  [16384, 14],
  [32768, 15],
]);
const BLOCK_SIZE_CODE_EXPLICIT_8 = 6;
const BLOCK_SIZE_CODE_EXPLICIT_16 = 7;
const MAX_EXPLICIT_8_BLOCK = 256;

/** RFC 9639 section 9.1.2: 4-bit sample rate codes that name a rate from the table. */
const FLAC_TABLE_RATE_CODES: ReadonlyMap<number, number> = new Map([
  [88200, 1],
  [176400, 2],
  [192000, 3],
  [8000, 4],
  [16000, 5],
  [22050, 6],
  [24000, 7],
  [32000, 8],
  [44100, 9],
  [48000, 10],
  [96000, 11],
]);
const FLAC_RATE_CODE_KHZ = 12;
const FLAC_RATE_CODE_HZ = 13;
const FLAC_RATE_CODE_TENS_OF_HZ = 14;
const FLAC_RATE_CODE_FROM_STREAMINFO = 0;
const FLAC_MAX_KHZ_FIELD = 255;
const FLAC_MAX_HZ_FIELD = 65535;

/** Chooses the shortest frame-header encoding of a sample rate. */
function flacSampleRateCode(sampleRate: number): number {
  const tableCode = FLAC_TABLE_RATE_CODES.get(sampleRate);
  if (tableCode !== undefined) return tableCode;
  if (sampleRate % 1000 === 0 && sampleRate / 1000 <= FLAC_MAX_KHZ_FIELD) return FLAC_RATE_CODE_KHZ;
  if (sampleRate <= FLAC_MAX_HZ_FIELD) return FLAC_RATE_CODE_HZ;
  if (sampleRate % 10 === 0 && sampleRate / 10 <= FLAC_MAX_HZ_FIELD) return FLAC_RATE_CODE_TENS_OF_HZ;
  return FLAC_RATE_CODE_FROM_STREAMINFO;
}

// ============================================================================
// 3. Checksums
// ============================================================================

export const FLAC_CRC8_TABLE = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let crc = i;
  for (let b = 0; b < 8; b++) {
    crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  FLAC_CRC8_TABLE[i] = crc;
}

export function flacCrc8(data: Uint8Array | Buffer, length = data.length): number {
  let crc = 0;
  for (let i = 0; i < length; i++) {
    crc = FLAC_CRC8_TABLE[crc ^ data[i]];
  }
  return crc;
}

export const FLAC_CRC16_TABLE = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let crc = i << 8;
  for (let b = 0; b < 8; b++) {
    crc = crc & 0x8000 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
  }
  FLAC_CRC16_TABLE[i] = crc;
}

export function flacCrc16(data: Uint8Array | Buffer, length = data.length): number {
  let crc = 0;
  for (let i = 0; i < length; i++) {
    crc = ((crc << 8) ^ FLAC_CRC16_TABLE[((crc >> 8) ^ data[i]) & 0xff]) & 0xffff;
  }
  return crc;
}

// ============================================================================
// 4. Bit writer: one fixed allocation, 32-bit accumulator
// ============================================================================

const ACCUMULATOR_SAFE_BITS = 24;
const BYTE_BITS = 8;
const HALF_WORD_BITS = 16;
const HALF_WORD_MASK = 0xffff;

/**
 * MSB-first bit writer over one fixed-capacity buffer. Pending bits live in a 32-bit
 * accumulator that never holds more than 7 unflushed bits between writes, so a write of up
 * to 24 bits stays within 31 bits. Writes past the capacity are dropped and detected by
 * `bytePosition` exceeding `capacity`; callers size the buffer from a proven worst case.
 */
class FlacBitWriter {
  readonly bytes: Uint8Array;
  readonly capacity: number;
  private pos = 0;
  private acc = 0;
  private accBits = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.bytes = new Uint8Array(capacity);
  }

  reset(): void {
    this.pos = 0;
    this.acc = 0;
    this.accBits = 0;
  }

  get bytePosition(): number {
    return this.pos;
  }

  private writeSmall(value: number, count: number): void {
    this.acc = (this.acc << count) | value;
    this.accBits += count;
    while (this.accBits >= BYTE_BITS) {
      this.accBits -= BYTE_BITS;
      this.bytes[this.pos++] = (this.acc >>> this.accBits) & 0xff;
    }
  }

  /** Writes the low `count` bits (0-32) of the unsigned `value`. */
  writeBits(value: number, count: number): void {
    if (count === 0) return;
    if (count > ACCUMULATOR_SAFE_BITS) {
      this.writeSmall(value >>> HALF_WORD_BITS, count - HALF_WORD_BITS);
      this.writeSmall(value & HALF_WORD_MASK, HALF_WORD_BITS);
    } else {
      this.writeSmall(value, count);
    }
  }

  /** Writes `value` as a `count`-bit two's complement integer (1-31 bits). */
  writeSigned(value: number, count: number): void {
    this.writeBits(value & (2 ** count - 1), count);
  }

  /** Pads the final partial byte with zero bits. */
  alignToByte(): void {
    if (this.accBits > 0) {
      this.bytes[this.pos++] = (this.acc << (BYTE_BITS - this.accBits)) & 0xff;
      this.accBits = 0;
    }
  }

  /** Rice codes `folded[start, end)` with parameter k: q zeros, a one, then k remainder bits. */
  writeRice(folded: Uint32Array, start: number, end: number, k: number): void {
    const bytes = this.bytes;
    const remainderMask = (1 << k) - 1;
    const marker = 1 << k;
    let acc = this.acc;
    let accBits = this.accBits;
    let pos = this.pos;
    for (let i = start; i < end; i++) {
      const u = folded[i];
      const total = (u >>> k) + 1 + k;
      if (total <= ACCUMULATOR_SAFE_BITS) {
        // q zeros, the terminating one and k remainder bits are one (k+1)-bit value in `total` bits.
        acc = (acc << total) | marker | (u & remainderMask);
        accBits += total;
        while (accBits >= BYTE_BITS) {
          accBits -= BYTE_BITS;
          bytes[pos++] = (acc >>> accBits) & 0xff;
        }
      } else {
        this.acc = acc;
        this.accBits = accBits;
        this.pos = pos;
        this.writeLongRice(u, k);
        acc = this.acc;
        accBits = this.accBits;
        pos = this.pos;
      }
    }
    this.acc = acc;
    this.accBits = accBits;
    this.pos = pos;
  }

  private writeLongRice(u: number, k: number): void {
    let zeros = u >>> k;
    while (zeros > ACCUMULATOR_SAFE_BITS) {
      this.writeSmall(0, ACCUMULATOR_SAFE_BITS);
      zeros -= ACCUMULATOR_SAFE_BITS;
    }
    if (zeros > 0) this.writeSmall(0, zeros);
    this.writeSmall(1, 1);
    this.writeBits(u & ((1 << k) - 1), k);
  }
}

// ============================================================================
// 5. Partitioned Rice residual coding (RFC 9639 section 9.2.7)
// ============================================================================

class ResidualCoding {
  /** 0 = Rice (4-bit parameters), 1 = Rice2 (5-bit parameters). */
  method = 0;
  partitionOrder = 0;
  /** Per partition: Rice parameter, or ESCAPE_MARK. */
  readonly params = new Uint8Array(1 << MAX_PARTITION_ORDER);
  /** Per escaped partition: raw residual bit width. */
  readonly escapeWidths = new Uint8Array(1 << MAX_PARTITION_ORDER);
  /** Total residual bits: method, partition order, parameters and payload. */
  bits = 0;
}

// Scratch for codeResidual; encoding is synchronous and non-reentrant.
const partitionSums = new Float64Array(PARTITION_SCRATCH_ENTRIES);
const partitionMaxima = new Float64Array(PARTITION_SCRATCH_ENTRIES);
/** Out-parameter of riceEstimate and refineRiceParameter. */
let chosenRiceParameter = 0;

/** 2^-k for k = 0..30, so estimates multiply instead of divide. */
const INVERSE_POWERS_OF_TWO = new Float64Array(RICE2_MAX_PARAM + 1);
for (let k = 0; k <= RICE2_MAX_PARAM; k++) INVERSE_POWERS_OF_TWO[k] = 2 ** -k;

/** Bit width of the largest folded value, i.e. the signed width that holds every residual. */
function escapeWidth(maxFolded: number): number {
  return maxFolded === 0 ? 0 : 32 - Math.clz32(maxFolded);
}

/**
 * Estimated payload bits (no parameter field) of Rice coding `count` folded values whose sum
 * is `sum`: each value costs k+1 bits plus its quotient, which averages sum/2^k - count/2.
 * Leaves the best parameter in chosenRiceParameter.
 */
function riceEstimate(sum: number, count: number): number {
  if (sum <= 0) {
    chosenRiceParameter = 0;
    return count;
  }
  const mean = sum / count;
  const centre = mean < 1 ? 0 : 31 - Math.clz32(mean);
  const low = centre > 0 ? centre - 1 : 0;
  const high = Math.min(RICE2_MAX_PARAM, centre + 1);
  let bestBits = Number.POSITIVE_INFINITY;
  let bestK = 0;
  const halfCount = count / 2;
  for (let k = low; k <= high; k++) {
    const quotients = Math.max(0, sum * INVERSE_POWERS_OF_TWO[k] - halfCount);
    const bits = count * (k + 1) + quotients;
    if (bits < bestBits) {
      bestBits = bits;
      bestK = k;
    }
  }
  chosenRiceParameter = bestK;
  return bestBits;
}

/** Exact quotient-plus-parameter cost of Rice coding folded[start, end) with parameter k. */
function exactRiceBits(folded: Uint32Array, start: number, end: number, k: number): number {
  let quotients = 0;
  for (let i = start; i < end; i++) quotients += folded[i] >>> k;
  return (end - start) * (k + 1) + quotients;
}

/**
 * Exact payload bits of the best Rice parameter for folded[start, end): counts quotients for
 * the estimate and its neighbours in one pass, then walks outward while the cost still falls.
 * Leaves the parameter in chosenRiceParameter.
 */
function refineRiceParameter(folded: Uint32Array, start: number, end: number, estimate: number): number {
  const count = end - start;
  let low = estimate > 0 ? estimate - 1 : 0;
  if (low + 2 > RICE2_MAX_PARAM) low = RICE2_MAX_PARAM - 2;
  const mid = low + 1;
  const high = low + 2;
  let q0 = 0;
  let q1 = 0;
  let q2 = 0;
  for (let i = start; i < end; i++) {
    const u = folded[i];
    q0 += u >>> low;
    q1 += u >>> mid;
    q2 += u >>> high;
  }
  let bestK = low;
  let bestBits = count * (low + 1) + q0;
  const midBits = count * (mid + 1) + q1;
  const highBits = count * (high + 1) + q2;
  if (midBits < bestBits) {
    bestBits = midBits;
    bestK = mid;
  }
  if (highBits < bestBits) {
    bestBits = highBits;
    bestK = high;
  }
  // The cost is convex in k up to rounding, so an optimum on an edge may continue past it.
  let step = 0;
  if (bestK === high) step = 1;
  else if (bestK === low && low > 0) step = -1;
  while (step !== 0) {
    const next = bestK + step;
    if (next < 0 || next > RICE2_MAX_PARAM) break;
    const bits = exactRiceBits(folded, start, end, next);
    if (bits >= bestBits) break;
    bestBits = bits;
    bestK = next;
  }
  chosenRiceParameter = bestK;
  return bestBits;
}

/**
 * Chooses a parameter (or an escape) for every partition of one partition order from the
 * per-partition sums and maxima in the scratch tree, and totals the residual bits. With
 * `exact` the parameters are counted against the data; otherwise the estimate is used.
 */
function materializePartitions(
  folded: Uint32Array,
  blockSize: number,
  order: number,
  partitionOrder: number,
  coding: ResidualCoding,
  exact: boolean
): number {
  const parts = 1 << partitionOrder;
  const size = blockSize >> partitionOrder;
  let payloadBits = 0;
  let maxParam = 0;
  let index = 0;
  for (let p = 0; p < parts; p++) {
    const count = p === 0 ? size - order : size;
    const end = index + count;
    let riceBits = riceEstimate(partitionSums[parts + p], count);
    let k = chosenRiceParameter;
    if (exact) {
      riceBits = refineRiceParameter(folded, index, end, k);
      k = chosenRiceParameter;
    } else {
      riceBits = Math.ceil(riceBits);
    }
    const width = escapeWidth(partitionMaxima[parts + p]);
    const escapeBits = ESCAPE_WIDTH_BITS + count * width;
    if (width <= ESCAPE_MAX_WIDTH && escapeBits < riceBits) {
      coding.params[p] = ESCAPE_MARK;
      coding.escapeWidths[p] = width;
      payloadBits += escapeBits;
    } else {
      coding.params[p] = k;
      payloadBits += riceBits;
      if (k > maxParam) maxParam = k;
    }
    index = end;
  }
  coding.method = maxParam > RICE_MAX_PARAM ? 1 : 0;
  coding.partitionOrder = partitionOrder;
  const paramBits = coding.method === 0 ? RICE_PARAM_BITS : RICE2_PARAM_BITS;
  coding.bits = RESIDUAL_HEADER_BITS + parts * paramBits + payloadBits;
  return coding.bits;
}

/**
 * Folds `residual[0, n - order)` into `folded`, searches partition orders 0-8 on estimated
 * costs and picks estimated parameters (or escapes) for the winning order. Returns the
 * estimated residual bits; refineResidual makes them exact once a candidate has won.
 */
function codeResidual(
  residual: Int32Array,
  folded: Uint32Array,
  blockSize: number,
  order: number,
  coding: ResidualCoding
): number {
  let maxPo = 0;
  while (
    maxPo < MAX_PARTITION_ORDER &&
    blockSize % (2 << maxPo) === 0 &&
    blockSize >> (maxPo + 1) > order
  ) {
    maxPo++;
  }

  // Finest level: fold and gather the sum and maximum of each partition.
  const finestParts = 1 << maxPo;
  const finestSize = blockSize >> maxPo;
  let index = 0;
  for (let p = 0; p < finestParts; p++) {
    const length = p === 0 ? finestSize - order : finestSize;
    let sum = 0;
    let max = 0;
    for (let j = 0; j < length; j++) {
      const e = residual[index];
      const u = ((e << 1) ^ (e >> 31)) >>> 0;
      folded[index++] = u;
      sum += u;
      if (u > max) max = u;
    }
    partitionSums[finestParts + p] = sum;
    partitionMaxima[finestParts + p] = max;
  }
  for (let level = maxPo - 1; level >= 0; level--) {
    const parts = 1 << level;
    for (let p = 0; p < parts; p++) {
      const a = (parts << 1) + 2 * p;
      partitionSums[parts + p] = partitionSums[a] + partitionSums[a + 1];
      partitionMaxima[parts + p] = Math.max(partitionMaxima[a], partitionMaxima[a + 1]);
    }
  }

  // Cheapest partition order by estimated bits.
  let bestPo = 0;
  let bestCost = Number.POSITIVE_INFINITY;
  for (let po = 0; po <= maxPo; po++) {
    const parts = 1 << po;
    const size = blockSize >> po;
    let cost = 0;
    for (let p = 0; p < parts; p++) {
      const count = p === 0 ? size - order : size;
      const rice = riceEstimate(partitionSums[parts + p], count);
      const escape = ESCAPE_WIDTH_BITS + count * escapeWidth(partitionMaxima[parts + p]);
      cost += RICE_PARAM_BITS + (rice < escape ? rice : escape);
    }
    if (cost < bestCost) {
      bestCost = cost;
      bestPo = po;
    }
  }
  return materializePartitions(folded, blockSize, order, bestPo, coding, false);
}

/**
 * Makes the parameters of an already folded residual exact (nearest-neighbour search on real
 * quotient counts, escape where raw width is cheaper) at its chosen partition order.
 * Returns the exact residual bits.
 */
function refineResidual(folded: Uint32Array, blockSize: number, order: number, coding: ResidualCoding): number {
  const partitionOrder = coding.partitionOrder;
  const parts = 1 << partitionOrder;
  const size = blockSize >> partitionOrder;
  let index = 0;
  for (let p = 0; p < parts; p++) {
    const length = p === 0 ? size - order : size;
    let sum = 0;
    let max = 0;
    for (let j = 0; j < length; j++) {
      const u = folded[index++];
      sum += u;
      if (u > max) max = u;
    }
    partitionSums[parts + p] = sum;
    partitionMaxima[parts + p] = max;
  }
  return materializePartitions(folded, blockSize, order, partitionOrder, coding, true);
}

function writeResidual(
  writer: FlacBitWriter,
  residual: Int32Array,
  folded: Uint32Array,
  blockSize: number,
  order: number,
  coding: ResidualCoding
): void {
  writer.writeBits(coding.method, 2);
  writer.writeBits(coding.partitionOrder, 4);
  const paramBits = coding.method === 0 ? RICE_PARAM_BITS : RICE2_PARAM_BITS;
  const escapeCode = coding.method === 0 ? RICE_ESCAPE_CODE : RICE2_ESCAPE_CODE;
  const parts = 1 << coding.partitionOrder;
  const size = blockSize >> coding.partitionOrder;
  let index = 0;
  for (let p = 0; p < parts; p++) {
    const end = index + (p === 0 ? size - order : size);
    const param = coding.params[p];
    if (param === ESCAPE_MARK) {
      const width = coding.escapeWidths[p];
      writer.writeBits(escapeCode, paramBits);
      writer.writeBits(width, ESCAPE_WIDTH_BITS);
      if (width > 0) {
        for (let i = index; i < end; i++) writer.writeSigned(residual[i], width);
      }
    } else {
      writer.writeBits(param, paramBits);
      writer.writeRice(folded, index, end, param);
    }
    index = end;
  }
}

// ============================================================================
// 6. Subframe planning
// ============================================================================

/** The chosen coding of one channel of one block, built from preallocated buffers. */
class SubframePlan {
  kind = SUBFRAME_VERBATIM;
  order = 0;
  wasted = 0;
  /** Bits per sample after removing wasted bits. */
  bps = 0;
  /** Exact size of the whole subframe in bits. */
  bits = 0;
  constantValue = 0;
  /** LPC only: coefficient precision, right shift and quantised coefficients. */
  precision = 0;
  shift = 0;
  readonly coefs = new Int32Array(FLAC_MAX_LPC_ORDER);
  readonly residual: Int32Array;
  readonly folded: Uint32Array;
  readonly coding = new ResidualCoding();

  constructor(blockSize: number) {
    this.residual = new Int32Array(blockSize);
    this.folded = new Uint32Array(blockSize);
  }
}

class ChannelSlot {
  readonly samples: Int32Array;
  best: SubframePlan;
  /** Row (order - 1) holds the predictor weights of that order, from Levinson-Durbin. */
  readonly weights = new Float64Array(FLAC_MAX_LPC_ORDER * FLAC_MAX_LPC_ORDER);
  readonly errors = new Float64Array(FLAC_MAX_LPC_ORDER);
  /** Highest order with a positive prediction error; 0 when LPC was not analysed. */
  usable = 0;
  /** Windowed signal energy (autocorrelation at lag 0). */
  energy = 0;

  constructor(blockSize: number) {
    this.samples = new Int32Array(blockSize);
    this.best = new SubframePlan(blockSize);
  }
}

/** Everything one stream encode allocates up front. */
class EncoderWorkspace {
  readonly slots: ChannelSlot[];
  trial: SubframePlan;
  readonly writer: FlacBitWriter;
  readonly bitsPerSample: number;
  // LPC analysis buffers
  readonly windowed: Float64Array;
  readonly autoc = new Float64Array(FLAC_MAX_LPC_ORDER + 1);
  readonly orderBits = new Float64Array(FLAC_MAX_LPC_ORDER);
  readonly quantized = new Float64Array(FLAC_MAX_LPC_ORDER);
  private readonly windows = new Map<number, Float64Array>();

  constructor(blockSize: number, channels: number, bitsPerSample: number) {
    this.bitsPerSample = bitsPerSample;
    this.slots = [];
    // Stereo keeps left, right, mid and side so the cheapest assignment can be chosen.
    const slotCount = channels === 2 ? STEREO_SLOTS : 1;
    for (let c = 0; c < slotCount; c++) this.slots.push(new ChannelSlot(blockSize));
    this.trial = new SubframePlan(blockSize);
    this.windowed = new Float64Array(blockSize);
    // Worst case is every subframe verbatim at one extra bit (side channels) plus framing.
    const subframeBytes =
      SUBFRAME_HEADER_BITS / BITS_PER_BYTE + Math.ceil(((bitsPerSample + 1) * blockSize) / BITS_PER_BYTE) + 1;
    this.writer = new FlacBitWriter(FRAME_OVERHEAD_BYTES + channels * subframeBytes);
  }

  /** Tukey window for blocks of n samples; only the full and tail sizes ever occur. */
  windowFor(n: number): Float64Array {
    const cached = this.windows.get(n);
    if (cached) return cached;
    if (this.windows.size >= WINDOW_CACHE_LIMIT) {
      const oldest = this.windows.keys().next().value as number;
      this.windows.delete(oldest);
    }
    const window = new Float64Array(n).fill(1);
    const taper = Math.floor((TUKEY_TAPER_FRACTION * (n - 1)) / 2);
    for (let i = 0; i <= taper && taper > 0; i++) {
      const w = 0.5 - 0.5 * Math.cos((Math.PI * i) / taper);
      window[i] = w;
      window[n - 1 - i] = w;
    }
    this.windows.set(n, window);
    return window;
  }
}

/** Residual of the fixed polynomial predictor of the given order (RFC 9639 section 9.2.5). */
function fixedResidual(x: Int32Array, n: number, order: number, out: Int32Array): void {
  switch (order) {
    case 0:
      for (let i = 0; i < n; i++) out[i] = x[i];
      break;
    case 1:
      for (let i = 1; i < n; i++) out[i - 1] = x[i] - x[i - 1];
      break;
    case 2:
      for (let i = 2; i < n; i++) out[i - 2] = x[i] - 2 * x[i - 1] + x[i - 2];
      break;
    case 3:
      for (let i = 3; i < n; i++) out[i - 3] = x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3];
      break;
    default:
      for (let i = 4; i < n; i++) {
        out[i - 4] = x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4];
      }
  }
}

const fixedErrorSums = new Float64Array(MAX_FIXED_ORDER + 1);
const fixedScratch = new Int32Array(SMALL_BLOCK_SAMPLES);

/** Sums of |residual| for fixed orders 0-4 over samples 4..n-1 in one pass. */
function fixedErrorSumsLong(x: Int32Array, n: number): void {
  let sum0 = 0;
  let sum1 = 0;
  let sum2 = 0;
  let sum3 = 0;
  let sum4 = 0;
  let prev1 = x[3] - x[2];
  let prev2 = prev1 - (x[2] - x[1]);
  let prev3 = prev2 - (x[2] - 2 * x[1] + x[0]);
  for (let i = 4; i < n; i++) {
    const e0 = x[i];
    const e1 = e0 - x[i - 1];
    const e2 = e1 - prev1;
    const e3 = e2 - prev2;
    const e4 = e3 - prev3;
    prev1 = e1;
    prev2 = e2;
    prev3 = e3;
    sum0 += e0 < 0 ? -e0 : e0;
    sum1 += e1 < 0 ? -e1 : e1;
    sum2 += e2 < 0 ? -e2 : e2;
    sum3 += e3 < 0 ? -e3 : e3;
    sum4 += e4 < 0 ? -e4 : e4;
  }
  fixedErrorSums[0] = sum0;
  fixedErrorSums[1] = sum1;
  fixedErrorSums[2] = sum2;
  fixedErrorSums[3] = sum3;
  fixedErrorSums[4] = sum4;
}

/** Same sums for short blocks, by direct residual evaluation. */
function fixedErrorSumsShort(x: Int32Array, n: number, maxOrder: number, scratch: Int32Array): void {
  for (let order = 0; order <= maxOrder; order++) {
    fixedResidual(x, n, order, scratch);
    let sum = 0;
    for (let i = 0; i < n - order; i++) sum += Math.abs(scratch[i]);
    fixedErrorSums[order] = sum;
  }
}

// ----------------------------------------------------------------------------
// LPC analysis (RFC 9639 section 9.2.6)
// ----------------------------------------------------------------------------

/** Default quantised-coefficient precision for the stream's sample size and the block size. */
function defaultQlpPrecision(bitsPerSample: number, n: number): number {
  if (bitsPerSample < 16) {
    return Math.max(QLP_PRECISION_NARROW_FLOOR, 2 + (bitsPerSample >> 1));
  }
  if (bitsPerSample > 16) return QLP_PRECISION_WIDE_SAMPLES;
  for (const [limit, precision] of QLP_PRECISION_BY_BLOCK) {
    if (n <= limit) return precision;
  }
  return QLP_PRECISION_LARGE_BLOCK;
}

/** Windowed autocorrelation for lags 0..maxLag into ws.autoc, four lags per pass. */
function autocorrelate(ws: EncoderWorkspace, x: Int32Array, n: number, maxLag: number): void {
  const window = ws.windowFor(n);
  const w = ws.windowed;
  const autoc = ws.autoc;
  for (let i = 0; i < n; i++) w[i] = x[i] * window[i];
  let lag = 0;
  for (; lag + 3 <= maxLag; lag += 4) {
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    let s3 = 0;
    for (let i = lag + 3; i < n; i++) {
      const v = w[i];
      s0 += v * w[i - lag];
      s1 += v * w[i - lag - 1];
      s2 += v * w[i - lag - 2];
      s3 += v * w[i - lag - 3];
    }
    // Terms with i < lag + 3 that the unrolled loop skipped.
    s0 += w[lag] * w[0] + w[lag + 1] * w[1] + w[lag + 2] * w[2];
    s1 += w[lag + 1] * w[0] + w[lag + 2] * w[1];
    s2 += w[lag + 2] * w[0];
    autoc[lag] = s0;
    autoc[lag + 1] = s1;
    autoc[lag + 2] = s2;
    autoc[lag + 3] = s3;
  }
  for (; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = lag; i < n; i++) sum += w[i] * w[i - lag];
    autoc[lag] = sum;
  }
}

/**
 * Levinson-Durbin recursion over ws.autoc. Fills slot.weights / slot.errors for orders
 * 1..result and returns the highest order whose prediction error stayed positive.
 */
function levinsonDurbin(ws: EncoderWorkspace, slot: ChannelSlot, maxOrder: number): number {
  const autoc = ws.autoc;
  const weights = slot.weights;
  let error = autoc[0] * (1 + LPC_REGULARIZATION);
  if (!(error > 0)) return 0;
  for (let i = 0; i < maxOrder; i++) {
    const row = i * FLAC_MAX_LPC_ORDER;
    const prev = row - FLAC_MAX_LPC_ORDER;
    let acc = autoc[i + 1];
    for (let j = 0; j < i; j++) acc -= weights[prev + j] * autoc[i - j];
    const reflection = acc / error;
    for (let j = 0; j < i; j++) weights[row + j] = weights[prev + j] - reflection * weights[prev + i - 1 - j];
    weights[row + i] = reflection;
    error *= 1 - reflection * reflection;
    if (!(error > 0) || !Number.isFinite(error)) return i;
    slot.errors[i] = error;
  }
  return maxOrder;
}

/**
 * Quantises the weights of `order` to `precision` bits with error feedback (RFC 9639 forbids
 * negative shifts). Returns the shift, or -1 when the weights do not fit this precision.
 */
function quantizeWeights(
  ws: EncoderWorkspace,
  slot: ChannelSlot,
  order: number,
  precision: number,
  plan: SubframePlan
): number {
  const weights = slot.weights;
  const row = (order - 1) * FLAC_MAX_LPC_ORDER;
  let largest = 0;
  for (let j = 0; j < order; j++) {
    const magnitude = Math.abs(weights[row + j]);
    if (magnitude > largest) largest = magnitude;
  }
  if (!(largest > 0)) return -1;
  const exponent = Math.floor(Math.log2(largest)) + 1;
  const shift = Math.min(MAX_QLP_SHIFT, precision - exponent - 1);
  if (shift < 0) return -1;
  const scale = 2 ** shift;
  const limit = 2 ** (precision - 1);
  let carry = 0;
  for (let j = 0; j < order; j++) {
    const exact = weights[row + j] * scale + carry;
    let q = Math.round(exact);
    if (q >= limit) q = limit - 1;
    else if (q < -limit) q = -limit;
    carry = exact - q;
    plan.coefs[j] = q;
    ws.quantized[j] = q;
  }
  for (let j = order; j < FLAC_MAX_LPC_ORDER; j++) plan.coefs[j] = 0;
  return shift;
}

/**
 * Residual of a quantised predictor whose sums provably fit int32 (maxAbs * sum|q| < 2^31),
 * so products can use Math.imul. Coefficients are zero-padded to 4, 8 or 12 taps and the
 * loop is unrolled to that width.
 */
function lpcResidualInt(x: Int32Array, n: number, order: number, c: Int32Array, shift: number, out: Int32Array): void {
  let taps = LPC_TAPS_LARGE;
  if (order <= LPC_TAPS_SMALL) taps = LPC_TAPS_SMALL;
  else if (order <= LPC_TAPS_MEDIUM) taps = LPC_TAPS_MEDIUM;
  const head = Math.min(n, taps);
  for (let i = order; i < head; i++) {
    let sum = 0;
    for (let j = 0; j < order; j++) sum += Math.imul(c[j], x[i - 1 - j]);
    out[i - order] = x[i] - (sum >> shift);
  }
  const c0 = c[0];
  const c1 = c[1];
  const c2 = c[2];
  const c3 = c[3];
  if (taps === LPC_TAPS_SMALL) {
    for (let i = head; i < n; i++) {
      const sum = Math.imul(c0, x[i - 1]) + Math.imul(c1, x[i - 2]) + Math.imul(c2, x[i - 3]) + Math.imul(c3, x[i - 4]);
      out[i - order] = x[i] - (sum >> shift);
    }
    return;
  }
  const c4 = c[4];
  const c5 = c[5];
  const c6 = c[6];
  const c7 = c[7];
  if (taps === LPC_TAPS_MEDIUM) {
    for (let i = head; i < n; i++) {
      const sum =
        Math.imul(c0, x[i - 1]) +
        Math.imul(c1, x[i - 2]) +
        Math.imul(c2, x[i - 3]) +
        Math.imul(c3, x[i - 4]) +
        Math.imul(c4, x[i - 5]) +
        Math.imul(c5, x[i - 6]) +
        Math.imul(c6, x[i - 7]) +
        Math.imul(c7, x[i - 8]);
      out[i - order] = x[i] - (sum >> shift);
    }
    return;
  }
  const c8 = c[8];
  const c9 = c[9];
  const c10 = c[10];
  const c11 = c[11];
  for (let i = head; i < n; i++) {
    const sum =
      Math.imul(c0, x[i - 1]) +
      Math.imul(c1, x[i - 2]) +
      Math.imul(c2, x[i - 3]) +
      Math.imul(c3, x[i - 4]) +
      Math.imul(c4, x[i - 5]) +
      Math.imul(c5, x[i - 6]) +
      Math.imul(c6, x[i - 7]) +
      Math.imul(c7, x[i - 8]) +
      Math.imul(c8, x[i - 9]) +
      Math.imul(c9, x[i - 10]) +
      Math.imul(c10, x[i - 11]) +
      Math.imul(c11, x[i - 12]);
    out[i - order] = x[i] - (sum >> shift);
  }
}

/** Residual of the quantised predictor: x[i] - floor(sum(q[j] * x[i-1-j]) / 2^shift). */
function lpcResidual(
  x: Int32Array,
  n: number,
  order: number,
  q: Float64Array,
  shift: number,
  out: Int32Array
): void {
  const inverse = 2 ** -shift;
  for (let i = order; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < order; j++) sum += q[j] * x[i - 1 - j];
    out[i - order] = x[i] - Math.floor(sum * inverse);
  }
}

/**
 * Codes one (order, precision) LPC candidate into ws.trial and keeps it when it is the
 * cheapest subframe so far. Returns its exact size, or Infinity when it is unusable.
 */
function tryLpc(
  ws: EncoderWorkspace,
  slot: ChannelSlot,
  n: number,
  bps: number,
  wasted: number,
  maxAbs: number,
  order: number,
  precision: number
): number {
  const trial = ws.trial;
  const shift = quantizeWeights(ws, slot, order, precision, trial);
  if (shift < 0) return Number.POSITIVE_INFINITY;
  // The prediction must stay inside the folding range (MAX_RESIDUAL_MAGNITUDE).
  let weightSum = 0;
  for (let j = 0; j < order; j++) weightSum += Math.abs(ws.quantized[j]);
  if (maxAbs * (weightSum * 2 ** -shift + 1) >= MAX_RESIDUAL_MAGNITUDE) return Number.POSITIVE_INFINITY;

  if (maxAbs * weightSum < INT32_SUM_LIMIT) {
    lpcResidualInt(slot.samples, n, order, trial.coefs, shift, trial.residual);
  } else {
    lpcResidual(slot.samples, n, order, ws.quantized, shift, trial.residual);
  }
  const residualBits = codeResidual(trial.residual, trial.folded, n, order, trial.coding);
  const bits =
    SUBFRAME_HEADER_BITS +
    wasted +
    order * (bps + precision) +
    QLP_PRECISION_FIELD_BITS +
    QLP_SHIFT_FIELD_BITS +
    residualBits;
  if (bits < slot.best.bits) {
    trial.kind = SUBFRAME_LPC;
    trial.order = order;
    trial.wasted = wasted;
    trial.bps = bps;
    trial.bits = bits;
    trial.precision = precision;
    trial.shift = shift;
    const previous = slot.best;
    slot.best = trial;
    ws.trial = previous;
  }
  return bits;
}

/** Analyses a channel's LPC models before any wasted-bit shift (scale does not change the weights). */
function analyzeChannel(ws: EncoderWorkspace, slot: ChannelSlot, n: number): void {
  slot.usable = 0;
  slot.energy = 0;
  if (n < LPC_MIN_BLOCK_SAMPLES) return;
  const maxOrder = Math.min(FLAC_MAX_LPC_ORDER, n - 1);
  autocorrelate(ws, slot.samples, n, maxOrder);
  slot.energy = ws.autoc[0];
  slot.usable = levinsonDurbin(ws, slot, maxOrder);
}

/** Estimated bits per sample of a Laplacian residual with the given prediction error energy. */
function estimatedBitsPerSample(error: number, n: number, wasted: number): number {
  return Math.max(0, 0.5 * Math.log2(error * (0.5 / n)) - wasted);
}

/**
 * Fills ws.orderBits with the estimated size of each usable LPC order (residual plus warm-up
 * and coefficients) and returns the lowest of them (Infinity without usable orders).
 */
function estimateOrderBits(
  ws: EncoderWorkspace,
  slot: ChannelSlot,
  n: number,
  bps: number,
  wasted: number
): number {
  const basePrecision = defaultQlpPrecision(ws.bitsPerSample, n);
  let best = Number.POSITIVE_INFINITY;
  for (let o = 1; o <= slot.usable; o++) {
    const bits = estimatedBitsPerSample(slot.errors[o - 1], n, wasted) * (n - o) + o * (basePrecision + bps);
    ws.orderBits[o - 1] = bits;
    if (bits < best) best = bits;
  }
  return best;
}

/** Estimated subframe size of an analysed channel, used to choose a stereo assignment. */
function estimateChannelBits(ws: EncoderWorkspace, slot: ChannelSlot, n: number, bps: number): number {
  const noPrediction = n * estimatedBitsPerSample(slot.energy, n, 0);
  return SUBFRAME_HEADER_BITS + Math.min(noPrediction, estimateOrderBits(ws, slot, n, bps, 0));
}

/** Orders are ranked by estimated bits; the best few are coded for real. */
function planLpc(
  ws: EncoderWorkspace,
  slot: ChannelSlot,
  n: number,
  bps: number,
  wasted: number,
  maxAbs: number
): void {
  const usable = slot.usable;
  if (usable === 0) return;
  const basePrecision = defaultQlpPrecision(ws.bitsPerSample, n);
  estimateOrderBits(ws, slot, n, bps, wasted);

  for (let attempt = 0; attempt < LPC_EXACT_ORDER_CANDIDATES; attempt++) {
    let order = 0;
    let lowest = Number.POSITIVE_INFINITY;
    for (let o = 1; o <= usable; o++) {
      if (ws.orderBits[o - 1] < lowest) {
        lowest = ws.orderBits[o - 1];
        order = o;
      }
    }
    if (order === 0) break;
    ws.orderBits[order - 1] = Number.POSITIVE_INFINITY;

    let bestCost = Number.POSITIVE_INFINITY;
    // Only the best-ranked order gets the precision search; runners-up use the default.
    const steps = attempt === 0 ? QLP_PRECISION_SEARCH_STEPS : 0;
    const lastPrecision = Math.min(MAX_QLP_PRECISION, basePrecision + steps);
    for (let precision = Math.max(MIN_QLP_PRECISION, basePrecision); precision <= lastPrecision; precision++) {
      const cost = tryLpc(ws, slot, n, bps, wasted, maxAbs, order, precision);
      if (cost < bestCost) bestCost = cost;
      else if (bestCost < Number.POSITIVE_INFINITY) break;
    }
  }
}

/**
 * Plans one channel: constant if flat, else the cheaper of verbatim and the best fixed
 * predictor, after stripping bits that are zero in every sample.
 */
function planChannel(ws: EncoderWorkspace, slot: ChannelSlot, n: number, channelBps: number): void {
  const x = slot.samples;
  const best = slot.best;
  const trial = ws.trial;

  let allEqual = true;
  let orAll = 0;
  let maxAbs = 0;
  const first = x[0];
  for (let i = 0; i < n; i++) {
    const v = x[i];
    orAll |= v;
    if (v !== first) allEqual = false;
    const magnitude = v < 0 ? -v : v;
    if (magnitude > maxAbs) maxAbs = magnitude;
  }
  if (allEqual) {
    best.kind = SUBFRAME_CONSTANT;
    best.order = 0;
    best.wasted = 0;
    best.bps = channelBps;
    best.constantValue = first;
    best.bits = SUBFRAME_HEADER_BITS + channelBps;
    return;
  }

  const wasted = 31 - Math.clz32(orAll & -orAll);
  if (wasted > 0) {
    for (let i = 0; i < n; i++) x[i] >>= wasted;
  }
  const bps = channelBps - wasted;
  maxAbs >>= wasted;

  best.kind = SUBFRAME_VERBATIM;
  best.order = 0;
  best.wasted = wasted;
  best.bps = bps;
  best.bits = SUBFRAME_HEADER_BITS + wasted + n * bps;

  const lpcEstimate = slot.usable > 0 ? estimateOrderBits(ws, slot, n, bps, wasted) : Number.POSITIVE_INFINITY;
  const fixedOrder = chooseFixedOrder(slot.samples, n, bps);
  const lowRate = lpcEstimate <= n * FIXED_ALWAYS_BELOW_BITS_PER_SAMPLE;
  if (lowRate || fixedEstimateBits <= FIXED_CANDIDATE_RATIO * lpcEstimate) planFixed(ws, slot, n, bps, wasted, fixedOrder);
  planLpc(ws, slot, n, bps, wasted, maxAbs);

  const chosen = slot.best;
  if (chosen.kind === SUBFRAME_FIXED || chosen.kind === SUBFRAME_LPC) {
    const estimated = chosen.coding.bits;
    chosen.bits += refineResidual(chosen.folded, n, chosen.order, chosen.coding) - estimated;
  }
}

/** Estimated size of the best fixed predictor, left in fixedEstimateBits by chooseFixedOrder. */
let fixedEstimateBits = 0;

/** Picks the fixed order (0-4) with the smallest residual magnitude and estimates its size. */
function chooseFixedOrder(x: Int32Array, n: number, bps: number): number {
  const maxOrder = Math.min(MAX_FIXED_ORDER, n - 1);
  if (n <= SMALL_BLOCK_SAMPLES) {
    fixedErrorSumsShort(x, n, maxOrder, fixedScratch);
  } else {
    fixedErrorSumsLong(x, n);
  }
  let order = 0;
  let bestEstimate = Number.POSITIVE_INFINITY;
  const samplesCounted = n <= SMALL_BLOCK_SAMPLES ? 0 : n - MAX_FIXED_ORDER;
  for (let o = 0; o <= maxOrder; o++) {
    const counted = samplesCounted > 0 ? samplesCounted : n - o;
    const estimate = o * bps + counted * Math.log2(1 + fixedErrorSums[o] / counted);
    if (estimate < bestEstimate) {
      bestEstimate = estimate;
      order = o;
    }
  }
  fixedEstimateBits = bestEstimate;
  return order;
}

/** Codes the given fixed predictor order as a candidate subframe. */
function planFixed(
  ws: EncoderWorkspace,
  slot: ChannelSlot,
  n: number,
  bps: number,
  wasted: number,
  order: number
): void {
  const best = slot.best;
  const trial = ws.trial;
  fixedResidual(slot.samples, n, order, trial.residual);
  const residualBits = codeResidual(trial.residual, trial.folded, n, order, trial.coding);
  const fixedBits = SUBFRAME_HEADER_BITS + wasted + order * bps + residualBits;
  if (fixedBits < best.bits) {
    trial.kind = SUBFRAME_FIXED;
    trial.order = order;
    trial.wasted = wasted;
    trial.bps = bps;
    trial.bits = fixedBits;
    ws.trial = best;
    slot.best = trial;
  }
}

function writeSubframe(writer: FlacBitWriter, plan: SubframePlan, x: Int32Array, n: number): void {
  let typeCode = TYPE_CODE_VERBATIM;
  if (plan.kind === SUBFRAME_CONSTANT) typeCode = TYPE_CODE_CONSTANT;
  else if (plan.kind === SUBFRAME_FIXED) typeCode = TYPE_CODE_FIXED + plan.order;
  else if (plan.kind === SUBFRAME_LPC) typeCode = TYPE_CODE_LPC + plan.order - 1;
  // zero pad bit, 6-bit type, wasted-bits flag
  writer.writeBits((typeCode << 1) | (plan.wasted > 0 ? 1 : 0), SUBFRAME_HEADER_BITS);
  if (plan.wasted > 0) writer.writeBits(1, plan.wasted);

  if (plan.kind === SUBFRAME_CONSTANT) {
    writer.writeSigned(plan.constantValue, plan.bps);
    return;
  }
  if (plan.kind === SUBFRAME_VERBATIM) {
    for (let i = 0; i < n; i++) writer.writeSigned(x[i], plan.bps);
    return;
  }
  for (let i = 0; i < plan.order; i++) writer.writeSigned(x[i], plan.bps);
  if (plan.kind === SUBFRAME_LPC) {
    writer.writeBits(plan.precision - 1, QLP_PRECISION_FIELD_BITS);
    writer.writeSigned(plan.shift, QLP_SHIFT_FIELD_BITS);
    for (let j = 0; j < plan.order; j++) writer.writeSigned(plan.coefs[j], plan.precision);
  }
  writeResidual(writer, plan.residual, plan.folded, n, plan.order, plan.coding);
}

// ============================================================================
// 7. Frames and stream
// ============================================================================

/** Frame header coded number: UTF-8 style integer, up to five continuation bytes (< 2^31). */
function writeCodedNumber(writer: FlacBitWriter, value: number): void {
  if (value < 0x80) {
    writer.writeBits(value, 8);
    return;
  }
  let continuationBytes = 1;
  while (value >= 2 ** (6 * continuationBytes + (6 - continuationBytes))) continuationBytes++;
  const leadMarker = (0xff00 >> (continuationBytes + 1)) & 0xff;
  writer.writeBits(leadMarker | Math.floor(value / 2 ** (6 * continuationBytes)), 8);
  for (let i = continuationBytes - 1; i >= 0; i--) {
    writer.writeBits(0x80 | (Math.floor(value / 2 ** (6 * i)) & 0x3f), 8);
  }
}

const FRAME_OVERHEAD_BYTES = 32;
const CHANNEL_ASSIGNMENT_INDEPENDENT_BASE = 0;
const ASSIGNMENT_LEFT_SIDE = 8;
const ASSIGNMENT_SIDE_RIGHT = 9;
const ASSIGNMENT_MID_SIDE = 10;

function writeFrameHeader(
  writer: FlacBitWriter,
  frameNumber: number,
  n: number,
  sampleRate: number,
  channelCode: number,
  sizeCode: number
): void {
  const tableBlockCode = BLOCK_SIZE_CODES.get(n);
  let blockCode = tableBlockCode ?? BLOCK_SIZE_CODE_EXPLICIT_16;
  if (tableBlockCode === undefined && n <= MAX_EXPLICIT_8_BLOCK) blockCode = BLOCK_SIZE_CODE_EXPLICIT_8;
  const rateCode = flacSampleRateCode(sampleRate);

  writer.writeBits(SYNC_FIXED_BLOCKING, 16);
  writer.writeBits(blockCode, 4);
  writer.writeBits(rateCode, 4);
  writer.writeBits(channelCode, 4);
  writer.writeBits(sizeCode, 3);
  writer.writeBits(0, 1);
  writeCodedNumber(writer, frameNumber);
  if (blockCode === BLOCK_SIZE_CODE_EXPLICIT_8) writer.writeBits(n - 1, 8);
  else if (blockCode === BLOCK_SIZE_CODE_EXPLICIT_16) writer.writeBits(n - 1, 16);
  if (rateCode === FLAC_RATE_CODE_KHZ) writer.writeBits(sampleRate / 1000, 8);
  else if (rateCode === FLAC_RATE_CODE_HZ) writer.writeBits(sampleRate, 16);
  else if (rateCode === FLAC_RATE_CODE_TENS_OF_HZ) writer.writeBits(sampleRate / 10, 16);
  writer.writeBits(flacCrc8(writer.bytes, writer.bytePosition), 8);
}

const LITTLE_ENDIAN_HOST = os.endianness() === 'LE';
const MD5_CHUNK_SAMPLES = 1 << 16;
const BITS_PER_BYTE = 8;

/** MD5 over the little-endian signed interleaved samples, each padded to whole bytes (section 8.2). */
function flacPcmMd5(samples: Int16Array | Int32Array, bitsPerSample: number): Buffer {
  const hash = crypto.createHash('md5');
  const bytesPerSample = Math.ceil(bitsPerSample / BITS_PER_BYTE);
  if (samples instanceof Int16Array && bytesPerSample === 2 && LITTLE_ENDIAN_HOST) {
    hash.update(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
    return hash.digest();
  }
  const chunk = new Uint8Array(MD5_CHUNK_SAMPLES * bytesPerSample);
  for (let start = 0; start < samples.length; start += MD5_CHUNK_SAMPLES) {
    const count = Math.min(MD5_CHUNK_SAMPLES, samples.length - start);
    let at = 0;
    for (let i = 0; i < count; i++) {
      const v = samples[start + i];
      for (let b = 0; b < bytesPerSample; b++) chunk[at++] = (v >> (b * BITS_PER_BYTE)) & 0xff;
    }
    hash.update(chunk.subarray(0, at));
  }
  return hash.digest();
}

const STREAMINFO_BYTES = 42;
const STREAMINFO_MD5_OFFSET = 26;
const STREAMINFO_PAYLOAD_BYTES = 34;
const STREAMINFO_BLOCK_HEADER = 0x80;
const STREAMINFO_TOTAL_SAMPLES_MASK = 0xfffffffffn;

function buildStreamInfo(
  sampleRate: number,
  channels: number,
  bitsPerSample: number,
  totalSamples: number,
  frameSizes: ReadonlyArray<number>,
  blockSize: number,
  md5: Buffer
): Buffer {
  const info = Buffer.alloc(STREAMINFO_BYTES);
  info.write('fLaC', 0, 'ascii');
  info[4] = STREAMINFO_BLOCK_HEADER;
  info.writeUIntBE(STREAMINFO_PAYLOAD_BYTES, 5, 3);

  let minFrame = 0;
  let maxFrame = 0;
  for (const size of frameSizes) {
    if (minFrame === 0 || size < minFrame) minFrame = size;
    if (size > maxFrame) maxFrame = size;
  }
  // The minimum block size excludes the last block (RFC 9639 section 8.2).
  const lastBlock = totalSamples - (frameSizes.length - 1) * blockSize;
  let minBlock = blockSize;
  let maxBlock = blockSize;
  if (frameSizes.length === 0) {
    minBlock = FLAC_BLOCK_SIZE;
    maxBlock = FLAC_BLOCK_SIZE;
  } else if (frameSizes.length === 1) {
    minBlock = lastBlock;
    maxBlock = lastBlock;
  }
  info.writeUInt16BE(Math.max(FLAC_MIN_STREAMINFO_BLOCK_SIZE, minBlock), 8);
  info.writeUInt16BE(Math.max(FLAC_MIN_STREAMINFO_BLOCK_SIZE, maxBlock), 10);
  info.writeUIntBE(minFrame, 12, 3);
  info.writeUIntBE(maxFrame, 15, 3);

  // 20-bit sample rate, 3-bit channels-1, 5-bit bits-per-sample-1, 36-bit total samples.
  const packed =
    (BigInt(sampleRate) << 44n) |
    (BigInt(channels - 1) << 41n) |
    (BigInt(bitsPerSample - 1) << 36n) |
    (BigInt(totalSamples) & STREAMINFO_TOTAL_SAMPLES_MASK);
  info.writeBigUInt64BE(packed, 18);
  md5.copy(info, STREAMINFO_MD5_OFFSET);
  return info;
}

/** Channel assignment code -> slots of the first and second subframe. */
const STEREO_FIRST_SLOT: Readonly<Record<number, number>> = {
  [CHANNEL_ASSIGNMENT_INDEPENDENT_BASE + 1]: SLOT_LEFT,
  [ASSIGNMENT_LEFT_SIDE]: SLOT_LEFT,
  [ASSIGNMENT_SIDE_RIGHT]: SLOT_SIDE,
  [ASSIGNMENT_MID_SIDE]: SLOT_MID,
};
const STEREO_SECOND_SLOT: Readonly<Record<number, number>> = {
  [CHANNEL_ASSIGNMENT_INDEPENDENT_BASE + 1]: SLOT_RIGHT,
  [ASSIGNMENT_LEFT_SIDE]: SLOT_SIDE,
  [ASSIGNMENT_SIDE_RIGHT]: SLOT_RIGHT,
  [ASSIGNMENT_MID_SIDE]: SLOT_SIDE,
};
const ASSIGNMENT_INDEPENDENT_STEREO = CHANNEL_ASSIGNMENT_INDEPENDENT_BASE + 1;

/**
 * Builds left, right, mid ((L+R)>>1) and side (L-R) for a block, estimates each from its LPC
 * analysis, picks the cheapest assignment among independent, left/side, side/right and
 * mid/side, and plans only the two channels it uses. Returns the channel assignment code.
 */
function planStereo(
  ws: EncoderWorkspace,
  samples: Int16Array | Int32Array,
  offset: number,
  n: number,
  bitsPerSample: number
): number {
  const left = ws.slots[SLOT_LEFT];
  const right = ws.slots[SLOT_RIGHT];
  const mid = ws.slots[SLOT_MID];
  const side = ws.slots[SLOT_SIDE];
  const l = left.samples;
  const r = right.samples;
  const m = mid.samples;
  const sd = side.samples;
  for (let i = 0; i < n; i++) {
    const a = samples[(offset + i) * 2];
    const b = samples[(offset + i) * 2 + 1];
    l[i] = a;
    r[i] = b;
    m[i] = (a + b) >> 1;
    sd[i] = a - b;
  }

  const sideBps = bitsPerSample + 1;
  let assignment = ASSIGNMENT_INDEPENDENT_STEREO;
  if (n >= LPC_MIN_BLOCK_SAMPLES) {
    analyzeChannel(ws, left, n);
    analyzeChannel(ws, right, n);
    analyzeChannel(ws, mid, n);
    analyzeChannel(ws, side, n);
    const costLeft = estimateChannelBits(ws, left, n, bitsPerSample);
    const costRight = estimateChannelBits(ws, right, n, bitsPerSample);
    const costMid = estimateChannelBits(ws, mid, n, bitsPerSample);
    const costSide = estimateChannelBits(ws, side, n, sideBps);
    let lowest = costLeft + costRight;
    if (costLeft + costSide < lowest) {
      lowest = costLeft + costSide;
      assignment = ASSIGNMENT_LEFT_SIDE;
    }
    if (costRight + costSide < lowest) {
      lowest = costRight + costSide;
      assignment = ASSIGNMENT_SIDE_RIGHT;
    }
    if (costMid + costSide < lowest) {
      assignment = ASSIGNMENT_MID_SIDE;
    }
  }

  const firstSlot = ws.slots[STEREO_FIRST_SLOT[assignment]];
  const secondSlot = ws.slots[STEREO_SECOND_SLOT[assignment]];
  planChannel(ws, firstSlot, n, firstSlot === side ? sideBps : bitsPerSample);
  planChannel(ws, secondSlot, n, secondSlot === side ? sideBps : bitsPerSample);
  return assignment;
}

/**
 * Encodes interleaved PCM into a complete FLAC stream (marker, STREAMINFO, frames).
 */
export function encodeFlacStream(
  samples: Int16Array | Int32Array,
  sampleRate: number,
  channels: number,
  options: FlacEncodeOptions = {}
): Buffer {
  const bitsPerSample = options.bitsPerSample ?? FLAC_DEFAULT_BITS_PER_SAMPLE;
  const totalFrames = validateFlacInput(samples, sampleRate, channels, bitsPerSample);
  const blockSize = FLAC_BLOCK_SIZE;
  const sizeCode = SAMPLE_SIZE_CODES.get(bitsPerSample) as number;

  const ws = new EncoderWorkspace(Math.min(blockSize, Math.max(totalFrames, 1)), channels, bitsPerSample);
  const frames: Buffer[] = [];
  const frameSizes: number[] = [];
  let frameNumber = 0;

  for (let offset = 0; offset < totalFrames; offset += blockSize) {
    const n = Math.min(blockSize, totalFrames - offset);
    const writer = ws.writer;
    writer.reset();
    if (channels === 1) {
      const slot = ws.slots[SLOT_LEFT];
      for (let i = 0; i < n; i++) slot.samples[i] = samples[offset + i];
      analyzeChannel(ws, slot, n);
      planChannel(ws, slot, n, bitsPerSample);
      writeFrameHeader(writer, frameNumber, n, sampleRate, CHANNEL_ASSIGNMENT_INDEPENDENT_BASE, sizeCode);
      writeSubframe(writer, slot.best, slot.samples, n);
    } else {
      const assignment = planStereo(ws, samples, offset, n, bitsPerSample);
      writeFrameHeader(writer, frameNumber, n, sampleRate, assignment, sizeCode);
      const first = ws.slots[STEREO_FIRST_SLOT[assignment]];
      const second = ws.slots[STEREO_SECOND_SLOT[assignment]];
      writeSubframe(writer, first.best, first.samples, n);
      writeSubframe(writer, second.best, second.samples, n);
    }
    writer.alignToByte();
    writer.writeBits(flacCrc16(writer.bytes, writer.bytePosition), 16);
    if (writer.bytePosition > writer.capacity) {
      throw new ConversionFailedError('FLAC frame exceeded its proven size bound (encoder bug).');
    }
    frames.push(Buffer.from(writer.bytes.subarray(0, writer.bytePosition)));
    frameSizes.push(writer.bytePosition);
    frameNumber++;
  }

  const info = buildStreamInfo(
    sampleRate,
    channels,
    bitsPerSample,
    totalFrames,
    frameSizes,
    blockSize,
    flacPcmMd5(samples, bitsPerSample)
  );
  return Buffer.concat([info, ...frames]);
}
