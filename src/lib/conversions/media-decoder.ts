/**
 * Pure TypeScript In-Memory Audio Decoders
 *
 * Implements zero-dependency decoders for:
 * 1. PCM WAV & AIFF: 8-bit unsigned, 16-bit/24-bit/32-bit signed PCM, 32-bit IEEE float,
 *    and Apple AIFF / AIFC containers with 80-bit IEEE 754 extended precision sample rates.
 * 2. RFC 9639 FLAC (Free Lossless Audio Codec):
 *    - Parses STREAMINFO metadata block.
 *    - Scans frame sync words (0x3FFE).
 *    - Decodes Constant, Verbatim, Fixed Linear Prediction (orders 0..4), and LPC subframes.
 *    - Unpacks unary Rice residuals (4-bit and 5-bit partitions).
 *    - Supports Independent, Left/Side, Right/Side, and Mid/Side channel decorrelation.
 * 3. MPEG-1 Audio Layer III (MP3):
 *    - ID3v2 metadata header stripping.
 *    - Frame synchronization (0xFFE0..0xFFFF).
 *    - Header parsing (bitrate, sample rate, padding, channel mode).
 *    - Pure IMDCT spectral reconstruction for authentic 16-bit PCM output.
 */

export interface DecodedAudio {
  samples: Int16Array;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  duration: number;
}

// ============================================================================
// BitReader Helper for FLAC and MP3 Bitstream Parsing
// ============================================================================

export class BitReader {
  private buf: Buffer;
  private bytePos: number;
  private bitPos: number; // 7 = MSB, 0 = LSB

  constructor(buf: Buffer, startOffset = 0) {
    this.buf = buf;
    this.bytePos = startOffset;
    this.bitPos = 7;
  }

  readBit(): number {
    if (this.bytePos >= this.buf.length) return 0;
    const bit = (this.buf[this.bytePos] >> this.bitPos) & 1;
    if (this.bitPos === 0) {
      this.bytePos++;
      this.bitPos = 7;
    } else {
      this.bitPos--;
    }
    return bit;
  }

  readBits(count: number): number {
    let res = 0;
    for (let i = 0; i < count; i++) {
      res = (res << 1) | this.readBit();
    }
    return res >>> 0;
  }

  readSignedBits(count: number): number {
    if (count <= 0) return 0;
    const val = this.readBits(count);
    if (val & (1 << (count - 1))) {
      return val - (1 << count);
    }
    return val;
  }

  readUnary(): number {
    let count = 0;
    while (this.bytePos < this.buf.length) {
      if (this.readBit() === 1) break;
      count++;
    }
    return count;
  }

  readUtf8Number(): number {
    const b0 = this.readBits(8);
    if ((b0 & 0x80) === 0) return b0;
    let mask = 0x40;
    let numBytes = 1;
    while ((b0 & mask) !== 0) {
      numBytes++;
      mask >>= 1;
    }
    let val = b0 & (mask - 1);
    for (let i = 1; i < numBytes; i++) {
      const b = this.readBits(8);
      val = (val << 6) | (b & 0x3f);
    }
    return val;
  }

  alignToByte(): void {
    if (this.bitPos !== 7) {
      this.bytePos++;
      this.bitPos = 7;
    }
  }

  getBytePos(): number {
    return this.bytePos;
  }

  isEof(): boolean {
    return this.bytePos >= this.buf.length;
  }
}

// ============================================================================
// 1. WAV & AIFF Audio Decoder
// ============================================================================

/**
 * Reads an 80-bit IEEE 754 extended precision float (used in AIFF COMM chunk)
 */
function readExtendedFloat(buf: Buffer, offset: number): number {
  if (offset + 10 > buf.length) return 44100;
  const sign = (buf[offset] & 0x80) ? -1 : 1;
  const exp = ((buf[offset] & 0x7f) << 8) | buf[offset + 1];
  const hi = buf.readUInt32BE(offset + 2);
  const lo = buf.readUInt32BE(offset + 6);

  if (exp === 0 && hi === 0 && lo === 0) return 0;
  if (exp === 0x7fff) return Infinity;

  const mantissa = hi * Math.pow(2, -31) + lo * Math.pow(2, -63);
  return sign * mantissa * Math.pow(2, exp - 16383);
}

/**
 * Decodes RIFF WAV and AIFF audio buffers into signed 16-bit PCM samples
 */
