/**
 * Pure TypeScript LZMA / LZMA2 encoder (LZMA specification; .xz file format 1.1 for the LZMA2 chunk layer).
 *
 * - Range encoder with carry propagation (`LzmaRangeEncoder`), two 32-bit halves and a typed-array output.
 * - Match finding by a binary tree over four-byte hashes, repeat distances rep0-rep3 and short repeats, and a priced
 *   parse (see lzma-encoder-core.ts); the level sets the dictionary size, the search depth and the parse window.
 * - LZMA2 keeps one dictionary and one probability model across all chunks of a stream: only the first chunk resets
 *   the dictionary, and a chunk that does not compress is stored raw (after which the model restarts).
 * - Properties lc=3, lp=0, pb=2 (properties byte 0x5d).
 */

import { PayloadLimitError, UnsupportedOptionError } from '../types';
import { LZMA_PROPERTIES_BYTE, LzmaEncoderCore, posSlotOf, type LzmaParserOptions } from './lzma-encoder-core';
import { lzma2DictionaryByte } from './lzma-decoder';
import { matchFinderMemoryBytes } from './lzma-matchfinder';
import { getCpuPool, shareBytes } from '../workers/cpu-pool';

export interface LzmaCompressOptions {
  level?: number;
  dictSize?: number;
}

export interface LzmaCompressResult {
  buffer: Buffer;
  props: Buffer;
  uncompressedSize: number;
}

/** The encoder shifts a byte out when the top byte of the range is empty (range < 2^24; LZMA specification, kTopValue). */
const RC_TOP_BITS = 24;
/** Flipping the top bit turns an unsigned compare of two uint32 patterns into a signed one. */
const RC_SIGN_BIT = -0x80000000;
const RC_BIT_MODEL_TOTAL_BITS = 11;
const RC_MOVE_BITS = 5;
const RC_BIT_MODEL_TOTAL = 1 << RC_BIT_MODEL_TOTAL_BITS;
/** The full range 0xFFFFFFFF as an int32 bit pattern. */
const RC_INITIAL_RANGE = -1;
const RC_FLUSH_BYTES = 5;
/** The low register keeps its top byte unless a carry arrives: bytes at or above this value may still change. */
const RC_PENDING_BYTE = 0xff;
const RC_LOW_KEEP_MASK = 0x00ffffff;
const BYTE_MASK = 0xff;
const RC_INITIAL_CAPACITY = 1 << 16;
/** An encoded stream longer than this cannot be addressed by the container formats that carry LZMA (32-bit sizes). */
export const LZMA_MAX_ENCODED_BYTES = 0xffffffff;

/**
 * LZMA range encoder (LZMA specification, "Range Encoder"). The 33-bit `low` register is held as the int32 bit pattern
 * of its low 32 bits `lowLo` plus a carry bit `lowCarry`, and `range` as an int32 pattern too, so every step is
 * 32-bit integer arithmetic (no BigInt, no doubles); the output is a growable Uint8Array.
 */
export class LzmaRangeEncoder {
  private lowLo = 0;
  private lowCarry = 0;
  private range = RC_INITIAL_RANGE;
  private cache = 0;
  private cacheSize = 1;
  private buf = new Uint8Array(RC_INITIAL_CAPACITY);
  private pos = 0;

  encodeBit(probs: Uint16Array, index: number, bit: number): void {
    const prob = probs[index];
    const range = this.range;
    const bound = Math.imul(range >>> RC_BIT_MODEL_TOTAL_BITS, prob);
    if (bit === 0) {
      this.range = bound;
      probs[index] = prob + ((RC_BIT_MODEL_TOTAL - prob) >>> RC_MOVE_BITS);
    } else {
      this.addToLow(bound);
      this.range = (range - bound) | 0;
      probs[index] = prob - (prob >>> RC_MOVE_BITS);
    }
    while (this.range >>> RC_TOP_BITS === 0) {
      this.range <<= 8;
      this.shiftLow();
    }
  }

