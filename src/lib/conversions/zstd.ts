import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { ConversionFailedError } from '../types';
import {
  ZstdOutputBuffer,
  createFrameDecodeState,
  decodeCompressedBlock,
  type ZstdParsedDictionary,
} from './zstd-decoder';
import { ZstdBlockEncoder, getZstdLevelParams } from './zstd-encoder';
import {
  ZSTD_BLOCK_SIZE_MAX,
  ZSTD_DECODER_WINDOW_SIZE_MAX,
  ZSTD_LEVEL_DEFAULT,
  ZSTD_LEVEL_MAX,
  ZSTD_LEVEL_MIN,
  ZSTD_WINDOW_LOG_MIN,
} from './zstd-tables';

/**
 * Pure TypeScript RFC 8878 Zstandard (zstd) Compression and Decompression Engine
 *
 * Implements:
 * - Magic byte detection (0xFD2FB528) and skippable frames (0x184D2A50..0x184D2A5F)
 * - Frame header parsing (single segment, window descriptor, dictionary ID, FCS) with a window-size cap
 * - Raw, RLE, and Compressed block decoding (Huffman literals, FSE sequences, repeat offsets)
 * - Compression levels 1-19: LZ77 hash-chain match finding, lazy matching, Huffman/FSE entropy coding
 * - Multi-frame streaming decoding
 * - XXH64 32-bit Content Checksum calculation & verification
 * - Archive bomb protection: 100:1 ratio and 500MB cumulative limit
 *
 * Block-level coding lives in zstd-encoder.ts / zstd-decoder.ts; this module owns framing.
 */

export const ZSTD_MAGIC_NUMBER = 0xfd2fb528;
export const ZSTD_MAGIC_LE = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * The 100:1 ratio guard only applies once the decoded output is larger than this. Highly repetitive
 * but legitimate data (sparse files, repeated log lines) compresses past 100:1 at small sizes; a
 * real bomb has to grow beyond this floor to do harm, and the absolute cap still applies below it.
 */
export const ZSTD_RATIO_GUARD_FLOOR_BYTES = 32 * 1024 * 1024;

export const ZSTD_SECURITY_LIMITS = {
  MAX_UNCOMPRESSED_SIZE: 500 * 1024 * 1024, // 500MB
  MAX_RATIO: 100, // 100:1
  RATIO_GUARD_FLOOR_BYTES: ZSTD_RATIO_GUARD_FLOOR_BYTES,
};

/** True when `uncompressedBytes` from `compressedBytes` is past the floor and beyond the maximum ratio. */
export function exceedsZstdRatioGuard(uncompressedBytes: number, compressedBytes: number): boolean {
  return (
    uncompressedBytes > ZSTD_RATIO_GUARD_FLOOR_BYTES &&
    compressedBytes > 0 &&
    uncompressedBytes / compressedBytes > ZSTD_SECURITY_LIMITS.MAX_RATIO
  );
}

let resolvedZstdPath: string | null = null;
export function getZstdBinaryPath(): string | null {
  if (resolvedZstdPath !== null) return resolvedZstdPath || null;
  const fixedLocations = [
    '/usr/bin/zstd',
    '/usr/local/bin/zstd',
    '/opt/homebrew/bin/zstd',
  ];
  for (const loc of fixedLocations) {
    if (fs.existsSync(loc)) {
      resolvedZstdPath = loc;
      return loc;
    }
  }
  const whichBins = ['/usr/bin/which', '/bin/which'];
  for (const whichBin of whichBins) {
    if (fs.existsSync(whichBin)) {
      try {
        const out = execFileSync(whichBin, ['zstd'], { stdio: 'pipe' }).toString().trim();
        if (out && fs.existsSync(out)) {
          resolvedZstdPath = out;
          return out;
        }
      } catch {}
    }
  }
  resolvedZstdPath = '';
  return null;
}

export interface ZstdFrameHeader {
  singleSegment: boolean;
  contentChecksumFlag: boolean;
  dictionaryId: number;
  frameContentSize: number | null;
  windowSize: number;
  headerSize: number;
}

export interface ZstdBlockHeader {
  lastBlock: boolean;
  blockType: number; // 0 = Raw, 1 = RLE, 2 = Compressed, 3 = Reserved
  blockSize: number;
}

// ==========================================
// XXH64 Content Checksum Engine (RFC 8878)
// ==========================================
const PRIME64_1 = 11400714785074694791n;
const PRIME64_2 = 14029467366897019727n;
const PRIME64_3 = 1609587929392839161n;
const PRIME64_4 = 9650029242287828579n;
const PRIME64_5 = 2870177450012600261n;

const C1_HI = 0x9e3779b1 | 0, C1_LO = 0x85ebca87 | 0;
const c1_0 = C1_LO & 0xffff, c1_1 = C1_LO >>> 16;
const C2_HI = 0xc2b2ae3d | 0, C2_LO = 0x27d4eb4f | 0;
const c2_0 = C2_LO & 0xffff, c2_1 = C2_LO >>> 16;