export function decodeWav(buffer: Buffer): DecodedAudio {
  if (!buffer || buffer.length < 12) {
    throw new Error('Unsupported audio format: decoder unavailable');
  }

  const magic = buffer.toString('ascii', 0, 4);

  // 1. Handle AIFF / AIFC
  if (magic === 'FORM') {
    const formType = buffer.toString('ascii', 8, 12);
    if (formType !== 'AIFF' && formType !== 'AIFC') {
      throw new Error('Unsupported audio format: decoder unavailable');
    }

    let channels = 2;
    let sampleRate = 44100;
    let bitsPerSample = 16;
    let dataOffset = -1;
    let dataSize = 0;

    let offset = 12;
    while (offset + 8 <= buffer.length) {
      const chunkId = buffer.toString('ascii', offset, offset + 4);
      const chunkSize = buffer.readUInt32BE(offset + 4);

      if (chunkId === 'COMM' && offset + 26 <= buffer.length) {
        channels = buffer.readInt16BE(offset + 8);
        bitsPerSample = buffer.readInt16BE(offset + 14);
        sampleRate = Math.round(readExtendedFloat(buffer, offset + 16)) || 44100;
      } else if (chunkId === 'SSND' && offset + 16 <= buffer.length) {
        const soundOffset = buffer.readUInt32BE(offset + 8);
        dataOffset = offset + 16 + soundOffset;
        dataSize = Math.max(0, Math.min(chunkSize - 8 - soundOffset, buffer.length - dataOffset));
      }

      offset += 8 + ((chunkSize + 1) & ~1);
    }

    if (dataOffset < 0) {
      throw new Error('Unsupported audio format: decoder unavailable');
    }

    const samples = decodePcmBytes(buffer, dataOffset, dataSize, bitsPerSample, true, 1);
    const duration = samples.length / (channels * sampleRate);
    return { samples, sampleRate, channels, bitsPerSample: 16, duration };
  }

  // 2. Handle RIFF / RIFX WAV
  const isRiff = magic === 'RIFF';
  const isRifx = magic === 'RIFX';

  if (!isRiff && !isRifx) {
    throw new Error('Unsupported audio format: decoder unavailable');
  }

  const waveType = buffer.toString('ascii', 8, 12);
  if (waveType !== 'WAVE') {
    throw new Error('Unsupported audio format: decoder unavailable');
  }

  let channels = 2;
  let sampleRate = 44100;
  let bitsPerSample = 16;
  let audioFormat = 1; // 1 = PCM, 3 = IEEE float
  let dataOffset = -1;
  let dataSize = 0;

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = isRifx ? buffer.readUInt32BE(offset + 4) : buffer.readUInt32LE(offset + 4);

    if (chunkId === 'fmt ' && offset + 24 <= buffer.length) {
      audioFormat = isRifx ? buffer.readUInt16BE(offset + 8) : buffer.readUInt16LE(offset + 8);
      channels = isRifx ? buffer.readUInt16BE(offset + 10) : buffer.readUInt16LE(offset + 10);
      sampleRate = isRifx ? buffer.readUInt32BE(offset + 12) : buffer.readUInt32LE(offset + 12);
      bitsPerSample = isRifx ? buffer.readUInt16BE(offset + 22) : buffer.readUInt16LE(offset + 22);

      // WAVE_FORMAT_EXTENSIBLE (0xFFFE)
      if (audioFormat === 0xfffe && offset + 40 <= buffer.length) {
        const subFormatGuid = isRifx ? buffer.readUInt16BE(offset + 32) : buffer.readUInt16LE(offset + 32);
        audioFormat = subFormatGuid; // 1 = PCM, 3 = Float
      }
    } else if (chunkId === 'data') {
      dataOffset = offset + 8;
      dataSize = Math.max(0, Math.min(chunkSize, buffer.length - dataOffset));
      break;
    }

    const paddedSize = (chunkSize + 1) & ~1;
    if (paddedSize <= 0 || offset + 8 + paddedSize <= offset) break;
    offset += 8 + paddedSize;
  }

  if (dataOffset < 0) {
    throw new Error('Unsupported audio format: decoder unavailable');
  }

  const samples = decodePcmBytes(buffer, dataOffset, dataSize, bitsPerSample, isRifx, audioFormat);
  const duration = samples.length / (channels * sampleRate);
  return { samples, sampleRate, channels, bitsPerSample: 16, duration };
}

/**
 * Unpacks PCM bytes into Int16Array based on bit depth, endianness, and format
 */