  /** Adds `amount` (a uint32 pattern) to `low`; the sum wrapped around exactly when it is below the amount, compared as unsigned. */
  private addToLow(amount: number): void {
    const sum = (this.lowLo + amount) | 0;
    if ((sum ^ RC_SIGN_BIT) < (amount ^ RC_SIGN_BIT)) this.lowCarry = 1;
    this.lowLo = sum;
  }

  encodeDirectBits(val: number, numBits: number): void {
    for (let i = numBits - 1; i >= 0; i--) {
      this.range >>>= 1;
      if (((val >>> i) & 1) === 1) this.addToLow(this.range);
      if (this.range >>> RC_TOP_BITS === 0) {
        this.range <<= 8;
        this.shiftLow();
      }
    }
  }

  encodeBitTree(probs: Uint16Array, offset: number, numBits: number, symbol: number): void {
    let m = 1;
    for (let i = numBits - 1; i >= 0; i--) {
      const bit = (symbol >>> i) & 1;
      this.encodeBit(probs, offset + m, bit);
      m = (m << 1) | bit;
    }
  }

  encodeReverseBitTree(probs: Uint16Array, offset: number, numBits: number, symbol: number): void {
    let m = 1;
    for (let i = 0; i < numBits; i++) {
      const bit = (symbol >>> i) & 1;
      this.encodeBit(probs, offset + m, bit);
      m = (m << 1) | bit;
    }
  }

  /** Bytes already written plus those still pending in the cache: the exact size `flush` will return. */
  get pendingSize(): number {
    return this.pos + this.cacheSize + RC_FLUSH_BYTES - 1;
  }

  private writeByte(value: number): void {
    if (this.pos === this.buf.length) this.grow();
    this.buf[this.pos++] = value;
  }

  private grow(): void {
    if (this.buf.length >= LZMA_MAX_ENCODED_BYTES) {
      throw new PayloadLimitError(`LZMA output exceeds ${LZMA_MAX_ENCODED_BYTES} bytes`);
    }
    const next = new Uint8Array(Math.min(this.buf.length * 2, LZMA_MAX_ENCODED_BYTES));
    next.set(this.buf);
    this.buf = next;
  }

  private shiftLow(): void {
    const carry = this.lowCarry;
    if (this.lowLo >>> RC_TOP_BITS !== RC_PENDING_BYTE || carry !== 0) {
      let temp = this.cache;
      do {
        this.writeByte((temp + carry) & BYTE_MASK);
        temp = BYTE_MASK;
      } while (--this.cacheSize !== 0);
      this.cache = this.lowLo >>> RC_TOP_BITS;
    }
    this.cacheSize++;
    this.lowLo = (this.lowLo & RC_LOW_KEEP_MASK) << 8;
    this.lowCarry = 0;
  }

  flush(): Buffer {
    for (let i = 0; i < RC_FLUSH_BYTES; i++) {
      this.shiftLow();
    }
    return Buffer.from(this.buf.buffer, this.buf.byteOffset, this.pos);
  }
}

/** Zero-based distance to its position slot (LZMA specification, "Decoding of distance"). */
export function getPosSlot(dist: number): number {
  return posSlotOf(dist);
}

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

const KIB = 1024;
const MIB = 1024 * KIB;
/** Largest dictionary any level or option may ask for. */
export const LZMA_MAX_DICT_BYTES = 64 * MIB;
/** Smallest dictionary the format defines. */
export const LZMA_MIN_DICT_BYTES = 4 * KIB;
/** The encoder refuses a level whose tables would take more memory than this (match finder plus parser). */
export const LZMA_MAX_ENCODER_MEMORY = 512 * MIB;
export const LZMA_LEVEL_MIN = 0;
export const LZMA_LEVEL_MAX = 9;
export const LZMA_LEVEL_DEFAULT = 6;
/** Bytes the parser's own arrays take, per window position, for the memory bound. */
const PARSER_BYTES_PER_NODE = 40;
const PARSER_FIXED_BYTES = 8 * MIB;