function rotl64(x: bigint, r: bigint): bigint {
  const mask = 0xffffffffffffffffn;
  return (((x << r) & mask) | ((x & mask) >> (64n - r))) & mask;
}

/**
 * High-performance streaming xxHash-64 implementation using 32-bit hardware arithmetic
 * for round processing and authentic RFC 8878 content checksum finalization.
 */
export class FastStreamingXxHash64 {
  private v1_hi: number; private v1_lo: number;
  private v2_hi: number; private v2_lo: number;
  private v3_hi = 0; private v3_lo = 0;
  private v4_hi: number; private v4_lo: number;
  private totalLen = 0;
  private rem = Buffer.alloc(32);
  private readonly remView = new DataView(this.rem.buffer, this.rem.byteOffset, this.rem.byteLength);
  private remLen = 0;
  private seeded = false;

  constructor() {
    this.v1_hi = (C1_HI + C2_HI) | 0;
    this.v1_lo = (C1_LO + C2_LO) | 0;
    if ((this.v1_lo >>> 0) < (C1_LO >>> 0)) this.v1_hi = (this.v1_hi + 1) | 0;
    this.v2_hi = C2_HI; this.v2_lo = C2_LO;
    this.v4_lo = (-C1_LO) | 0;
    this.v4_hi = (~C1_HI) | 0;
    if (this.v4_lo === 0) this.v4_hi = (this.v4_hi + 1) | 0;
  }

  public update(chunk: Buffer | Uint8Array): void {
    if (chunk.length === 0) return;
    this.totalLen += chunk.length;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let offset = 0;

    if (this.remLen > 0) {
      const take = Math.min(32 - this.remLen, buf.length);
      buf.copy(this.rem, this.remLen, 0, take);
      this.remLen += take;
      offset += take;
      if (this.remLen === 32) {
        this.process32(this.remView, 0);
        this.remLen = 0;
      }
    }

    const limit = buf.length - 32;
    while (offset <= limit) {
      this.process32(view, offset);
      offset += 32;
    }

    if (offset < buf.length) {
      buf.copy(this.rem, 0, offset);
      this.remLen = buf.length - offset;
    }
  }

