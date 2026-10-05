/**
 * Pure TypeScript In-Memory Audio Bitstream Helpers
 *
 * Lossy video (H.264) and lossy AAC encoding are not implemented here: a faithful
 * encoder needs the native FFmpeg engine, and conversions requesting one fail with
 * EngineUnavailableError when it is absent. What remains is the bit-level I/O helpers,
 * the lossless FLAC encoder (RFC 9639), and a reduced AAC LC raw_data_block reader
 * (no window switching, no overlap-add) that fails closed on streams it cannot parse.
 */

import crypto from 'node:crypto';
import { encodePureMp3 as pureEncodeMp3 } from '../edge/pure/pure-audio';
import { ConversionFailedError } from '../types';
import {
  FLAC_DEFAULT_BITS_PER_SAMPLE,
  validateFlacInput,
  type FlacEncodeOptions,
} from './flac-encoder';
import {
  AAC_SWB_OFFSET_1024_48,
  decodeScalefactorDiff,
  decodeSpectralBand,
} from './media-aac-tables';

// ============================================================================
// 1. BitWriter Helper for Bitstream Packing (Exp-Golomb & Bitpacking)
// ============================================================================

export class BitWriter {
  private bits: number[] = [];

  writeBit(b: number): void {
    this.bits.push(b ? 1 : 0);
  }

  writeBits(val: number, count: number): void {
    for (let i = count - 1; i >= 0; i--) {
      this.writeBit((val >> i) & 1);
    }
  }

  writeUe(val: number): void {
    const v = val + 1;
    const len = Math.floor(Math.log2(v)) + 1;
    for (let i = 0; i < len - 1; i++) {
      this.writeBit(0);
    }
    this.writeBits(v, len);
  }

  writeSe(val: number): void {
    const mapped = val <= 0 ? -2 * val : 2 * val - 1;
    this.writeUe(mapped);
  }

  alignToByte(): void {
    while (this.bits.length % 8 !== 0) {
      this.writeBit(0);
    }
  }

  writeRice(q: number, k: number, rem: number): void {
    for (let i = 0; i < q; i++) {
      this.writeBit(0);
    }
    this.writeBit(1);
    if (k > 0) {
      this.writeBits(rem, k);
    }
  }

  toBuffer(): Buffer {
    const totalBytes = Math.ceil(this.bits.length / 8);
    const buf = Buffer.alloc(totalBytes);
    for (let i = 0; i < this.bits.length; i++) {
      if (this.bits[i]) {
        buf[Math.floor(i / 8)] |= 1 << (7 - (i % 8));
      }
    }
    return buf;
  }
}

export class BitReader {
  private buffer: Buffer;
  private bitPos = 0;
  private _overrun = false;

  constructor(buffer: Buffer) {
    this.buffer = buffer;
  }

  get isOverrun(): boolean {
    return this._overrun;
  }

  readBit(): number {
    const byteIdx = Math.floor(this.bitPos / 8);
    if (byteIdx >= this.buffer.length) {
      this._overrun = true;
      return 0;
    }
    const b = (this.buffer[byteIdx] >> (7 - (this.bitPos % 8))) & 1;
    this.bitPos++;
    return b;
  }

  readBits(count: number): number {
    let val = 0;
    for (let i = 0; i < count; i++) {
      val = (val << 1) | this.readBit();
    }
    return val;
  }
}

// ============================================================================
// 2. Pure TS MP3 Encoder (Delegates to Pure Isomorphic TypedArray Engine)
// ============================================================================

/**
 * Encodes PCM samples into valid MPEG-1 Audio Layer III (MP3) bitstream
 */
export function encodePureMp3(
  samples: Int16Array,
  sampleRate: number,
  channels: number,
  bitrateStr = '192k',
  title = 'EasyConvert Audio'
): Buffer {
  return Buffer.from(pureEncodeMp3(samples, sampleRate, channels, bitrateStr, title));
}

// ============================================================================
// 3. Pure TypeScript FLAC Lossless Audio Encoder (RFC 9639)
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

/**
 * Calculates optimal Rice coding parameter k in [0, 14] for given residuals
 */
