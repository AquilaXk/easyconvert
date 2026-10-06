/**
 * Pure TypeScript In-Memory Audio Bitstream Helpers
 *
 * Lossy video (H.264) and lossy AAC encoding are not implemented here: a faithful
 * encoder needs the native FFmpeg engine, and conversions requesting one fail with
 * EngineUnavailableError when it is absent. What remains is the bit-level I/O helpers,
 * the lossless FLAC encoder (RFC 9639), and a reduced AAC LC raw_data_block reader
 * (no window switching, no overlap-add) that fails closed on streams it cannot parse.
 */

import { encodePureMp3 as pureEncodeMp3 } from '../edge/pure/pure-audio';
import { ConversionFailedError } from '../types';
export {
  FLAC_CRC8_TABLE,
  FLAC_CRC16_TABLE,
  flacCrc8,
  flacCrc16,
  encodeFlacStream,
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
