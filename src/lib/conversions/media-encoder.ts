/**
 * Audio Bitstream Helpers
 *
 * Lossy encoding (H.264, AAC, MP3) and lossy AAC decoding are not implemented here: a faithful
 * codec needs the native FFmpeg engine, and conversions requesting one fail with
 * EngineUnavailableError when it is absent. What remains is the bit-level writer and the
 * lossless FLAC encoder (RFC 9639).
 */

export {
  FLAC_CRC8_TABLE,
  FLAC_CRC16_TABLE,
  flacCrc8,
  flacCrc16,
  encodeFlacStream,
} from './flac-encoder';

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

// ============================================================================
// 2. Pure TypeScript FLAC Lossless Audio Encoder (RFC 9639)
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