export function findOptimalRiceParameter(residuals: Int32Array): { k: number; folded: Uint32Array } {
  const count = residuals.length;
  const folded = new Uint32Array(count);
  let sum = 0n;

  for (let i = 0; i < count; i++) {
    const e = residuals[i];
    const u = (e << 1) ^ (e >> 31);
    folded[i] = u >>> 0;
    sum += BigInt(u >>> 0);
  }

  if (count === 0 || sum === 0n) {
    return { k: 0, folded };
  }

  const mean = Number(sum) / count;
  let bestK = Math.max(0, Math.min(14, Math.floor(Math.log2(Math.max(1, mean * 0.69314718056)))));
  let minBits = Number.MAX_SAFE_INTEGER;

  const kMin = Math.max(0, bestK - 1);
  const kMax = Math.min(14, bestK + 1);

  for (let k = kMin; k <= kMax; k++) {
    let bits = count * (k + 1);
    for (let i = 0; i < count; i++) {
      bits += folded[i] >> k;
    }
    if (bits < minBits) {
      minBits = bits;
      bestK = k;
    }
  }

  return { k: bestK, folded };
}

const FLAC_MIN_BLOCK_SIZE = 16;
const STREAMINFO_MD5_OFFSET = 26;
const MD5_CHUNK_SAMPLES = 1 << 16;
const BYTES_PER_PCM16_SAMPLE = 2;

/** MD5 over the little-endian signed 16-bit interleaved samples (RFC 9639 section 8.2). */
function flacPcmMd5(samples: Int16Array): Buffer {
  const hash = crypto.createHash('md5');
  const chunk = Buffer.alloc(MD5_CHUNK_SAMPLES * BYTES_PER_PCM16_SAMPLE);
  for (let start = 0; start < samples.length; start += MD5_CHUNK_SAMPLES) {
    const count = Math.min(MD5_CHUNK_SAMPLES, samples.length - start);
    for (let i = 0; i < count; i++) {
      chunk.writeInt16LE(samples[start + i], i * BYTES_PER_PCM16_SAMPLE);
    }
    hash.update(chunk.subarray(0, count * BYTES_PER_PCM16_SAMPLE));
  }
  return hash.digest();
}

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

/**
 * Frame header coded number: UTF-8 style variable length integer (RFC 9639 section 9.1.5),
 * one lead byte plus up to five continuation bytes for values below 2^31.
 */