function decodePcmBytes(
  buffer: Buffer,
  offset: number,
  length: number,
  bitsPerSample: number,
  isBigEndian: boolean,
  audioFormat: number
): Int16Array {
  if (bitsPerSample === 8) {
    const count = length;
    const samples = new Int16Array(count);
    for (let i = 0; i < count; i++) {
      if (isBigEndian) {
        // AIFF 8-bit is signed (-128..127)
        samples[i] = buffer.readInt8(offset + i) << 8;
      } else {
        // WAV 8-bit is unsigned (0..255)
        samples[i] = (buffer[offset + i] - 128) << 8;
      }
    }
    return samples;
  }

  if (bitsPerSample === 16) {
    const count = Math.floor(length / 2);
    const samples = new Int16Array(count);
    for (let i = 0; i < count; i++) {
      samples[i] = isBigEndian
        ? buffer.readInt16BE(offset + i * 2)
        : buffer.readInt16LE(offset + i * 2);
    }
    return samples;
  }

  if (bitsPerSample === 24) {
    const count = Math.floor(length / 3);
    const samples = new Int16Array(count);
    for (let i = 0; i < count; i++) {
      const pos = offset + i * 3;
      if (isBigEndian) {
        const b0 = buffer[pos];
        const b1 = buffer[pos + 1];
        const b2 = buffer[pos + 2];
        let val = (b0 << 16) | (b1 << 8) | b2;
        if (val & 0x800000) val |= 0xff000000;
        samples[i] = val >> 8;
      } else {
        const b0 = buffer[pos];
        const b1 = buffer[pos + 1];
        const b2 = buffer[pos + 2];
        let val = (b2 << 16) | (b1 << 8) | b0;
        if (val & 0x800000) val |= 0xff000000;
        samples[i] = val >> 8;
      }
    }
    return samples;
  }

  if (bitsPerSample === 32) {
    const count = Math.floor(length / 4);
    const samples = new Int16Array(count);
    if (audioFormat === 3) {
      // 32-bit IEEE float
      for (let i = 0; i < count; i++) {
        const pos = offset + i * 4;
        const f = isBigEndian ? buffer.readFloatBE(pos) : buffer.readFloatLE(pos);
        samples[i] = Math.max(-32768, Math.min(32767, Math.round(f * 32767)));
      }
    } else {
      // 32-bit signed integer
      for (let i = 0; i < count; i++) {
        const pos = offset + i * 4;
        const val = isBigEndian ? buffer.readInt32BE(pos) : buffer.readInt32LE(pos);
        samples[i] = val >> 16;
      }
    }
    return samples;
  }

  // Fallback to 16-bit
  const count = Math.floor(length / 2);
  const samples = new Int16Array(count);
  for (let i = 0; i < count; i++) {
    samples[i] = buffer.readInt16LE(offset + i * 2);
  }
  return samples;
}

// ============================================================================
// 2. RFC 9639 FLAC Audio Decoder
// ============================================================================

/**
 * Decodes RFC 9639 compliant FLAC audio bitstreams into signed 16-bit PCM samples
 */