interface LevelParams extends LzmaParserOptions {
  dictSize: number;
}

const LEVELS: readonly LevelParams[] = [
  { dictSize: 64 * KIB, niceLength: 16, depth: 4, optimumWindow: 0 },
  { dictSize: 256 * KIB, niceLength: 24, depth: 8, optimumWindow: 0 },
  { dictSize: 1 * MIB, niceLength: 32, depth: 16, optimumWindow: 0 },
  { dictSize: 2 * MIB, niceLength: 24, depth: 12, optimumWindow: 256 },
  { dictSize: 4 * MIB, niceLength: 32, depth: 16, optimumWindow: 512 },
  { dictSize: 8 * MIB, niceLength: 48, depth: 24, optimumWindow: 1024 },
  { dictSize: 8 * MIB, niceLength: 64, depth: 40, optimumWindow: 1024 },
  { dictSize: 16 * MIB, niceLength: 64, depth: 48, optimumWindow: 1024 },
  { dictSize: 32 * MIB, niceLength: 96, depth: 64, optimumWindow: 2048 },
  { dictSize: 64 * MIB, niceLength: 128, depth: 96, optimumWindow: 2048 },
];

interface ResolvedEncoder {
  dictSize: number;
  parser: LzmaParserOptions;
}

/**
 * The smallest size of the form 2^n or 3 * 2^(n-1) that is at least `size`: the only dictionary sizes the LZMA2 property
 * byte can name, and the only ones the .lzma header is accepted with by common readers.
 */
function representableDictionarySize(size: number): number {
  const power = 2 ** Math.ceil(Math.log2(size));
  const threeQuarters = (power / 4) * 3;
  return size <= threeQuarters ? threeQuarters : power;
}

function resolveEncoder(inputLength: number, options: LzmaCompressOptions): ResolvedEncoder {
  const level = options.level ?? LZMA_LEVEL_DEFAULT;
  if (!Number.isInteger(level) || level < LZMA_LEVEL_MIN || level > LZMA_LEVEL_MAX) {
    throw new UnsupportedOptionError(`LZMA compression level must be an integer from ${LZMA_LEVEL_MIN} to ${LZMA_LEVEL_MAX}.`);
  }
  const params = LEVELS[level];
  let requested = options.dictSize ?? params.dictSize;
  if (!Number.isInteger(requested) || requested < 1) throw new UnsupportedOptionError('The LZMA dictionary size must be a positive integer.');
  requested = Math.min(Math.max(requested, LZMA_MIN_DICT_BYTES), LZMA_MAX_DICT_BYTES);
  // A dictionary larger than the input holds nothing more.
  const dictSize = representableDictionarySize(Math.max(LZMA_MIN_DICT_BYTES, Math.min(requested, inputLength)));
  const memory = matchFinderMemoryBytes(dictSize, inputLength) + params.optimumWindow * PARSER_BYTES_PER_NODE + PARSER_FIXED_BYTES;
  if (memory > LZMA_MAX_ENCODER_MEMORY) {
    throw new UnsupportedOptionError(
      `LZMA level ${level} needs about ${Math.ceil(memory / MIB)} MiB for a ${inputLength}-byte input; the limit is ${LZMA_MAX_ENCODER_MEMORY / MIB} MiB. Use a lower level.`
    );
  }
  return { dictSize, parser: { dictSize, niceLength: params.niceLength, depth: params.depth, optimumWindow: params.optimumWindow } };
}

function lzmaProperties(dictSize: number): Buffer {
  const props = Buffer.alloc(5);
  props[0] = LZMA_PROPERTIES_BYTE;
  props.writeUInt32LE(dictSize, 1);
  return props;
}

/** Bytes an encoded move group may add before the next stop check (a match costs at most a few dozen bits). */
const MOVE_MAX_BYTES = 32;