  private process32(view: DataView, offset: number): void {
    this.seeded = true;
    {
      const n_lo = view.getInt32(offset, true);
      const n_hi = view.getInt32(offset + 4, true);
      const n0 = n_lo & 0xffff, n1 = n_lo >>> 16;
      const p0 = Math.imul(n0, c2_0);
      const p1 = Math.imul(n1, c2_0);
      const p2 = Math.imul(n0, c2_1);
      const p3 = Math.imul(n1, c2_1);
      const mid = (p0 >>> 16) + (p1 & 0xffff) + (p2 & 0xffff);
      const prod2_hi = (p3 + (p1 >>> 16) + (p2 >>> 16) + (mid >>> 16) + Math.imul(n_hi, C2_LO) + Math.imul(n_lo, C2_HI)) | 0;
      const prod2_lo = Math.imul(n_lo, C2_LO);
      const add_lo = (this.v1_lo + prod2_lo) | 0;
      const carry = ((add_lo >>> 0) < (this.v1_lo >>> 0)) ? 1 : 0;
      const add_hi = (this.v1_hi + prod2_hi + carry) | 0;
      const rot_hi = (add_hi << 31) | (add_lo >>> 1);
      const rot_lo = (add_lo << 31) | (add_hi >>> 1);
      const r0 = rot_lo & 0xffff, r1 = rot_lo >>> 16;
      const q0 = Math.imul(r0, c1_0);
      const q1 = Math.imul(r1, c1_0);
      const q2 = Math.imul(r0, c1_1);
      const q3 = Math.imul(r1, c1_1);
      const qmid = (q0 >>> 16) + (q1 & 0xffff) + (q2 & 0xffff);
      this.v1_hi = (q3 + (q1 >>> 16) + (q2 >>> 16) + (qmid >>> 16) + Math.imul(rot_hi, C1_LO) + Math.imul(rot_lo, C1_HI)) | 0;
      this.v1_lo = Math.imul(rot_lo, C1_LO);
    }
    {
      const n_lo = view.getInt32(offset + 8, true);
      const n_hi = view.getInt32(offset + 12, true);
      const n0 = n_lo & 0xffff, n1 = n_lo >>> 16;
      const p0 = Math.imul(n0, c2_0);
      const p1 = Math.imul(n1, c2_0);
      const p2 = Math.imul(n0, c2_1);
      const p3 = Math.imul(n1, c2_1);
      const mid = (p0 >>> 16) + (p1 & 0xffff) + (p2 & 0xffff);
      const prod2_hi = (p3 + (p1 >>> 16) + (p2 >>> 16) + (mid >>> 16) + Math.imul(n_hi, C2_LO) + Math.imul(n_lo, C2_HI)) | 0;
      const prod2_lo = Math.imul(n_lo, C2_LO);
      const add_lo = (this.v2_lo + prod2_lo) | 0;
      const carry = ((add_lo >>> 0) < (this.v2_lo >>> 0)) ? 1 : 0;
      const add_hi = (this.v2_hi + prod2_hi + carry) | 0;
      const rot_hi = (add_hi << 31) | (add_lo >>> 1);
      const rot_lo = (add_lo << 31) | (add_hi >>> 1);
      const r0 = rot_lo & 0xffff, r1 = rot_lo >>> 16;
      const q0 = Math.imul(r0, c1_0);
      const q1 = Math.imul(r1, c1_0);
      const q2 = Math.imul(r0, c1_1);
      const q3 = Math.imul(r1, c1_1);
      const qmid = (q0 >>> 16) + (q1 & 0xffff) + (q2 & 0xffff);
      this.v2_hi = (q3 + (q1 >>> 16) + (q2 >>> 16) + (qmid >>> 16) + Math.imul(rot_hi, C1_LO) + Math.imul(rot_lo, C1_HI)) | 0;
      this.v2_lo = Math.imul(rot_lo, C1_LO);
    }
    {
      const n_lo = view.getInt32(offset + 16, true);
      const n_hi = view.getInt32(offset + 20, true);
      const n0 = n_lo & 0xffff, n1 = n_lo >>> 16;
      const p0 = Math.imul(n0, c2_0);
      const p1 = Math.imul(n1, c2_0);
      const p2 = Math.imul(n0, c2_1);
      const p3 = Math.imul(n1, c2_1);
      const mid = (p0 >>> 16) + (p1 & 0xffff) + (p2 & 0xffff);
      const prod2_hi = (p3 + (p1 >>> 16) + (p2 >>> 16) + (mid >>> 16) + Math.imul(n_hi, C2_LO) + Math.imul(n_lo, C2_HI)) | 0;
      const prod2_lo = Math.imul(n_lo, C2_LO);
      const add_lo = (this.v3_lo + prod2_lo) | 0;
      const carry = ((add_lo >>> 0) < (this.v3_lo >>> 0)) ? 1 : 0;
      const add_hi = (this.v3_hi + prod2_hi + carry) | 0;
      const rot_hi = (add_hi << 31) | (add_lo >>> 1);
      const rot_lo = (add_lo << 31) | (add_hi >>> 1);
      const r0 = rot_lo & 0xffff, r1 = rot_lo >>> 16;
      const q0 = Math.imul(r0, c1_0);
      const q1 = Math.imul(r1, c1_0);
      const q2 = Math.imul(r0, c1_1);
      const q3 = Math.imul(r1, c1_1);
      const qmid = (q0 >>> 16) + (q1 & 0xffff) + (q2 & 0xffff);
      this.v3_hi = (q3 + (q1 >>> 16) + (q2 >>> 16) + (qmid >>> 16) + Math.imul(rot_hi, C1_LO) + Math.imul(rot_lo, C1_HI)) | 0;
      this.v3_lo = Math.imul(rot_lo, C1_LO);
    }
    {
      const n_lo = view.getInt32(offset + 24, true);
      const n_hi = view.getInt32(offset + 28, true);
      const n0 = n_lo & 0xffff, n1 = n_lo >>> 16;
      const p0 = Math.imul(n0, c2_0);
      const p1 = Math.imul(n1, c2_0);
      const p2 = Math.imul(n0, c2_1);
      const p3 = Math.imul(n1, c2_1);
      const mid = (p0 >>> 16) + (p1 & 0xffff) + (p2 & 0xffff);
      const prod2_hi = (p3 + (p1 >>> 16) + (p2 >>> 16) + (mid >>> 16) + Math.imul(n_hi, C2_LO) + Math.imul(n_lo, C2_HI)) | 0;
      const prod2_lo = Math.imul(n_lo, C2_LO);
      const add_lo = (this.v4_lo + prod2_lo) | 0;
      const carry = ((add_lo >>> 0) < (this.v4_lo >>> 0)) ? 1 : 0;
      const add_hi = (this.v4_hi + prod2_hi + carry) | 0;
      const rot_hi = (add_hi << 31) | (add_lo >>> 1);
      const rot_lo = (add_lo << 31) | (add_hi >>> 1);
      const r0 = rot_lo & 0xffff, r1 = rot_lo >>> 16;
      const q0 = Math.imul(r0, c1_0);
      const q1 = Math.imul(r1, c1_0);
      const q2 = Math.imul(r0, c1_1);
      const q3 = Math.imul(r1, c1_1);
      const qmid = (q0 >>> 16) + (q1 & 0xffff) + (q2 & 0xffff);
      this.v4_hi = (q3 + (q1 >>> 16) + (q2 >>> 16) + (qmid >>> 16) + Math.imul(rot_hi, C1_LO) + Math.imul(rot_lo, C1_HI)) | 0;
      this.v4_lo = Math.imul(rot_lo, C1_LO);
    }
  }