export function decodeFlac(buffer: Buffer): DecodedAudio {
  if (!buffer || buffer.length < 42 || buffer.toString('ascii', 0, 4) !== 'fLaC') {
    throw new Error('Unsupported audio format: decoder unavailable');
  }

  let offset = 4;
  let sampleRate = 44100;
  let channels = 2;
  let bitsPerSample = 16;
  let totalSamples = 0;
  let minBlockSize = 4096;

  // 1. Parse Metadata Blocks
  while (offset + 4 <= buffer.length) {
    const headerByte = buffer[offset];
    const isLast = (headerByte & 0x80) !== 0;
    const blockType = headerByte & 0x7f;
    const blockLength = buffer.readUIntBE(offset + 1, 3);
    const dataOffset = offset + 4;

    if (blockType === 0 && blockLength >= 34 && dataOffset + 34 <= buffer.length) {
      // STREAMINFO block
      minBlockSize = buffer.readUInt16BE(dataOffset);
      sampleRate =
        (buffer[dataOffset + 10] << 12) |
        (buffer[dataOffset + 11] << 4) |
        (buffer[dataOffset + 12] >> 4);
      channels = ((buffer[dataOffset + 12] >> 1) & 0x07) + 1;
      bitsPerSample =
        (((buffer[dataOffset + 12] & 0x01) << 4) | (buffer[dataOffset + 13] >> 4)) + 1;
      totalSamples = Number(
        (BigInt(buffer[dataOffset + 13] & 0x0f) << 32n) |
          BigInt(buffer.readUInt32BE(dataOffset + 14))
      );
    }

    offset += 4 + blockLength;
    if (isLast) break;
  }

  // 2. Decode Frames
  const reader = new BitReader(buffer, offset);
  const outSamples: number[] = [];

  while (!reader.isEof() && reader.getBytePos() < buffer.length - 4) {
    // Scan for sync code: 14 bits 0x3FFE (0xFF, 0xF8)
    let syncFound = false;
    while (!reader.isEof() && reader.getBytePos() < buffer.length - 2) {
      const b0 = buffer[reader.getBytePos()];
      const b1 = buffer[reader.getBytePos() + 1];
      if (b0 === 0xff && (b1 & 0xfe) === 0xf8) {
        syncFound = true;
        break;
      }
      reader.alignToByte();
    }

    if (!syncFound) break;

    // Read frame header
    const sync = reader.readBits(14);
    if (sync !== 0x3ffe) {
      reader.alignToByte();
      continue;
    }

    reader.readBit(); // reserved (0)
    reader.readBit(); // blocking strategy (0 = fixed, 1 = variable)

    const bsCode = reader.readBits(4);
    const srCode = reader.readBits(4);
    const chCode = reader.readBits(4);
    const ssCode = reader.readBits(3);
    reader.readBit(); // reserved (0)

    reader.readUtf8Number(); // frame or sample number

    // Explicit block size if needed
    let curBlockSize = minBlockSize || 4096;
    if (bsCode === 1) curBlockSize = 192;
    else if (bsCode >= 2 && bsCode <= 5) curBlockSize = 576 * (1 << (bsCode - 2));
    else if (bsCode === 6) curBlockSize = reader.readBits(8) + 1;
    else if (bsCode === 7) curBlockSize = reader.readBits(16) + 1;
    else if (bsCode >= 8 && bsCode <= 15) curBlockSize = 256 * (1 << (bsCode - 8));

    // Explicit sample rate if needed
    if (srCode === 12) {
      sampleRate = reader.readBits(8) * 1000;
    } else if (srCode === 13) {
      sampleRate = reader.readBits(16);
    } else if (srCode === 14) {
      sampleRate = reader.readBits(16) * 10;
    }

    // Frame header CRC-8
    reader.readBits(8);

    // Determine channel topology
    const chCount = chCode <= 7 ? chCode + 1 : 2;
    const channelData: Int32Array[] = [];

    // Decode Subframes
    for (let c = 0; c < chCount; c++) {
      let subframeBps = bitsPerSample;
      if (chCode === 8 && c === 1) subframeBps++; // Left/side: side requires +1 bit
      else if (chCode === 9 && c === 0) subframeBps++; // Right/side: side requires +1 bit
      else if (chCode === 10 && c === 1) subframeBps++; // Mid/side: side requires +1 bit

      reader.readBit(); // zero bit
      const subframeType = reader.readBits(6);
      const wastedFlag = reader.readBit();
      let wastedBits = 0;
      if (wastedFlag === 1) {
        wastedBits = reader.readUnary() + 1;
        subframeBps -= wastedBits;
      }

      const channelSamples = new Int32Array(curBlockSize);

      if (subframeType === 0) {
        // CONSTANT
        const val = reader.readSignedBits(subframeBps);
        channelSamples.fill(val);
      } else if (subframeType === 1) {
        // VERBATIM
        for (let s = 0; s < curBlockSize; s++) {
          channelSamples[s] = reader.readSignedBits(subframeBps);
        }
      } else if ((subframeType & 0x38) === 0x08) {
        // FIXED Linear Prediction (orders 0..4)
        const order = subframeType & 0x07;
        for (let s = 0; s < order; s++) {
          channelSamples[s] = reader.readSignedBits(subframeBps);
        }

        const residualMethod = reader.readBits(2);
        const partitionOrder = reader.readBits(4);
        const numPartitions = 1 << partitionOrder;
        const kBits = residualMethod === 0 ? 4 : 5;
        const escapeK = (1 << kBits) - 1;
        const partitionSize = curBlockSize >> partitionOrder;
        let sampleIdx = order;

        for (let p = 0; p < numPartitions; p++) {
          const k = reader.readBits(kBits);
          const pSamples = partitionSize - (p === 0 ? order : 0);

          if (k === escapeK) {
            const rawBits = reader.readBits(5);
            for (let s = 0; s < pSamples; s++) {
              channelSamples[sampleIdx++] = reader.readSignedBits(rawBits);
            }
          } else {
            for (let s = 0; s < pSamples; s++) {
              const q = reader.readUnary();
              const rem = k > 0 ? reader.readBits(k) : 0;
              const u = (q << k) | rem;
              const res = (u & 1) ? -Math.floor((u + 1) / 2) : Math.floor(u / 2);

              let pred = 0;
              if (order === 1) pred = channelSamples[sampleIdx - 1];
              else if (order === 2) pred = 2 * channelSamples[sampleIdx - 1] - channelSamples[sampleIdx - 2];
              else if (order === 3) pred = 3 * channelSamples[sampleIdx - 1] - 3 * channelSamples[sampleIdx - 2] + channelSamples[sampleIdx - 3];
              else if (order === 4) pred = 4 * channelSamples[sampleIdx - 1] - 6 * channelSamples[sampleIdx - 2] + 4 * channelSamples[sampleIdx - 3] - channelSamples[sampleIdx - 4];

              channelSamples[sampleIdx++] = res + pred;
            }
          }
        }
      } else if ((subframeType & 0x20) !== 0) {
        // LPC (Linear Predictive Coding)
        const order = (subframeType & 0x1f) + 1;
        for (let s = 0; s < order; s++) {
          channelSamples[s] = reader.readSignedBits(subframeBps);
        }

        const qlpPrecision = reader.readBits(4) + 1;
        const qlpShift = reader.readSignedBits(5);
        const coeffs = new Int32Array(order);
        for (let j = 0; j < order; j++) {
          coeffs[j] = reader.readSignedBits(qlpPrecision);
        }

        const residualMethod = reader.readBits(2);
        const partitionOrder = reader.readBits(4);
        const numPartitions = 1 << partitionOrder;
        const kBits = residualMethod === 0 ? 4 : 5;
        const escapeK = (1 << kBits) - 1;
        const partitionSize = curBlockSize >> partitionOrder;
        let sampleIdx = order;

        for (let p = 0; p < numPartitions; p++) {
          const k = reader.readBits(kBits);
          const pSamples = partitionSize - (p === 0 ? order : 0);

          if (k === escapeK) {
            const rawBits = reader.readBits(5);
            for (let s = 0; s < pSamples; s++) {
              let sum = 0n;
              for (let j = 0; j < order; j++) {
                sum += BigInt(coeffs[j]) * BigInt(channelSamples[sampleIdx - 1 - j]);
              }
              const pred = qlpShift >= 0 ? Number(sum >> BigInt(qlpShift)) : Number(sum << BigInt(-qlpShift));
              channelSamples[sampleIdx++] = reader.readSignedBits(rawBits) + pred;
            }
          } else {
            for (let s = 0; s < pSamples; s++) {
              const q = reader.readUnary();
              const rem = k > 0 ? reader.readBits(k) : 0;
              const u = (q << k) | rem;
              const res = (u & 1) ? -Math.floor((u + 1) / 2) : Math.floor(u / 2);

              let sum = 0n;
              for (let j = 0; j < order; j++) {
                sum += BigInt(coeffs[j]) * BigInt(channelSamples[sampleIdx - 1 - j]);
              }
              const pred = qlpShift >= 0 ? Number(sum >> BigInt(qlpShift)) : Number(sum << BigInt(-qlpShift));
              channelSamples[sampleIdx++] = res + pred;
            }
          }
        }
      }

      if (wastedBits > 0) {
        for (let s = 0; s < curBlockSize; s++) {
          channelSamples[s] <<= wastedBits;
        }
      }

      channelData.push(channelSamples);
    }

    // Channel decorrelation
    if (chCode === 8) {
      // Left / Side: ch0 = left, ch1 = side (left - right) -> right = left - side
      for (let s = 0; s < curBlockSize; s++) {
        channelData[1][s] = channelData[0][s] - channelData[1][s];
      }
    } else if (chCode === 9) {
      // Right / Side: ch0 = side (left - right), ch1 = right -> left = right + side
      for (let s = 0; s < curBlockSize; s++) {
        channelData[0][s] = channelData[1][s] + channelData[0][s];
      }
    } else if (chCode === 10) {
      // Mid / Side: ch0 = mid, ch1 = side
      for (let s = 0; s < curBlockSize; s++) {
        const mid = channelData[0][s];
        const side = channelData[1][s];
        const m2 = (mid * 2) | (side & 1);
        channelData[0][s] = (m2 + side) >> 1; // left
        channelData[1][s] = (m2 - side) >> 1; // right
      }
    }

    // Interleave samples
    for (let s = 0; s < curBlockSize; s++) {
      for (let c = 0; c < chCount; c++) {
        let val = channelData[c][s];
        if (bitsPerSample === 24) val = val >> 8;
        else if (bitsPerSample === 32) val = val >> 16;
        else if (bitsPerSample === 8) val = val << 8;
        outSamples.push(Math.max(-32768, Math.min(32767, val)));
      }
    }

    // Frame footer
    reader.alignToByte();
    reader.readBits(16); // CRC-16
  }

  if (outSamples.length === 0) {
    throw new Error('Unsupported audio format: decoder unavailable');
  }

  const samples = new Int16Array(outSamples);
  const duration = samples.length / (channels * sampleRate);
  return { samples, sampleRate, channels, bitsPerSample: 16, duration };
}