/**
 * Compresses an input buffer into a raw LZMA stream (the payload of a 7z LZMA coder, or of a .lzma file after its header).
 * The size is carried by the container; no end marker is written.
 */
export function compressLzma(input: Buffer | Uint8Array, options: LzmaCompressOptions = {}): LzmaCompressResult {
  const resolved = resolveEncoder(input.length, options);
  const props = lzmaProperties(resolved.dictSize);
  if (input.length === 0) {
    return { buffer: Buffer.from([0, 0, 0, 0, 0]), props, uncompressedSize: 0 };
  }
  const rc = new LzmaRangeEncoder();
  const core = new LzmaEncoderCore(input, resolved.parser);
  core.encode(rc, input.length, () => false);
  return { buffer: rc.flush(), props, uncompressedSize: input.length };
}

// ---------------------------------------------------------------------------
// LZMA2
// ---------------------------------------------------------------------------

const LZMA2_CONTROL_END = 0x00;
const LZMA2_CONTROL_UNCOMPRESSED_RESET = 0x01;
const LZMA2_CONTROL_UNCOMPRESSED = 0x02;
const LZMA2_CONTROL_LZMA = 0x80;
const LZMA2_MODE_SHIFT = 5;
const LZMA2_MODE_STATE_RESET = 1;
const LZMA2_MODE_NEW_PROPS = 2;
const LZMA2_MODE_DICT_RESET = 3;
/** An LZMA2 chunk holds at most 2 MiB of data and 64 KiB of compressed bytes. */
const LZMA2_CHUNK_UNCOMPRESSED_MAX = 1 << 21;
const LZMA2_CHUNK_COMPRESSED_MAX = 1 << 16;
const LZMA2_RAW_CHUNK_MAX = 1 << 16;
const LZMA2_LZMA_HEADER_BYTES = 6;
const LZMA2_RAW_HEADER_BYTES = 3;
const MATCH_LENGTH_MAX = 273;

/**
 * Compresses an input buffer into an LZMA2 stream ending with the end byte. All chunks share one dictionary and, unless a
 * chunk had to be stored raw, one probability model; the returned `props` is the one-byte dictionary size property.
 */
export function compressLzma2(
  input: Buffer | Uint8Array,
  options: LzmaCompressOptions = {}
): { buffer: Buffer; props: Buffer; uncompressedSize: number } {
  const resolved = resolveEncoder(input.length, options);
  const props = Buffer.from([lzma2DictionaryByte(resolved.dictSize)]);
  if (input.length === 0) return { buffer: Buffer.from([LZMA2_CONTROL_END]), props, uncompressedSize: 0 };

  const core = new LzmaEncoderCore(input, resolved.parser);
  const parts: Buffer[] = [];
  let dictionaryResetDone = false;
  // Right after a raw chunk (or at the start) the model is fresh and the decoder must be told to reset its own.
  let needStateReset = true;
  let needProperties = true;

  while (core.position < input.length) {
    const chunkStart = core.position;
    if (needStateReset) core.resetModel();
    const rc = new LzmaRangeEncoder();
    core.encode(
      rc,
      input.length,
      () => core.position - chunkStart > LZMA2_CHUNK_UNCOMPRESSED_MAX - MATCH_LENGTH_MAX || rc.pendingSize > LZMA2_CHUNK_COMPRESSED_MAX - MOVE_MAX_BYTES - MATCH_LENGTH_MAX
    );
    const packed = rc.flush();
    const unpackedSize = core.position - chunkStart;

    if (packed.length < unpackedSize && packed.length <= LZMA2_CHUNK_COMPRESSED_MAX) {
      let mode = 0;
      if (!dictionaryResetDone) mode = LZMA2_MODE_DICT_RESET;
      else if (needProperties) mode = LZMA2_MODE_NEW_PROPS;
      else if (needStateReset) mode = LZMA2_MODE_STATE_RESET;
      const header = Buffer.alloc(LZMA2_LZMA_HEADER_BYTES - (mode >= LZMA2_MODE_NEW_PROPS ? 0 : 1));
      header[0] = LZMA2_CONTROL_LZMA | (mode << LZMA2_MODE_SHIFT) | (((unpackedSize - 1) >>> 16) & 0x1f);
      header.writeUInt16BE((unpackedSize - 1) & 0xffff, 1);
      header.writeUInt16BE(packed.length - 1, 3);
      if (mode >= LZMA2_MODE_NEW_PROPS) header[5] = LZMA_PROPERTIES_BYTE;
      parts.push(header, packed);
      dictionaryResetDone = true;
      needProperties = false;
      needStateReset = false;
    } else {
      // Stored raw in pieces of at most 64 KiB; the decoder's model does not see these bytes, so both sides restart it.
      for (let offset = 0; offset < unpackedSize; offset += LZMA2_RAW_CHUNK_MAX) {
        const piece = Math.min(LZMA2_RAW_CHUNK_MAX, unpackedSize - offset);
        const header = Buffer.alloc(LZMA2_RAW_HEADER_BYTES);
        header[0] = dictionaryResetDone ? LZMA2_CONTROL_UNCOMPRESSED : LZMA2_CONTROL_UNCOMPRESSED_RESET;
        header.writeUInt16BE(piece - 1, 1);
        parts.push(header, Buffer.from(input.subarray(chunkStart + offset, chunkStart + offset + piece)));
        if (!dictionaryResetDone) {
          dictionaryResetDone = true;
          needProperties = true;
        }
      }
      needStateReset = true;
    }
  }
  parts.push(Buffer.from([LZMA2_CONTROL_END]));
  return { buffer: Buffer.concat(parts), props, uncompressedSize: input.length };
}