  public digest64(): bigint {
    const mask = 0xffffffffffffffffn;
    let h64: bigint;
    if (this.seeded) {
      const v1 = (BigInt(this.v1_hi >>> 0) << 32n) | BigInt(this.v1_lo >>> 0);
      const v2 = (BigInt(this.v2_hi >>> 0) << 32n) | BigInt(this.v2_lo >>> 0);
      const v3 = (BigInt(this.v3_hi >>> 0) << 32n) | BigInt(this.v3_lo >>> 0);
      const v4 = (BigInt(this.v4_hi >>> 0) << 32n) | BigInt(this.v4_lo >>> 0);

      h64 = (rotl64(v1, 1n) + rotl64(v2, 7n) + rotl64(v3, 12n) + rotl64(v4, 18n)) & mask;
      const round = (h: bigint, v: bigint) => {
        let x = (v * PRIME64_2) & mask;
        x = rotl64(x, 31n);
        x = (x * PRIME64_1) & mask;
        h = (h ^ x) & mask;
        return (h * PRIME64_1 + PRIME64_4) & mask;
      };
      h64 = round(h64, v1);
      h64 = round(h64, v2);
      h64 = round(h64, v3);
      h64 = round(h64, v4);
    } else {
      h64 = PRIME64_5 & mask;
    }

    h64 = (h64 + BigInt(this.totalLen)) & mask;

    let offset = 0;
    while (offset + 8 <= this.remLen) {
      let k1 = this.rem.readBigUInt64LE(offset);
      k1 = (k1 * PRIME64_2) & mask;
      k1 = rotl64(k1, 31n);
      k1 = (k1 * PRIME64_1) & mask;
      h64 = (h64 ^ k1) & mask;
      h64 = (rotl64(h64, 27n) * PRIME64_1 + PRIME64_4) & mask;
      offset += 8;
    }

    if (offset + 4 <= this.remLen) {
      let k1 = BigInt(this.rem.readUInt32LE(offset));
      k1 = (k1 * PRIME64_1) & mask;
      h64 = (h64 ^ k1) & mask;
      h64 = (rotl64(h64, 23n) * PRIME64_2 + PRIME64_3) & mask;
      offset += 4;
    }

    while (offset < this.remLen) {
      let k1 = BigInt(this.rem[offset]);
      k1 = (k1 * PRIME64_5) & mask;
      h64 = (h64 ^ k1) & mask;
      h64 = (rotl64(h64, 11n) * PRIME64_1) & mask;
      offset++;
    }

    h64 = (h64 ^ (h64 >> 33n)) & mask;
    h64 = (h64 * PRIME64_2) & mask;
    h64 = (h64 ^ (h64 >> 29n)) & mask;
    h64 = (h64 * PRIME64_3) & mask;
    h64 = (h64 ^ (h64 >> 32n)) & mask;

    return h64;
  }

  public digest(): number {
    return Number(this.digest64() & 0xffffffffn);
  }
}

export function xxh64(buf: Uint8Array): bigint {
  const hasher = new FastStreamingXxHash64();
  hasher.update(buf);
  return hasher.digest64();
}

export function computeZstdChecksum(data: Uint8Array): number {
  const hasher = new FastStreamingXxHash64();
  hasher.update(data);
  return hasher.digest();
}

// ==========================================
// Zstandard Frame Parser & Decompressor
// ==========================================

const FHD_FCS_SHIFT = 6;
const FHD_SINGLE_SEGMENT_BIT = 5;
const FHD_RESERVED_BIT = 3;
const FHD_CHECKSUM_BIT = 2;
const FHD_DICT_ID_MASK = 0x03;
const FCS_TWO_BYTE_BIAS = 256;
const FCS_TWO_BYTE_MAX = 65536 + FCS_TWO_BYTE_BIAS;
const FCS_FOUR_BYTE_LIMIT = 2 ** 32;
const WINDOW_DESCRIPTOR_EXPONENT_SHIFT = 3;
const WINDOW_DESCRIPTOR_MANTISSA_MASK = 0x07;
const WINDOW_MANTISSA_STEPS = 8;
const BLOCK_HEADER_BYTES = 3;
const BLOCK_TYPE_RAW = 0;
const BLOCK_TYPE_RLE = 1;
const BLOCK_TYPE_COMPRESSED = 2;
const SKIPPABLE_FRAME_MAGIC_MIN = 0x184d2a50;
const SKIPPABLE_FRAME_MAGIC_MAX = 0x184d2a5f;
const SKIPPABLE_HEADER_BYTES = 8;
const CONTENT_CHECKSUM_BYTES = 4;
/** Largest input the encoder accepts: match positions are stored as signed 32-bit integers. */
export const ZSTD_ENCODER_INPUT_MAX = 2 ** 30;