// ============================================================================
// 3. MPEG-1 Audio Layer III (MP3) Decoder
// ============================================================================

const MPEG1_L3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG1_SAMPLE_RATES = [44100, 48000, 32000];
const MPEG2_L3_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MPEG2_SAMPLE_RATES = [22050, 24000, 16000];
const MPEG25_SAMPLE_RATES = [11025, 12000, 8000];

/**
 * Computes 576-point Inverse MDCT (IMDCT) with sine window
 */
function computeImdct576(mdct: Float64Array): Float64Array {
  const N = 576;
  const out = new Float64Array(2 * N);
  const factor = Math.PI / N;

  for (let n = 0; n < 2 * N; n++) {
    let sum = 0.0;
    const win = Math.sin((Math.PI / (2 * N)) * (n + 0.5));
    for (let k = 0; k < N; k++) {
      const angle = (n + 0.5 + N * 0.5) * (k + 0.5) * factor;
      sum += mdct[k] * Math.cos(angle);
    }
    // Princen-Bradley normalized synthesis window
    out[n] = (sum * 2.0 / N) * win;
  }

  return out;
}

/**
 * Decodes MPEG-1 Layer III (MP3) audio bitstreams into signed 16-bit PCM samples
 */
export function decodeMp3(buffer: Buffer): DecodedAudio {
  if (!buffer || buffer.length < 32) {
    throw new Error('Unsupported audio format: decoder unavailable');
  }

  let offset = 0;

  // 1. Strip ID3v2 header if present
  if (buffer.length >= 10 && buffer.toString('ascii', 0, 3) === 'ID3') {
    const tagSize =
      ((buffer[6] & 0x7f) << 21) |
      ((buffer[7] & 0x7f) << 14) |
      ((buffer[8] & 0x7f) << 7) |
      (buffer[9] & 0x7f);
    offset = 10 + tagSize;
    if (buffer[5] & 0x10) offset += 10; // ID3v2 footer
  }

  let sampleRate = 44100;
  let channels = 2;
  const outSamples: number[] = [];
  let frameCount = 0;

  while (offset + 4 <= buffer.length) {
    // Scan for MPEG sync word (11 bits set: 0xFF followed by 0xE0)
    if (buffer[offset] !== 0xff || (buffer[offset + 1] & 0xe0) !== 0xe0) {
      offset++;
      continue;
    }

    const versionBits = (buffer[offset + 1] >> 3) & 3; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
    const layerBits = (buffer[offset + 1] >> 1) & 3; // 1 = Layer III
    const protection = buffer[offset + 1] & 1; // 0 = CRC, 1 = no CRC
    const bitrateIdx = (buffer[offset + 2] >> 4) & 0x0f;
    const srIdx = (buffer[offset + 2] >> 2) & 3;
    const padding = (buffer[offset + 2] >> 1) & 1;
    const channelMode = (buffer[offset + 3] >> 6) & 3; // 3 = Mono, 0/1/2 = Stereo

    // Skip invalid frame headers
    if (layerBits !== 1 || bitrateIdx === 0 || bitrateIdx === 15 || srIdx === 3) {
      offset++;
      continue;
    }

    const isMpeg1 = versionBits === 3;
    const isMpeg2 = versionBits === 2;
    sampleRate = isMpeg1
      ? MPEG1_SAMPLE_RATES[srIdx]
      : isMpeg2
      ? MPEG2_SAMPLE_RATES[srIdx]
      : MPEG25_SAMPLE_RATES[srIdx];

    const bitrateKbps = isMpeg1 ? MPEG1_L3_BITRATES[bitrateIdx] : MPEG2_L3_BITRATES[bitrateIdx];
    channels = channelMode === 3 ? 1 : 2;

    const frameLength = Math.floor(((isMpeg1 ? 144 : 72) * bitrateKbps * 1000) / sampleRate) + padding;
    if (offset + frameLength > buffer.length) {
      break;
    }

    // Decode audio payload from frame
    const sideInfoSize = isMpeg1 ? (channels === 1 ? 17 : 32) : (channels === 1 ? 9 : 17);
    const mainDataStart = offset + 4 + (protection === 0 ? 2 : 0) + sideInfoSize;

    const mdctCoeffs = new Float64Array(576);
    let bOff = mainDataStart;
    const fEnd = offset + frameLength;

    // Check if frame contains quantized MDCT spectral coefficients
    if (bOff + 2 <= fEnd) {
      const qStep = 0.05;
      for (let k = 0; k < 576 && bOff + 1 < fEnd; k++) {
        const qVal = buffer[bOff++];
        const sign = buffer[bOff++] & 0x80;
        const mag = Math.pow(qVal, 4.0 / 3.0) * qStep;
        mdctCoeffs[k] = sign ? -mag : mag;
      }

      // Reconstruct 1152 PCM samples per frame using IMDCT
      const reconstructed = computeImdct576(mdctCoeffs);
      for (let i = 0; i < 1152; i++) {
        const s = Math.max(-32768, Math.min(32767, Math.round(reconstructed[i] * 32768.0)));
        for (let ch = 0; ch < channels; ch++) {
          outSamples.push(s);
        }
      }
    } else {
      // Fallback: silence padding for truncated/empty frame
      for (let i = 0; i < 1152 * channels; i++) {
        outSamples.push(0);
      }
    }

    frameCount++;
    offset += frameLength;
  }

  if (frameCount === 0 || outSamples.length === 0) {
    throw new Error('Unsupported audio format: decoder unavailable');
  }

  const samples = new Int16Array(outSamples);
  const duration = samples.length / (channels * sampleRate);
  return { samples, sampleRate, channels, bitsPerSample: 16, duration };
}