// ---------------------------------------------------------------------------
// Encoding on a pool thread
// ---------------------------------------------------------------------------

/**
 * Smallest input worth a pool thread. The priced parse runs at under 1 MB/s, so a slice of this size already takes tens of
 * milliseconds; below it the thread start-up costs more than the stretch the event loop is blocked for.
 */
export const LZMA_POOL_MIN_BYTES = 32 * 1024;

interface PoolLzmaResult {
  buffer: Uint8Array;
  props: Uint8Array;
  uncompressedSize: number;
}

async function encodeOnPool(
  kind: 'lzma' | 'lzma2',
  input: Buffer | Uint8Array,
  options: LzmaCompressOptions,
  signal: AbortSignal | undefined
): Promise<LzmaCompressResult> {
  // Reject a bad level or dictionary size here, before the input is copied for a thread.
  resolveEncoder(input.length, options);
  const data = await shareBytes(input);
  const reply = await getCpuPool().submit<PoolLzmaResult>(kind, { data, options }, { signal });
  return {
    buffer: Buffer.from(reply.buffer.buffer, reply.buffer.byteOffset, reply.buffer.byteLength),
    props: Buffer.from(reply.props),
    uncompressedSize: reply.uncompressedSize,
  };
}

/** `compressLzma` on a pool thread (inline for a small input): the same bytes, without blocking the event loop. */
export async function compressLzmaAsync(
  input: Buffer | Uint8Array,
  options: LzmaCompressOptions & { signal?: AbortSignal } = {}
): Promise<LzmaCompressResult> {
  const { signal, ...encoderOptions } = options;
  if (input.length < LZMA_POOL_MIN_BYTES) return compressLzma(input, encoderOptions);
  return encodeOnPool('lzma', input, encoderOptions, signal);
}

/** `compressLzma2` on a pool thread (inline for a small input): the same bytes, without blocking the event loop. */
export async function compressLzma2Async(
  input: Buffer | Uint8Array,
  options: LzmaCompressOptions & { signal?: AbortSignal } = {}
): Promise<LzmaCompressResult> {
  const { signal, ...encoderOptions } = options;
  if (input.length < LZMA_POOL_MIN_BYTES) return compressLzma2(input, encoderOptions);
  return encodeOnPool('lzma2', input, encoderOptions, signal);
}