function bombSizeError(limit: number = ZSTD_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE): ConversionFailedError {
  return new ConversionFailedError(`Archive bomb detected: uncompressed size exceeds limit of ${limit} bytes`);
}

function bombRatioError(uncompressed: number, compressed: number): ConversionFailedError {
  return new ConversionFailedError(
    `Archive bomb detected: compression ratio (${(uncompressed / compressed).toFixed(1)}:1) exceeds ${ZSTD_SECURITY_LIMITS.MAX_RATIO}:1 limit`
  );
}

export function parseZstdFrameHeader(buf: Buffer, offset: number): ZstdFrameHeader {
  if (offset + 5 > buf.length) {
    throw new ConversionFailedError('Malformed Zstandard frame: header truncated.');
  }

  const magic = buf.readUInt32LE(offset);
  if (magic !== ZSTD_MAGIC_NUMBER) {
    throw new ConversionFailedError(
      `Invalid Zstandard magic number: expected 0xFD2FB528, got 0x${magic.toString(16).toUpperCase()}`
    );
  }

  const startOffset = offset;
  offset += 4;

  const fhd = buf[offset++];
  const fcsFlag = (fhd >> FHD_FCS_SHIFT) & 0x03;
  const singleSegment = ((fhd >> FHD_SINGLE_SEGMENT_BIT) & 0x01) === 1;
  if (((fhd >> FHD_RESERVED_BIT) & 0x01) !== 0) {
    throw new ConversionFailedError('Malformed Zstandard frame: reserved header bit must be 0.');
  }
  const contentChecksumFlag = ((fhd >> FHD_CHECKSUM_BIT) & 0x01) === 1;
  const dictIdFlag = fhd & FHD_DICT_ID_MASK;

  let windowSize = 0;
  if (!singleSegment) {
    if (offset >= buf.length) throw new ConversionFailedError('Malformed Zstandard frame: missing window descriptor.');
    const wd = buf[offset++];
    const exponent = wd >> WINDOW_DESCRIPTOR_EXPONENT_SHIFT;
    const mantissa = wd & WINDOW_DESCRIPTOR_MANTISSA_MASK;
    const windowBase = 2 ** (ZSTD_WINDOW_LOG_MIN + exponent);
    const windowAdd = (windowBase / WINDOW_MANTISSA_STEPS) * mantissa;
    windowSize = windowBase + windowAdd;
  }

  let dictionaryId = 0;
  if (dictIdFlag === 1) {
    if (offset + 1 > buf.length) throw new ConversionFailedError('Truncated dictionary ID');
    dictionaryId = buf[offset++];
  } else if (dictIdFlag === 2) {
    if (offset + 2 > buf.length) throw new ConversionFailedError('Truncated dictionary ID');
    dictionaryId = buf.readUInt16LE(offset);
    offset += 2;
  } else if (dictIdFlag === 3) {
    if (offset + 4 > buf.length) throw new ConversionFailedError('Truncated dictionary ID');
    dictionaryId = buf.readUInt32LE(offset);
    offset += 4;
  }

  let frameContentSize: number | null = null;
  if (fcsFlag === 0) {
    if (singleSegment) {
      if (offset >= buf.length) throw new ConversionFailedError('Truncated FCS');
      frameContentSize = buf[offset++];
    }
  } else if (fcsFlag === 1) {
    if (offset + 2 > buf.length) throw new ConversionFailedError('Truncated FCS');
    frameContentSize = buf.readUInt16LE(offset) + FCS_TWO_BYTE_BIAS;
    offset += 2;
  } else if (fcsFlag === 2) {
    if (offset + 4 > buf.length) throw new ConversionFailedError('Truncated FCS');
    frameContentSize = buf.readUInt32LE(offset);
    offset += 4;
  } else if (fcsFlag === 3) {
    if (offset + 8 > buf.length) throw new ConversionFailedError('Truncated FCS');
    frameContentSize = Number(buf.readBigUInt64LE(offset));
    offset += 8;
  }

  if (singleSegment && frameContentSize !== null) {
    windowSize = frameContentSize;
  }
  return {
    singleSegment,
    contentChecksumFlag,
    dictionaryId,
    frameContentSize,
    windowSize,
    headerSize: offset - startOffset,
  };
}

export interface ZstdDecompressOptions {
  /**
   * The caller knows the exact output size it will accept (for example a container's declared page
   * size). Output past this many bytes is rejected and the generic ratio guard is not applied, since
   * the caller's bound already limits the expansion.
   */
  maxOutputBytes?: number;
}