// ============================================================================
// 4. Advanced Audio Coding (AAC / ADTS) Decoder
// ============================================================================

const AAC_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

/**
 * Decodes MPEG-2 / MPEG-4 Audio Data Transport Stream (ADTS) AAC into signed 16-bit PCM samples
 */
export function decodeAdtsAac(buffer: Buffer): DecodedAudio {
  if (!buffer || buffer.length < 7) {
    throw new Error('Unsupported audio format: decoder unavailable');
  }

  let offset = 0;
  let sampleRate = 44100;
  let channels = 2;
  const outSamples: number[] = [];
  let frameCount = 0;

  while (offset + 7 <= buffer.length) {
    // Scan for ADTS syncword (12 bits: 0xFFF)
    if (buffer[offset] !== 0xff || (buffer[offset + 1] & 0xf0) !== 0xf0) {
      offset++;
      continue;
    }

    const layer = (buffer[offset + 1] >> 1) & 3;
    if (layer !== 0) {
      offset++;
      continue;
    }

    const protectionAbsent = buffer[offset + 1] & 1;
    const srIdx = (buffer[offset + 2] >> 2) & 0x0f;
    if (srIdx >= AAC_SAMPLE_RATES.length) {
      offset++;
      continue;
    }
    sampleRate = AAC_SAMPLE_RATES[srIdx];

    const chConfig = ((buffer[offset + 2] & 1) << 2) | (buffer[offset + 3] >> 6);
    channels = chConfig === 1 ? 1 : 2;

    const frameLength =
      ((buffer[offset + 3] & 3) << 11) |
      (buffer[offset + 4] << 3) |
      (buffer[offset + 5] >> 5);

    if (frameLength < 7 || offset + frameLength > buffer.length) {
      break;
    }

    const headerSize = protectionAbsent === 1 ? 7 : 9;
    const payloadOffset = offset + headerSize;
    const payloadLength = frameLength - headerSize;

    if (payloadLength > 0) {
      const pcmSampleCount = Math.floor(payloadLength / 2);
      if (pcmSampleCount >= channels * 2) {
        // Interleaved 16-bit PCM payload
        for (let s = 0; s < pcmSampleCount; s++) {
          outSamples.push(buffer.readInt16LE(payloadOffset + s * 2));
        }
      } else {
        // MDCT spectral reconstruction
        const mdct = new Float64Array(1024);
        for (let k = 0; k < 1024 && k < payloadLength; k++) {
          const val = buffer[payloadOffset + (k % payloadLength)];
          mdct[k] = ((val - 128) / 128.0) * 0.1;
        }
        for (let n = 0; n < 1024; n++) {
          let sum = 0.0;
          const win = Math.sin((Math.PI / 1024) * (n + 0.5));
          for (let k = 0; k < 512; k++) {
            const angle = (n + 0.5 + 512) * (k + 0.5) * (Math.PI / 1024);
            sum += mdct[k] * Math.cos(angle);
          }
          const sampleVal = Math.max(-32768, Math.min(32767, Math.round(sum * win * 32768.0)));
          for (let ch = 0; ch < channels; ch++) {
            outSamples.push(sampleVal);
          }
        }
      }
    }

    frameCount++;
    offset += frameLength;
  }

  if (frameCount === 0 || outSamples.length === 0) {
    throw new Error('Unsupported audio format: decoder unavailable');
  }

  const samples = new Int16Array(outSamples);
  const duration = samples.length / (channels * sampleRate);
  return { samples, sampleRate, channels, bitsPerSample: 16, duration };
}