function writeFlacUtf8Number(writer: BitWriter, value: number): void {
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

/**
 * Encodes PCM samples into an authentic RFC 9639 FLAC audio bitstream
 */
export function encodeFlacStream(
  samples: Int16Array,
  sampleRate: number,
  channels: number,
  options: FlacEncodeOptions = {}
): Buffer {
  const bitsPerSample = options.bitsPerSample ?? FLAC_DEFAULT_BITS_PER_SAMPLE;
  const totalSamplesPerChannel = validateFlacInput(samples, sampleRate, channels, bitsPerSample);
  const chCount = channels;

  // 1. STREAMINFO Metadata Block (42 bytes: 4 bytes "fLaC" marker + 4 bytes header + 34 bytes payload)
  const streamInfo = Buffer.alloc(42);
  streamInfo.write('fLaC', 0, 'ascii'); // Stream marker

  // Metadata block header: Last block (0x80) | Block type 0 (STREAMINFO), length 34 (24 bits)
  streamInfo[4] = 0x80 | 0x00;
  streamInfo[5] = 0x00;
  streamInfo[6] = 0x00;
  streamInfo[7] = 34;

  const blockSize = Math.min(4096, Math.max(16, totalSamplesPerChannel));

  // Minimum / Maximum block size (16 bits)
  streamInfo.writeUInt16BE(blockSize, 8);
  streamInfo.writeUInt16BE(blockSize, 10);

  // Min / Max frame size (24 bits, 0 = unknown)
  streamInfo.writeUIntBE(0, 12, 3);
  streamInfo.writeUIntBE(0, 15, 3);

  // Packed 64 bits: sampleRate (20b), channels-1 (3b), bps-1 (5b), totalSamples (36b)
  const sr = sampleRate & 0xfffff;
  const ch = (chCount - 1) & 0x07;
  const bps = (16 - 1) & 0x1f; // 16-bit audio
  const tot = BigInt(totalSamplesPerChannel) & 0xfffffffffn;

  streamInfo[18] = (sr >> 12) & 0xff;
  streamInfo[19] = (sr >> 4) & 0xff;
  streamInfo[20] = ((sr & 0x0f) << 4) | (ch << 1) | ((bps >> 4) & 1);
  streamInfo[21] = ((bps & 0x0f) << 4) | Number((tot >> 32n) & 0x0fn);
  streamInfo[22] = Number((tot >> 24n) & 0xffn);
  streamInfo[23] = Number((tot >> 16n) & 0xffn);
  streamInfo[24] = Number((tot >> 8n) & 0xffn);
  streamInfo[25] = Number(tot & 0xffn);
  // Bytes 26..41: MD5 signature (16 zeros)

  const frames: Buffer[] = [];
  let frameNumber = 0;
  let sampleOffset = 0;

  const srCode = flacSampleRateCode(sampleRate);

  while (sampleOffset < totalSamplesPerChannel) {
    const curBlockSize = Math.min(blockSize, totalSamplesPerChannel - sampleOffset);
    const writer = new BitWriter();

    // Frame Header:
    // Sync code: 14 bits 0x3ffe
    writer.writeBits(0x3ffe, 14);
    // Reserved bit (0)
    writer.writeBit(0);
    // Blocking strategy: 0 (fixed)
    writer.writeBit(0);

    // Block size code (4 bits)
    let bsExplicit = 0;
    if (curBlockSize === 4096) {
      writer.writeBits(12, 4);
    } else if (curBlockSize <= 256) {
      writer.writeBits(6, 4);
      bsExplicit = 1;
    } else {
      writer.writeBits(7, 4);
      bsExplicit = 2;
    }

    // Sample rate code (4 bits)
    writer.writeBits(srCode, 4);

    // Channel assignment (4 bits)
    // 0 = mono, 1 = left/right stereo
    writer.writeBits(chCount === 2 ? 1 : 0, 4);

    // Sample size: 16-bit = 0b100 (4)
    writer.writeBits(4, 3);
    // Reserved bit
    writer.writeBit(0);

    // Frame number (UTF-8 variable length)
    writeFlacUtf8Number(writer, frameNumber);

    // Explicit block size if needed
    if (bsExplicit === 1) {
      writer.writeBits(curBlockSize - 1, 8);
    } else if (bsExplicit === 2) {
      writer.writeBits(curBlockSize - 1, 16);
    }

    // Explicit sample rate for the codes that carry one in the header
    if (srCode === FLAC_RATE_CODE_KHZ) {
      writer.writeBits(sampleRate / 1000, 8);
    } else if (srCode === FLAC_RATE_CODE_HZ) {
      writer.writeBits(sampleRate, 16);
    } else if (srCode === FLAC_RATE_CODE_TENS_OF_HZ) {
      writer.writeBits(sampleRate / 10, 16);
    }

    // Header CRC-8
    writer.alignToByte();
    const headerBytes = writer.toBuffer();
    const crc8Val = flacCrc8(headerBytes);
    writer.writeBits(crc8Val, 8);

    // Subframes (one per channel)
    for (let c = 0; c < chCount; c++) {
      const channelSamples = new Int32Array(curBlockSize);
      for (let s = 0; s < curBlockSize; s++) {
        channelSamples[s] = samples[(sampleOffset + s) * chCount + c];
      }

      // Compute fixed predictor residuals (order 1: s[t] - s[t-1])
      const residuals = new Int32Array(curBlockSize - 1);
      for (let i = 1; i < curBlockSize; i++) {
        residuals[i - 1] = channelSamples[i] - channelSamples[i - 1];
      }

      const { k, folded } = findOptimalRiceParameter(residuals);

      // Subframe header:
      // Zero bit (1b)
      writer.writeBit(0);
      // Subframe type (6b): 001001 = Fixed linear prediction order 1
      writer.writeBits(0x09, 6);
      // Wasted bits flag (1b)
      writer.writeBit(0);

      // Warm-up sample (order 1: 1 sample stored 16-bit signed)
      const warmUp = channelSamples[0];
      writer.writeBits(warmUp < 0 ? (1 << 16) + warmUp : warmUp, 16);

      // Residual coding:
      // Residual method: 2 bits '00' (Rice 4-bit)
      writer.writeBits(0, 2);
      // Partition order: 4 bits '0000' (0 order = 1 partition)
      writer.writeBits(0, 4);
      // Rice parameter k: 4 bits
      writer.writeBits(k, 4);

      // Rice encoded residuals
      for (let i = 0; i < folded.length; i++) {
        const u = folded[i];
        const q = u >> k;
        const rem = u & ((1 << k) - 1);
        // Unary code: q zeros followed by 1 one
        for (let b = 0; b < q; b++) {
          writer.writeBit(0);
        }
        writer.writeBit(1);
        if (k > 0) {
          writer.writeBits(rem, k);
        }
      }
    }

    // Zero-padding to byte boundary
    writer.alignToByte();

    // Frame CRC-16 (covers whole frame up to footer)
    const frameContent = writer.toBuffer();
    const crc16Val = flacCrc16(frameContent);

    const frameBuf = Buffer.alloc(frameContent.length + 2);
    frameContent.copy(frameBuf, 0);
    frameBuf.writeUInt16BE(crc16Val, frameContent.length);

    frames.push(frameBuf);

    frameNumber++;
    sampleOffset += curBlockSize;
  }

  // Exact STREAMINFO bounds (RFC 9639 section 8.2): the minimum block size excludes the last block.
  let minFrameSize = 0;
  let maxFrameSize = 0;
  for (const frame of frames) {
    if (minFrameSize === 0 || frame.length < minFrameSize) minFrameSize = frame.length;
    if (frame.length > maxFrameSize) maxFrameSize = frame.length;
  }
  streamInfo.writeUIntBE(minFrameSize, 12, 3);
  streamInfo.writeUIntBE(maxFrameSize, 15, 3);
  const lastBlockSize = totalSamplesPerChannel - (frames.length - 1) * blockSize;
  const maxBlockSize = frames.length > 1 ? blockSize : lastBlockSize;
  const minBlockSize = frames.length > 1 ? blockSize : lastBlockSize;
  streamInfo.writeUInt16BE(Math.max(FLAC_MIN_BLOCK_SIZE, minBlockSize), 8);
  streamInfo.writeUInt16BE(Math.max(FLAC_MIN_BLOCK_SIZE, maxBlockSize), 10);
  flacPcmMd5(samples).copy(streamInfo, STREAMINFO_MD5_OFFSET);

  return Buffer.concat([streamInfo, ...frames]);
}

// ============================================================================
// 4. ISO/IEC 13818-7 / 14496-3 AAC LC Raw Data Block Reader
// ============================================================================

export const AAC_FRAME_SAMPLES = 1024;
export const AAC_SPECTRAL_LINES = 1024;
export const AAC_SPECTRAL_BANDS = 128; // Preserved export for backward compatibility

const aacWinTable = new Float64Array(AAC_FRAME_SAMPLES);
for (let n = 0; n < AAC_FRAME_SAMPLES; n++) {
  aacWinTable[n] = Math.sin((Math.PI / AAC_FRAME_SAMPLES) * (n + 0.5));
}

// Precomputed cosine table for 1024-point MDCT transform
const aacCosTable = new Float32Array(AAC_SPECTRAL_LINES * AAC_FRAME_SAMPLES);
for (let k = 0; k < AAC_SPECTRAL_LINES; k++) {
  const factor = (Math.PI / AAC_SPECTRAL_LINES) * (k + 0.5);
  const row = k * AAC_FRAME_SAMPLES;
  for (let n = 0; n < AAC_FRAME_SAMPLES; n++) {
    aacCosTable[row + n] = Math.cos(factor * (n + 0.5 + AAC_SPECTRAL_LINES * 0.5));
  }
}

/**
 * Decodes a reduced AAC LC raw_data_block (ONLY_LONG_SEQUENCE, SCE/CPE, no TDAC overlap-add)
 * into 16-bit PCM samples. Returns null for any stream outside that subset.
 */
export function decodeAacLcFramePayload(payload: Buffer, channels: number): Int16Array | null {
  if (channels < 1 || channels > 2) return null;
  if (payload.length < 4) return null;
  const reader = new BitReader(payload);
  const elementId = reader.readBits(3);

  if (channels === 1 && elementId === 0) {
    // ID_SCE
    reader.readBits(4); // tag
    const global_gain = reader.readBits(8);
    reader.readBit(); // reserved
    const winSeq = reader.readBits(2);
    const winShape = reader.readBit();
    const max_sfb = reader.readBits(6);
    if (max_sfb === 0 || max_sfb > 49) return null;
    reader.readBit(); // pred

    // Read sections
    const bandCodebook = new Uint8Array(max_sfb);
    let db = 0;
    while (db < max_sfb) {
      const cb = reader.readBits(4);
      if (cb > 11) return null; // Invalid spectral codebook for AAC LC
      let run = 0;
      let incr = 0;
      do {
        incr = reader.readBits(5);
        run += incr;
      } while (incr === 31);
      if (run <= 0) return null;
      const end = Math.min(max_sfb, db + run);
      for (let k = db; k < end; k++) bandCodebook[k] = cb;
      db = end;
    }

    // Read scalefactors
    const bandScale = new Float64Array(max_sfb);
    let curSf = global_gain;
    for (let k = 0; k < max_sfb; k++) {
      if (bandCodebook[k] !== 0) {
        const diff = decodeScalefactorDiff(reader);
        curSf += diff;
        bandScale[k] = Math.pow(2, (curSf - 100) / 16);
      }
    }

    // pulse, tns, gain_control
    reader.readBit();
    reader.readBit();
    reader.readBit();

    // Decode spectral coefficients
    const q = new Int16Array(AAC_FRAME_SAMPLES);
    const mdct = new Float64Array(AAC_FRAME_SAMPLES);
    for (let k = 0; k < max_sfb; k++) {
      if (bandCodebook[k] !== 0) {
        const start = AAC_SWB_OFFSET_1024_48[k];
        const end = AAC_SWB_OFFSET_1024_48[k + 1];
        decodeSpectralBand(reader, bandCodebook[k], q, start, end);
        const scale = bandScale[k];
        for (let i = start; i < end; i++) {
          mdct[i] = q[i] * scale;
        }
      }
    }

    // Validate ID_END terminator (0b111 = 7) and buffer overrun
    const endTag = reader.readBits(3);
    if (endTag !== 7 || reader.isOverrun) return null;

    const numLines = AAC_SWB_OFFSET_1024_48[max_sfb];
    const out = new Int16Array(AAC_FRAME_SAMPLES);
    for (let n = 0; n < AAC_FRAME_SAMPLES; n++) {
      let sum = 0.0;
      for (let k = 0; k < numLines; k++) {
        sum += mdct[k] * aacCosTable[k * AAC_FRAME_SAMPLES + n];
      }
      out[n] = Math.max(-32768, Math.min(32767, Math.round(sum * aacWinTable[n] * 2.0)));
    }
    return out;
  } else if (channels === 2 && elementId === 1) {
    // ID_CPE
    reader.readBits(4); // tag
    const common_window = reader.readBit();
    if (!common_window) return null;
    reader.readBit(); // reserved
    const winSeq = reader.readBits(2);
    const winShape = reader.readBit();
    const max_sfb = reader.readBits(6);
    if (max_sfb === 0 || max_sfb > 49) return null;
    reader.readBit(); // pred
    const ms_mask_present = reader.readBits(2); // ms_mask_present
    if (ms_mask_present === 1) {
      for (let s = 0; s < max_sfb; s++) {
        reader.readBit();
      }
    }

    function readChannelStream(): Float64Array | null {
      const gain = reader.readBits(8);
      const codebooks = new Uint8Array(max_sfb);
      let db = 0;
      while (db < max_sfb) {
        const cb = reader.readBits(4);
        if (cb > 11) return null; // Invalid spectral codebook for AAC LC
        let run = 0;
        let incr = 0;
        do {
          incr = reader.readBits(5);
          run += incr;
        } while (incr === 31);
        if (run <= 0) return null;
        const end = Math.min(max_sfb, db + run);
        for (let k = db; k < end; k++) codebooks[k] = cb;
        db = end;
      }

      const scale = new Float64Array(max_sfb);
      let curSf = gain;
      for (let k = 0; k < max_sfb; k++) {
        if (codebooks[k] !== 0) {
          const diff = decodeScalefactorDiff(reader);
          curSf += diff;
          scale[k] = Math.pow(2, (curSf - 100) / 16);
        }
      }

      reader.readBit(); // pulse
      reader.readBit(); // tns
      reader.readBit(); // gain_control

      const q = new Int16Array(AAC_FRAME_SAMPLES);
      const mdct = new Float64Array(AAC_FRAME_SAMPLES);
      for (let k = 0; k < max_sfb; k++) {
        if (codebooks[k] !== 0) {
          const start = AAC_SWB_OFFSET_1024_48[k];
          const end = AAC_SWB_OFFSET_1024_48[k + 1];
          decodeSpectralBand(reader, codebooks[k], q, start, end);
          const sc = scale[k];
          for (let i = start; i < end; i++) {
            mdct[i] = q[i] * sc;
          }
        }
      }
      return mdct;
    }

    const mdct0 = readChannelStream();
    const mdct1 = readChannelStream();
    if (!mdct0 || !mdct1) return null;

    // Validate ID_END terminator (0b111 = 7) and buffer overrun
    const endTag = reader.readBits(3);
    if (endTag !== 7 || reader.isOverrun) return null;

    const numLines = AAC_SWB_OFFSET_1024_48[max_sfb];

    const out = new Int16Array(AAC_FRAME_SAMPLES * 2);
    for (let n = 0; n < AAC_FRAME_SAMPLES; n++) {
      let sum0 = 0.0;
      let sum1 = 0.0;
      for (let k = 0; k < numLines; k++) {
        const cosVal = aacCosTable[k * AAC_FRAME_SAMPLES + n];
        sum0 += mdct0[k] * cosVal;
        sum1 += mdct1[k] * cosVal;
      }
      out[n * 2] = Math.max(-32768, Math.min(32767, Math.round(sum0 * aacWinTable[n] * 2.0)));
      out[n * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(sum1 * aacWinTable[n] * 2.0)));
    }
    return out;
  }

  return null;
}