/**
 * Decompresses an arbitrary RFC 8878 Zstandard stream with bomb safeguards.
 * Every failure surfaces as a ConversionFailedError; there is no fallback decoder.
 */
export function decompressZstd(inputBuffer: Buffer, options: ZstdDecompressOptions = {}): Buffer {
  return decodeZstdFrames(inputBuffer, null, options.maxOutputBytes);
}

/**
 * Same decoder and guards as `decompressZstd`, with the dictionary content as match history and
 * (for full RFC 8878 section 5 dictionaries) its entropy tables and repeat offsets as the
 * starting state of every frame.
 */
export function decompressZstdWithDictionary(inputBuffer: Buffer, dictionary: ZstdParsedDictionary): Buffer {
  return decodeZstdFrames(inputBuffer, dictionary);
}

function decodeZstdFrames(inputBuffer: Buffer, dictionary: ZstdParsedDictionary | null, callerBound?: number): Buffer {
  // A caller that knows the exact size it accepts bounds the output itself, so the ratio guard is not applied.
  const sizeLimit = callerBound ?? ZSTD_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE;
  const ratioGuarded = callerBound === undefined;
  if (!inputBuffer || inputBuffer.length < 4) {
    throw new ConversionFailedError('Decompress error: input buffer too small for Zstandard stream.');
  }

  const src = inputBuffer;
  const dictionaryLength = dictionary === null ? 0 : dictionary.content.length;
  const out = new ZstdOutputBuffer(sizeLimit + ZSTD_BLOCK_SIZE_MAX + dictionaryLength);
  let offset = 0;

  while (offset < src.length) {
    if (offset + 4 > src.length) {
      throw new ConversionFailedError('Malformed Zstandard stream: trailing bytes after the last frame.');
    }
    const magic = src.readUInt32LE(offset);

    if (magic >= SKIPPABLE_FRAME_MAGIC_MIN && magic <= SKIPPABLE_FRAME_MAGIC_MAX) {
      if (offset + SKIPPABLE_HEADER_BYTES > src.length) {
        throw new ConversionFailedError('Malformed skippable frame: header truncated.');
      }
      const skipLength = src.readUInt32LE(offset + 4);
      if (offset + SKIPPABLE_HEADER_BYTES + skipLength > src.length) {
        throw new ConversionFailedError('Malformed skippable frame: payload truncated.');
      }
      offset += SKIPPABLE_HEADER_BYTES + skipLength;
      continue;
    }

    if (magic !== ZSTD_MAGIC_NUMBER) {
      throw new ConversionFailedError(
        `Invalid Zstandard magic signature: 0x${magic.toString(16).toUpperCase()} at offset ${offset}`
      );
    }

    const frameHeader = parseZstdFrameHeader(src, offset);
    offset += frameHeader.headerSize;
    if (frameHeader.windowSize > ZSTD_DECODER_WINDOW_SIZE_MAX) {
      throw new ConversionFailedError(
        `Zstandard frame window size ${frameHeader.windowSize} exceeds the decoder limit of ${ZSTD_DECODER_WINDOW_SIZE_MAX} bytes.`
      );
    }
    if (dictionary === null && frameHeader.dictionaryId !== 0) {
      throw new ConversionFailedError(
        `Zstandard frame requires dictionary ${frameHeader.dictionaryId}; use the dictionary decoder.`
      );
    }
    if (
      dictionary !== null &&
      frameHeader.dictionaryId !== 0 &&
      dictionary.id !== null &&
      frameHeader.dictionaryId !== dictionary.id
    ) {
      throw new ConversionFailedError(
        `Decoding error (36): Dictionary mismatch: frame requires dictionary ID 0x${frameHeader.dictionaryId.toString(16)}, but provided dictionary has ID 0x${dictionary.id.toString(16)}`
      );
    }
    const declaredSize = frameHeader.frameContentSize;
    if (declaredSize !== null) {
      // Reject a declared size that the guards would reject anyway before reserving memory for it.
      if (out.length + declaredSize > sizeLimit) throw bombSizeError(sizeLimit);
      if (ratioGuarded && exceedsZstdRatioGuard(out.length + declaredSize, src.length)) {
        throw bombRatioError(out.length + declaredSize, src.length);
      }
      out.reserve(declaredSize + dictionaryLength);
    }

    // The dictionary content sits right before the frame's output so offsets reach it directly;
    // it is squeezed out again once the frame is verified.
    if (dictionary !== null) {
      out.ensure(dictionaryLength);
      out.data.set(dictionary.content, out.length);
      out.length += dictionaryLength;
    }
    const frameStart = out.length;
    const state = createFrameDecodeState(frameHeader.windowSize, declaredSize, dictionary);

    let isLast = false;
    while (!isLast) {
      if (offset + BLOCK_HEADER_BYTES > src.length) {
        throw new ConversionFailedError('Malformed Zstandard frame: truncated block header.');
      }
      const headerVal = src[offset] | (src[offset + 1] << 8) | (src[offset + 2] << 16);
      offset += BLOCK_HEADER_BYTES;

      isLast = (headerVal & 0x01) === 1;
      const blockType = (headerVal >> 1) & 0x03;
      const blockSize = headerVal >>> 3;

      if (blockType === 3) {
        throw new ConversionFailedError('Malformed Zstandard block: reserved block type 3 encountered.');
      }
      if (blockSize > state.blockMaxSize) {
        throw new ConversionFailedError('Malformed Zstandard block: size exceeds the block maximum.');
      }
      if (declaredSize !== null && blockType !== BLOCK_TYPE_COMPRESSED && out.length - frameStart + blockSize > declaredSize) {
        throw new ConversionFailedError(
          `Zstandard frame content size mismatch: header declares ${declaredSize}, blocks decode to more.`
        );
      }

      if (blockType === BLOCK_TYPE_RAW) {
        if (offset + blockSize > src.length) {
          throw new ConversionFailedError('Malformed Zstandard raw block: out of bounds data.');
        }
        out.ensure(blockSize);
        out.data.set(src.subarray(offset, offset + blockSize), out.length);
        out.length += blockSize;
        offset += blockSize;
      } else if (blockType === BLOCK_TYPE_RLE) {
        if (offset + 1 > src.length) {
          throw new ConversionFailedError('Malformed Zstandard RLE block: missing byte.');
        }
        out.ensure(blockSize);
        out.data.fill(src[offset++], out.length, out.length + blockSize);
        out.length += blockSize;
      } else {
        if (offset + blockSize > src.length) {
          throw new ConversionFailedError('Malformed Zstandard compressed block: truncated data.');
        }
        decodeCompressedBlock(src, offset, offset + blockSize, out, frameStart, state);
        offset += blockSize;
      }

      // Cumulative security limits, on decoded bytes only (the dictionary prefix does not count)
      const produced = out.length - dictionaryLength;
      if (produced > sizeLimit) {
        throw bombSizeError(sizeLimit);
      }
      if (ratioGuarded && exceedsZstdRatioGuard(produced, src.length)) {
        throw bombRatioError(produced, src.length);
      }
      out.projectedTotal = Math.ceil((produced * src.length) / offset) + dictionaryLength;
    }

    const frameLength = out.length - frameStart;
    if (frameHeader.frameContentSize !== null && frameHeader.frameContentSize !== frameLength) {
      throw new ConversionFailedError(
        `Zstandard frame content size mismatch: header declares ${frameHeader.frameContentSize}, decoded ${frameLength}.`
      );
    }

    if (frameHeader.contentChecksumFlag) {
      if (offset + CONTENT_CHECKSUM_BYTES > src.length) {
        throw new ConversionFailedError('Malformed Zstandard frame: missing content checksum.');
      }
      const expectedChecksum = src.readUInt32LE(offset);
      offset += CONTENT_CHECKSUM_BYTES;
      const actualChecksum = computeZstdChecksum(out.data.subarray(frameStart, out.length));
      if (actualChecksum !== expectedChecksum) {
        throw new ConversionFailedError(
          `Zstandard content checksum mismatch: expected 0x${expectedChecksum.toString(16)}, computed 0x${actualChecksum.toString(16)}`
        );
      }
    }

    if (dictionaryLength > 0) {
      out.data.copyWithin(frameStart - dictionaryLength, frameStart, out.length);
      out.length -= dictionaryLength;
    }
  }

  return out.toBuffer();
}