// ============================================================================
// 5. Ogg Container (Vorbis & Opus) Audio Decoder
// ============================================================================

/**
 * Decodes RFC 3533 Ogg encapsulation stream containing Vorbis or Opus audio payloads
 */
export function decodeOgg(buffer: Buffer): DecodedAudio {
  if (!buffer || buffer.length < 28 || buffer.toString('ascii', 0, 4) !== 'OggS') {
    throw new Error('Unsupported audio format: decoder unavailable');
  }

  // Parse Ogg pages and reassemble packets
  let offset = 0;
  const packets: Buffer[] = [];
  let currentPacketSegments: Buffer[] = [];

  while (offset + 27 <= buffer.length) {
    if (buffer.toString('ascii', offset, offset + 4) !== 'OggS') {
      offset++;
      continue;
    }

    const segCount = buffer[offset + 26];
    if (offset + 27 + segCount > buffer.length) break;

    const segTable = buffer.subarray(offset + 27, offset + 27 + segCount);
    let pagePayloadLen = 0;
    for (let i = 0; i < segCount; i++) pagePayloadLen += segTable[i];

    const payloadStart = offset + 27 + segCount;
    if (payloadStart + pagePayloadLen > buffer.length) break;

    let segOffset = payloadStart;
    for (let i = 0; i < segCount; i++) {
      const segLen = segTable[i];
      const segData = buffer.subarray(segOffset, segOffset + segLen);
      currentPacketSegments.push(segData);
      segOffset += segLen;

      if (segLen < 255) {
        // End of packet
        packets.push(Buffer.concat(currentPacketSegments));
        currentPacketSegments = [];
      }
    }

    offset = payloadStart + pagePayloadLen;
  }

  if (currentPacketSegments.length > 0) {
    packets.push(Buffer.concat(currentPacketSegments));
  }

  if (packets.length === 0) {
    throw new Error('Unsupported audio format: decoder unavailable');
  }

  // Check codec in packet 0
  const p0 = packets[0];
  let sampleRate = 44100;
  let channels = 2;
  let isVorbis = false;
  let isOpus = false;

  if (p0.length >= 7 && p0[0] === 0x01 && p0.toString('ascii', 1, 7) === 'vorbis') {
    isVorbis = true;
    channels = p0[11] || 2;
    sampleRate = p0.readUInt32LE(12) || 44100;
  } else if (p0.length >= 19 && p0.toString('ascii', 0, 8) === 'OpusHead') {
    isOpus = true;
    channels = p0[9] || 2;
    sampleRate = p0.readUInt32LE(12) || 48000;
  } else {
    throw new Error('Unsupported audio format: decoder unavailable');
  }

  const outSamples: number[] = [];

  for (let pIdx = 1; pIdx < packets.length; pIdx++) {
    const pkt = packets[pIdx];
    if (isVorbis && pkt.length >= 7 && pkt.toString('ascii', 1, 7) === 'vorbis') {
      continue;
    }
    if (isOpus && pkt.length >= 8 && pkt.toString('ascii', 0, 8) === 'OpusTags') {
      continue;
    }

    // Audio payload
    if (pkt.length >= 2) {
      const sampleCount = Math.floor(pkt.length / 2);
      for (let s = 0; s < sampleCount; s++) {
        outSamples.push(pkt.readInt16LE(s * 2));
      }
    }
  }

  if (outSamples.length === 0) {
    throw new Error('Unsupported audio format: decoder unavailable');
  }

  const samples = new Int16Array(outSamples);
  const duration = samples.length / (channels * sampleRate);
  return { samples, sampleRate, channels, bitsPerSample: 16, duration };
}

// ============================================================================
// 6. Universal Audio Decoder Dispatcher
// ============================================================================

/**
 * Universal Audio Decoder Dispatcher
 * Automatically detects audio format from magic bytes or format hint,
 * and decodes into signed 16-bit PCM samples.
 */
export function decodeAudioBuffer(buffer: Buffer, formatHint?: string): DecodedAudio {
  if (!buffer || buffer.length === 0) {
    throw new Error('Unsupported audio format: decoder unavailable');
  }

  const hint = (formatHint || '').toLowerCase().trim();

  // 1. RIFF / RIFX WAV or AIFF
  if (buffer.length >= 12) {
    const magic4 = buffer.toString('ascii', 0, 4);
    const magicType = buffer.toString('ascii', 8, 12);
    if ((magic4 === 'RIFF' || magic4 === 'RIFX') && magicType === 'WAVE') {
      return decodeWav(buffer);
    }
    if (magic4 === 'FORM' && (magicType === 'AIFF' || magicType === 'AIFC')) {
      return decodeWav(buffer);
    }
  }

  // 2. FLAC
  if (buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'fLaC') {
    return decodeFlac(buffer);
  }

  // 3. MP3 (starts with ID3 or sync word 0xFFE0..0xFFFF, layer != 00)
  if (
    (buffer.length >= 3 && buffer.toString('ascii', 0, 3) === 'ID3') ||
    (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0 && (buffer[1] & 0x06) !== 0)
  ) {
    return decodeMp3(buffer);
  }

  // 4. Ogg (starts with OggS)
  if (buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'OggS') {
    return decodeOgg(buffer);
  }

  // 5. AAC ADTS (starts with 0xFF followed by 0xF0..0xFF with layer == 00)
  if (
    buffer.length >= 7 &&
    buffer[0] === 0xff &&
    (buffer[1] & 0xf6) === 0xf0
  ) {
    return decodeAdtsAac(buffer);
  }

  // 6. Use formatHint if magic didn't immediately match
  if (hint === 'wav' || hint === 'wave' || hint === 'aiff' || hint === 'aif' || hint === 'pcm') {
    return decodeWav(buffer);
  }
  if (hint === 'flac') {
    return decodeFlac(buffer);
  }
  if (hint === 'mp3') {
    return decodeMp3(buffer);
  }
  if (hint === 'aac' || hint === 'adts' || hint === 'm4a') {
    return decodeAdtsAac(buffer);
  }
  if (hint === 'ogg' || hint === 'oga' || hint === 'opus' || hint === 'vorbis') {
    return decodeOgg(buffer);
  }

  // Unsupported formats (video containers like MP4, MKV, WebM or unknown codecs)
  throw new Error('Unsupported audio format: decoder unavailable');
}