/**
 * Encodes an RFC 8878 single-segment frame header with optional dictionary ID embedding.
 */
export function encodeZstdSingleSegmentHeader(
  inputLen: number,
  dictId: number = 0
): { fhd: number; fcsBuf: Buffer; dictIdBuf: Buffer | null } {
  let fcsFlag = 0;
  let fcsBuf: Buffer;

  if (inputLen < 256) {
    fcsFlag = 0;
    fcsBuf = Buffer.from([inputLen]);
  } else if (inputLen < 65536 + 256) {
    fcsFlag = 1;
    fcsBuf = Buffer.alloc(2);
    fcsBuf.writeUInt16LE(inputLen - 256, 0);
  } else {
    fcsFlag = 2;
    fcsBuf = Buffer.alloc(4);
    fcsBuf.writeUInt32LE(inputLen, 0);
  }

  let dictIdFlag = 0;
  let dictIdBuf: Buffer | null = null;
  if (dictId && dictId > 0) {
    dictIdFlag = 3;
    dictIdBuf = Buffer.alloc(4);
    dictIdBuf.writeUInt32LE(dictId, 0);
  }

  const fhd = (fcsFlag << 6) | (1 << 5) | (1 << 2) | dictIdFlag;
  return { fhd, fcsBuf, dictIdBuf };
}

export interface ZstdCompressOptions {
  /** Compression level 1-19 (default 3). */
  level?: number;
  /** Append the XXH64 content checksum (default true). */
  checksum?: boolean;
}

/** Spare output capacity above 1/8 of the result triggers a right-sizing copy. */
const OUTPUT_SPARE_DENOMINATOR = 8;

/**
 * Encodes a frame header. A null windowLog selects single-segment form (window = content size);
 * otherwise a window descriptor for 2^windowLog is emitted. The content size is always present.
 */
export function encodeZstdFrameHeader(
  inputLen: number,
  windowLog: number | null,
  checksum: boolean
): Buffer {
  let fcsFlag: number;
  let fcsBytes: number;
  if (windowLog === null && inputLen < FCS_TWO_BYTE_BIAS) {
    fcsFlag = 0;
    fcsBytes = 1;
  } else if (inputLen < FCS_TWO_BYTE_MAX) {
    fcsFlag = 1;
    fcsBytes = 2;
  } else if (inputLen < FCS_FOUR_BYTE_LIMIT) {
    fcsFlag = 2;
    fcsBytes = 4;
  } else {
    fcsFlag = 3;
    fcsBytes = 8;
  }
  const descriptorBytes = windowLog === null ? 0 : 1;
  const header = Buffer.alloc(1 + descriptorBytes + fcsBytes);
  let pos = 0;
  header[pos++] =
    (fcsFlag << FHD_FCS_SHIFT) |
    ((windowLog === null ? 1 : 0) << FHD_SINGLE_SEGMENT_BIT) |
    ((checksum ? 1 : 0) << FHD_CHECKSUM_BIT);
  if (windowLog !== null) {
    header[pos++] = (windowLog - ZSTD_WINDOW_LOG_MIN) << WINDOW_DESCRIPTOR_EXPONENT_SHIFT;
  }
  if (fcsFlag === 0) header[pos] = inputLen;
  else if (fcsFlag === 1) header.writeUInt16LE(inputLen - FCS_TWO_BYTE_BIAS, pos);
  else if (fcsFlag === 2) header.writeUInt32LE(inputLen, pos);
  else header.writeBigUInt64LE(BigInt(inputLen), pos);
  return header;
}

/**
 * Compresses data into an RFC 8878 compliant Zstandard frame at the requested level (1-19).
 * Blocks are Raw, RLE or Compressed (Huffman literals + FSE sequences), whichever is smallest.
 */
export function compressZstd(inputBuffer: Buffer, options: ZstdCompressOptions = {}): Buffer {
  const level = options.level ?? ZSTD_LEVEL_DEFAULT;
  if (!Number.isInteger(level) || level < ZSTD_LEVEL_MIN || level > ZSTD_LEVEL_MAX) {
    throw new ConversionFailedError(
      `Unsupported zstd compression level ${String(level)}: expected an integer from ${ZSTD_LEVEL_MIN} to ${ZSTD_LEVEL_MAX}.`
    );
  }
  const checksum = options.checksum ?? true;
  const inputLen = inputBuffer.length;
  if (inputLen > ZSTD_ENCODER_INPUT_MAX) {
    throw new ConversionFailedError(
      `Zstandard input of ${inputLen} bytes exceeds the encoder limit of ${ZSTD_ENCODER_INPUT_MAX} bytes.`
    );
  }

  const params = getZstdLevelParams(level);
  const declaredWindow = 2 ** params.windowLog;
  const singleSegment = inputLen <= declaredWindow;
  const windowSize = singleSegment ? inputLen : declaredWindow;
  const header = encodeZstdFrameHeader(inputLen, singleSegment ? null : params.windowLog, checksum);

  const prefix = Buffer.concat([ZSTD_MAGIC_LE, header]);
  const trailerBytes = checksum ? CONTENT_CHECKSUM_BYTES : 0;
  const encoded = new ZstdBlockEncoder(inputBuffer, params, windowSize).encodeAll(prefix, trailerBytes);
  let end = encoded.length;
  if (checksum) {
    new DataView(encoded.data.buffer, encoded.data.byteOffset, encoded.data.byteLength).setUint32(
      end,
      computeZstdChecksum(inputBuffer),
      true
    );
    end += CONTENT_CHECKSUM_BYTES;
  }
  // Hand back a view when the spare capacity is small (incompressible input); otherwise right-size
  // with one copy of the (much smaller) compressed bytes so a large scratch buffer is not retained.
  const spare = encoded.data.length - end;
  if (spare * OUTPUT_SPARE_DENOMINATOR > end) return Buffer.from(encoded.data.subarray(0, end));
  return Buffer.from(encoded.data.buffer, encoded.data.byteOffset, end);
}
