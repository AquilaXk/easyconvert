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
 *
 * MP3, AAC and Ogg (Vorbis, Opus) have no in-process decoder: a source in one of them is refused with
 * EngineUnavailableError('ffmpeg'), which the API answers with HTTP 503.
 */

import { ConversionFailedError, EngineUnavailableError } from '../types';

export interface DecodedAudio {
  samples: Int16Array;
  sampleRate: number;
  channels: number;
  /** Depth of `samples` (always 16). The source depth is `sourceBitsPerSample`. */
  bitsPerSample: number;
  duration: number;
  /**
   * Sample depth of the source stream when the decoder had to reduce it to 16-bit integers
   * (lossless PCM and FLAC only). Absent for lossy sources, which decode to 16-bit natively.
   */
  sourceBitsPerSample?: number;
  /** Sample representation of the source stream; set together with `sourceBitsPerSample`. */
  sourceSampleFormat?: 'int' | 'float';
}

const UNSUPPORTED_AUDIO_MESSAGE = 'Unsupported audio format: decoder unavailable';

/**
 * Refuses a layout before any sample is decoded: no channel or no sample rate is a broken file; more channels than stereo is a
 * file the in-process path cannot reproduce, refused as media.ts refuses it after a decode, with the engine it needs, so the
 * job goes to the native engine and no time or memory is spent on samples first.
 */
function assertDecodableLayout(channels: number, sampleRate: number): void {
  if (!Number.isInteger(channels) || channels < 1 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new ConversionFailedError(UNSUPPORTED_AUDIO_MESSAGE);
  }
  if (channels > MAX_PURE_CHANNELS) {
    throw new EngineUnavailableError(
      'ffmpeg',
      `Native FFmpeg engine is required to convert ${channels}-channel audio; the in-process engine reproduces only mono and stereo faithfully (Fail-Closed).`
    );
  }
}
/** The most channels the in-process decoders return; the targets that follow write mono or stereo only. */
const MAX_PURE_CHANNELS = 2;
/**
 * The most samples (all channels) one in-process decode may produce: 64 Mi samples, 128 MiB as 16-bit, about 12 minutes of
 * 48 kHz stereo. A FLAC frame of constant subframes is 30 bytes for 32,768 samples a channel, so without this budget a small
 * file would expand into gigabytes before the channel check that follows the decode.
 */
export const MAX_PURE_DECODED_SAMPLES = 64 * 1024 * 1024;
const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;

// ============================================================================
// BitReader Helper for FLAC Bitstream Parsing
// ============================================================================

export class BitReader {
  private buf: Buffer;
  private bytePos: number;
  private bitBuf: number;
  private bitCount: number;

  constructor(buf: Buffer, startOffset = 0) {
    this.buf = buf;
    this.bytePos = Math.max(0, startOffset);
    this.bitBuf = 0;
    this.bitCount = 0;
  }

  private fill(): void {
    while (this.bitCount <= 24 && this.bytePos < this.buf.length) {
      this.bitBuf = (this.bitBuf | (this.buf[this.bytePos++] << (24 - this.bitCount))) >>> 0;
      this.bitCount += 8;
    }
  }

  readBit(): number {
    if (this.bitCount === 0) this.fill();
    if (this.bitCount === 0) {
      throw new ConversionFailedError(UNSUPPORTED_AUDIO_MESSAGE);
    }
    const bit = this.bitBuf >>> 31;
    this.bitBuf = (this.bitBuf << 1) >>> 0;
    this.bitCount--;
    return bit;
  }

  readBits(count: number): number {
    if (count === 0) return 0;
    if (count < 0 || count > 32) {
      throw new ConversionFailedError(UNSUPPORTED_AUDIO_MESSAGE);
    }
    if (count > 24) {
      const hi = this.readBits(16);
      const loBits = count - 16;
      const lo = this.readBits(loBits);
      return ((hi << loBits) | lo) >>> 0;
    }
    if (this.bitCount < count) this.fill();
    if (this.bitCount < count) {
      throw new ConversionFailedError(UNSUPPORTED_AUDIO_MESSAGE);
    }
    const val = this.bitBuf >>> (32 - count);
    this.bitBuf = (this.bitBuf << count) >>> 0;
    this.bitCount -= count;
    return val;
  }

  readSignedBits(count: number): number {
    if (count <= 0) return 0;
    if (count <= 31) {
      const val = this.readBits(count);
      const shift = 32 - count;
      return (val << shift) >> shift;
    }
    if (count === 32) {
      return this.readBits(32) | 0;
    }
    if (count > 53) {
      throw new ConversionFailedError(UNSUPPORTED_AUDIO_MESSAGE);
    }
    const hiSigned = this.readSignedBits(count - 32);
    const lo = this.readBits(32);
    return hiSigned * 0x100000000 + lo;
  }

  readUnaryZeroes(maxQ = 0x7fffffff): number {
    let zeroes = 0;
    while (true) {
      if (this.bitCount === 0) this.fill();
      if (this.bitCount === 0) {
        throw new ConversionFailedError(UNSUPPORTED_AUDIO_MESSAGE);
      }
      const lz = Math.clz32(this.bitBuf);
      if (lz < this.bitCount) {
        zeroes += lz;
        if (zeroes > maxQ) {
          throw new ConversionFailedError(UNSUPPORTED_AUDIO_MESSAGE);
        }
        const consume = lz + 1;
        this.bitBuf = consume === 32 ? 0 : (this.bitBuf << consume) >>> 0;
        this.bitCount -= consume;
        return zeroes;
      }
      zeroes += this.bitCount;
      if (zeroes > maxQ) {
        throw new ConversionFailedError(UNSUPPORTED_AUDIO_MESSAGE);
      }
      this.bitBuf = 0;
      this.bitCount = 0;
    }
  }

  readUnary(): number {
    return this.readUnaryZeroes();
  }

  readUtf8Number(): number {
    const b0 = this.readBits(8);
    if ((b0 & 0x80) === 0) return b0;
    let mask = 0x40;
    let numBytes = 1;
    while ((b0 & mask) !== 0) {
      numBytes++;
      mask >>= 1;
      if (numBytes > 7 || mask === 0) {
        throw new ConversionFailedError(UNSUPPORTED_AUDIO_MESSAGE);
      }
    }
    let val = b0 & (mask - 1);
    for (let i = 1; i < numBytes; i++) {
      const b = this.readBits(8);
      val = val * 64 + (b & 0x3f);
    }
    return val;
  }

  alignToByte(): void {
    const rem = this.bitCount & 7;
    if (rem !== 0) {
      this.bitBuf = (this.bitBuf << rem) >>> 0;
      this.bitCount -= rem;
    }
  }

  getBytePos(): number {
    return this.bytePos - ((this.bitCount + 7) >> 3);
  }

  isEof(): boolean {
    return this.bytePos >= this.buf.length && this.bitCount === 0;
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
function decodeAiffContainer(buffer: Buffer): DecodedAudio {
  if (buffer.length < 12) {
    throw new ConversionFailedError(UNSUPPORTED_AUDIO_MESSAGE);
  }
  const formType = buffer.toString('ascii', 8, 12);
  if (formType !== 'AIFF' && formType !== 'AIFC') {
    throw new ConversionFailedError(UNSUPPORTED_AUDIO_MESSAGE);
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
    const paddedSize = chunkSize + (chunkSize & 1);
    const nextOffset = offset + 8 + paddedSize;

    if (chunkId === 'COMM' && offset + 26 <= buffer.length) {
      channels = buffer.readInt16BE(offset + 8);
      bitsPerSample = buffer.readInt16BE(offset + 14);
      sampleRate = Math.round(readExtendedFloat(buffer, offset + 16)) || 44100;
    } else if (chunkId === 'SSND' && offset + 16 <= buffer.length) {
      const soundOffset = buffer.readUInt32BE(offset + 8);
      dataOffset = offset + 16 + soundOffset;
      dataSize = Math.max(0, Math.min(chunkSize - 8 - soundOffset, buffer.length - dataOffset));
    }

    if (nextOffset > buffer.length || nextOffset <= offset) break;
    offset = nextOffset;
  }

  if (dataOffset < 0) {
    throw new ConversionFailedError(UNSUPPORTED_AUDIO_MESSAGE);
  }

  assertDecodableLayout(channels, sampleRate);
  const samples = decodePcmBytes(buffer, dataOffset, dataSize, bitsPerSample, true, WAVE_FORMAT_PCM);
  const duration = samples.length / (channels * sampleRate);
  return {
    samples,
    sampleRate,
    channels,
    bitsPerSample: 16,
    duration,
    sourceBitsPerSample: bitsPerSample,
    sourceSampleFormat: 'int',
  };
}

function decodeRiffWavContainer(buffer: Buffer, isRifx: boolean): DecodedAudio {
  if (buffer.length < 12 || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new ConversionFailedError(UNSUPPORTED_AUDIO_MESSAGE);
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
    const paddedSize = chunkSize + (chunkSize & 1);
    const nextOffset = offset + 8 + paddedSize;

    if (chunkId === 'fmt ' && offset + 24 <= buffer.length) {
      audioFormat = isRifx ? buffer.readUInt16BE(offset + 8) : buffer.readUInt16LE(offset + 8);
      channels = isRifx ? buffer.readUInt16BE(offset + 10) : buffer.readUInt16LE(offset + 10);
      sampleRate = isRifx ? buffer.readUInt32BE(offset + 12) : buffer.readUInt32LE(offset + 12);
      bitsPerSample = isRifx ? buffer.readUInt16BE(offset + 22) : buffer.readUInt16LE(offset + 22);

      // WAVE_FORMAT_EXTENSIBLE (0xFFFE)
      if (audioFormat === 0xfffe && offset + 40 <= buffer.length) {
        audioFormat = isRifx ? buffer.readUInt16BE(offset + 32) : buffer.readUInt16LE(offset + 32);
      }
    } else if (chunkId === 'data') {
      dataOffset = offset + 8;
      dataSize = Math.max(0, Math.min(chunkSize, buffer.length - dataOffset));
      break;
    }

    if (nextOffset > buffer.length || nextOffset <= offset) break;
    offset = nextOffset;
  }

  if (dataOffset < 0) {
    throw new ConversionFailedError(UNSUPPORTED_AUDIO_MESSAGE);
  }

  assertDecodableLayout(channels, sampleRate);
  const samples = decodePcmBytes(buffer, dataOffset, dataSize, bitsPerSample, isRifx, audioFormat);
  const duration = samples.length / (channels * sampleRate);
  return {
    samples,
    sampleRate,
    channels,
    bitsPerSample: 16,
    duration,
    sourceBitsPerSample: bitsPerSample,
    sourceSampleFormat: audioFormat === WAVE_FORMAT_IEEE_FLOAT ? 'float' : 'int',
  };
}

export function decodeWav(buffer: Buffer): DecodedAudio {
  if (!buffer || buffer.length < 12) {
    throw new ConversionFailedError(UNSUPPORTED_AUDIO_MESSAGE);
  }

  const magic = buffer.toString('ascii', 0, 4);
  if (magic === 'FORM') {
    return decodeAiffContainer(buffer);
  }

  const isRiff = magic === 'RIFF';
  const isRifx = magic === 'RIFX';
  if (!isRiff && !isRifx) {
    throw new ConversionFailedError(UNSUPPORTED_AUDIO_MESSAGE);
  }

  return decodeRiffWavContainer(buffer, isRifx);
}

function allocPcmSamples(count: number): Int16Array {
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_PURE_DECODED_SAMPLES) {
    throw new ConversionFailedError(
      `${UNSUPPORTED_AUDIO_MESSAGE}: PCM sample count ${count} exceeds ${MAX_PURE_DECODED_SAMPLES}`
    );
  }
  return new Int16Array(count);
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
  // A-law, mu-law, ADPCM and other tagged encodings are not linear PCM; reading them as such is noise.
  const isFloat = audioFormat === WAVE_FORMAT_IEEE_FLOAT;
  if (audioFormat !== WAVE_FORMAT_PCM && !isFloat) {
    throw new ConversionFailedError(`Unsupported WAV format tag ${audioFormat}: only linear PCM and IEEE float decode.`);
  }
  if (isFloat && bitsPerSample !== 32 && bitsPerSample !== 64) {
    throw new ConversionFailedError(`Unsupported IEEE float sample width: ${bitsPerSample}-bit.`);
  }

  if (bitsPerSample === 8) {
    const count = length;
    const samples = allocPcmSamples(count);
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
    const samples = allocPcmSamples(count);
    for (let i = 0; i < count; i++) {
      samples[i] = isBigEndian
        ? buffer.readInt16BE(offset + i * 2)
        : buffer.readInt16LE(offset + i * 2);
    }
    return samples;
  }

  if (bitsPerSample === 24) {
    const count = Math.floor(length / 3);
    const samples = allocPcmSamples(count);
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
    const samples = allocPcmSamples(count);
    if (audioFormat === WAVE_FORMAT_IEEE_FLOAT) {
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

  if (bitsPerSample === 64 && audioFormat === WAVE_FORMAT_IEEE_FLOAT) {
    const count = Math.floor(length / 8);
    const samples = allocPcmSamples(count);
    for (let i = 0; i < count; i++) {
      const pos = offset + i * 8;
      const f = isBigEndian ? buffer.readDoubleBE(pos) : buffer.readDoubleLE(pos);
      samples[i] = Math.max(-32768, Math.min(32767, Math.round(f * 32767)));
    }
    return samples;
  }

  // Any other depth would be read as garbage; refuse rather than guess a layout.
  throw new ConversionFailedError(`Unsupported PCM sample layout: ${bitsPerSample}-bit (format tag ${audioFormat}).`);
}

// ============================================================================
// 2. RFC 9639 FLAC Audio Decoder
// ============================================================================

/**
 * Decodes RFC 9639 compliant FLAC audio bitstreams into signed 16-bit PCM samples
 */
/**
 * Moves `reader` to the next FLAC frame sync code (0xFF, then 0xF8 or 0xF9), one byte at a time, and says whether one was
 * found before the end. alignToByte alone does not move a reader that is already on a byte boundary, which is where a frame
 * footer leaves it, so the scan steps a whole byte itself: otherwise padding or a tag after the last frame held it in place.
 */
function seekFrameSync(reader: BitReader, buffer: Buffer): boolean {
  while (!reader.isEof() && reader.getBytePos() < buffer.length - 2) {
    const b0 = buffer[reader.getBytePos()];
    const b1 = buffer[reader.getBytePos() + 1];
    if (b0 === 0xff && (b1 & 0xfe) === 0xf8) return true;
    const scannedAt = reader.getBytePos();
    reader.alignToByte();
    if (reader.getBytePos() === scannedAt) reader.readBits(8);
  }
  return false;
}

const MAX_RICE_UVAL = 0x1ffffffff;

type FlacSampleArray = Int32Array | Float64Array;

interface ResidualHeader {
  numPartitions: number;
  kBits: number;
  escapeK: number;
  partitionSize: number;
}

function readRiceResidual(reader: BitReader, k: number, kScale: number, maxQ: number): number {
  const q = reader.readUnaryZeroes(maxQ);
  const rem = k > 0 ? reader.readBits(k) : 0;
  const uval = k === 0 ? q : q * kScale + rem;
  if (uval > MAX_RICE_UVAL) {
    throw new ConversionFailedError(UNSUPPORTED_AUDIO_MESSAGE);
  }
  if (uval <= 0xffffffff) {
    return (uval >>> 1) ^ -(uval & 1);
  }
  return (uval & 1) ? -Math.floor((uval + 1) / 2) : uval / 2;
}

function parseResidualHeader(reader: BitReader, curBlockSize: number, order: number): ResidualHeader {
  const residualMethod = reader.readBits(2);
  if (residualMethod > 1) {
    throw new ConversionFailedError(UNSUPPORTED_AUDIO_MESSAGE);
  }
  const partitionOrder = reader.readBits(4);
  const numPartitions = 1 << partitionOrder;
  const partitionSize = curBlockSize >> partitionOrder;
  if (numPartitions > curBlockSize || (curBlockSize & (numPartitions - 1)) !== 0 || partitionSize < order) {
    throw new ConversionFailedError(UNSUPPORTED_AUDIO_MESSAGE);
  }
  const kBits = residualMethod === 0 ? 4 : 5;
  return {
    numPartitions,
    kBits,
    escapeK: (1 << kBits) - 1,
    partitionSize,
  };
}

function decodeFixedSubframe(
  reader: BitReader,
  channelSamples: FlacSampleArray,
  curBlockSize: number,
  subframeBps: number,
  order: number
): void {
  if (order > 4 || order > curBlockSize) {
    throw new ConversionFailedError(UNSUPPORTED_AUDIO_MESSAGE);
  }
  for (let s = 0; s < order; s++) {
    channelSamples[s] = reader.readSignedBits(subframeBps);
  }
  const { numPartitions, kBits, escapeK, partitionSize } = parseResidualHeader(reader, curBlockSize, order);
  let sampleIdx = order;

  for (let p = 0; p < numPartitions; p++) {
    const k = reader.readBits(kBits);
    const pSamples = partitionSize - (p === 0 ? order : 0);

    if (k === escapeK) {
      const rawBits = reader.readBits(5);
      for (let s = 0; s < pSamples; s++) {
        channelSamples[sampleIdx++] = rawBits > 0 ? reader.readSignedBits(rawBits) : 0;
      }
      continue;
    }

    const kScale = 1 << k;
    const maxQ = Math.floor(MAX_RICE_UVAL / kScale);
    for (let s = 0; s < pSamples; s++) {
      const res = readRiceResidual(reader, k, kScale, maxQ);
      let pred = 0;
      if (order === 1) pred = channelSamples[sampleIdx - 1];
      else if (order === 2) pred = 2 * channelSamples[sampleIdx - 1] - channelSamples[sampleIdx - 2];
      else if (order === 3) pred = 3 * channelSamples[sampleIdx - 1] - 3 * channelSamples[sampleIdx - 2] + channelSamples[sampleIdx - 3];
      else if (order === 4) pred = 4 * channelSamples[sampleIdx - 1] - 6 * channelSamples[sampleIdx - 2] + 4 * channelSamples[sampleIdx - 3] - channelSamples[sampleIdx - 4];
      channelSamples[sampleIdx++] = res + pred;
    }
  }
}

interface LpcParams {
  coeffs: Int32Array;
  order: number;
  qlpShift: number;
  shiftScale: number;
}

function decodeLpcPartitionFast(
  reader: BitReader,
  channelSamples: FlacSampleArray,
  startIdx: number,
  pSamples: number,
  k: number,
  lpc: LpcParams
): number {
  const { coeffs, order, shiftScale } = lpc;
  const kScale = 1 << k;
  const maxQ = Math.floor(MAX_RICE_UVAL / kScale);
  let sampleIdx = startIdx;
  for (let s = 0; s < pSamples; s++) {
    const res = readRiceResidual(reader, k, kScale, maxQ);
    let sum = 0;
    for (let j = 0; j < order; j++) {
      sum += coeffs[j] * channelSamples[sampleIdx - 1 - j];
    }
    const pred = Math.floor(sum / shiftScale);
    channelSamples[sampleIdx++] = res + pred;
  }
  return sampleIdx;
}

function decodeLpcPartitionBigInt(
  reader: BitReader,
  channelSamples: FlacSampleArray,
  startIdx: number,
  pSamples: number,
  k: number,
  lpc: LpcParams
): number {
  const { coeffs, order, qlpShift } = lpc;
  const kScale = 1 << k;
  const maxQ = Math.floor(MAX_RICE_UVAL / kScale);
  let sampleIdx = startIdx;
  for (let s = 0; s < pSamples; s++) {
    const res = readRiceResidual(reader, k, kScale, maxQ);
    let sum = 0n;
    for (let j = 0; j < order; j++) {
      sum += BigInt(coeffs[j]) * BigInt(channelSamples[sampleIdx - 1 - j]);
    }
    const pred = qlpShift >= 0 ? Number(sum >> BigInt(qlpShift)) : Number(sum << BigInt(-qlpShift));
    channelSamples[sampleIdx++] = res + pred;
  }
  return sampleIdx;
}

function decodeLpcSubframe(
  reader: BitReader,
  channelSamples: FlacSampleArray,
  curBlockSize: number,
  subframeBps: number,
  order: number
): void {
  if (order > curBlockSize) {
    throw new ConversionFailedError(UNSUPPORTED_AUDIO_MESSAGE);
  }
  for (let s = 0; s < order; s++) {
    channelSamples[s] = reader.readSignedBits(subframeBps);
  }

  const qlpPrecisionRaw = reader.readBits(4);
  if (qlpPrecisionRaw === 15) {
    throw new ConversionFailedError(UNSUPPORTED_AUDIO_MESSAGE);
  }
  const qlpPrecision = qlpPrecisionRaw + 1;
  const qlpShift = reader.readSignedBits(5);
  const coeffs = new Int32Array(order);
  for (let j = 0; j < order; j++) {
    coeffs[j] = reader.readSignedBits(qlpPrecision);
  }

  const { numPartitions, kBits, escapeK, partitionSize } = parseResidualHeader(reader, curBlockSize, order);
  const useFastNumberLpc =
    qlpShift >= 0 && subframeBps + qlpPrecision + Math.ceil(Math.log2(order + 1)) <= 52;
  const lpc: LpcParams = {
    coeffs,
    order,
    qlpShift,
    shiftScale: useFastNumberLpc ? 2 ** qlpShift : 1,
  };
  let sampleIdx = order;

  for (let p = 0; p < numPartitions; p++) {
    const k = reader.readBits(kBits);
    const pSamples = partitionSize - (p === 0 ? order : 0);

    if (k === escapeK) {
      const rawBits = reader.readBits(5);
      for (let s = 0; s < pSamples; s++) {
        const res = rawBits > 0 ? reader.readSignedBits(rawBits) : 0;
        let pred = 0;
        if (useFastNumberLpc) {
          let sum = 0;
          for (let j = 0; j < order; j++) {
            sum += coeffs[j] * channelSamples[sampleIdx - 1 - j];
          }
          pred = Math.floor(sum / lpc.shiftScale);
        } else {
          let sum = 0n;
          for (let j = 0; j < order; j++) {
            sum += BigInt(coeffs[j]) * BigInt(channelSamples[sampleIdx - 1 - j]);
          }
          pred = qlpShift >= 0 ? Number(sum >> BigInt(qlpShift)) : Number(sum << BigInt(-qlpShift));
        }
        channelSamples[sampleIdx++] = res + pred;
      }
    } else if (useFastNumberLpc) {
      sampleIdx = decodeLpcPartitionFast(reader, channelSamples, sampleIdx, pSamples, k, lpc);
    } else {
      sampleIdx = decodeLpcPartitionBigInt(reader, channelSamples, sampleIdx, pSamples, k, lpc);
    }
  }
}

function decodeFlacSubframe(
  reader: BitReader,
  curBlockSize: number,
  subframeBps: number
): FlacSampleArray {
  const zeroBit = reader.readBit();
  if (zeroBit !== 0) {
    throw new ConversionFailedError(UNSUPPORTED_AUDIO_MESSAGE);
  }
  const subframeType = reader.readBits(6);
  const wastedFlag = reader.readBit();
  let wastedBits = 0;
  let activeBps = subframeBps;
  if (wastedFlag === 1) {
    wastedBits = reader.readUnaryZeroes(subframeBps) + 1;
    activeBps -= wastedBits;
  }
  if (activeBps < 1 || activeBps > 33) {
    throw new ConversionFailedError(UNSUPPORTED_AUDIO_MESSAGE);
  }

  const channelSamples: FlacSampleArray =
    activeBps >= 32 ? new Float64Array(curBlockSize) : new Int32Array(curBlockSize);

  if (subframeType === 0) {
    channelSamples.fill(reader.readSignedBits(activeBps));
  } else if (subframeType === 1) {
    for (let s = 0; s < curBlockSize; s++) {
      channelSamples[s] = reader.readSignedBits(activeBps);
    }
  } else if ((subframeType & 0x38) === 0x08) {
    decodeFixedSubframe(reader, channelSamples, curBlockSize, activeBps, subframeType & 0x07);
  } else if ((subframeType & 0x20) !== 0) {
    decodeLpcSubframe(reader, channelSamples, curBlockSize, activeBps, (subframeType & 0x1f) + 1);
  } else {
    throw new ConversionFailedError(UNSUPPORTED_AUDIO_MESSAGE);
  }

  if (wastedBits > 0) {
    const scale = 2 ** wastedBits;
    for (let s = 0; s < curBlockSize; s++) {
      channelSamples[s] *= scale;
    }
  }
  return channelSamples;
}

function decorrelateFlacChannels(
  channelData: FlacSampleArray[],
  curBlockSize: number,
  chCode: number
): void {
  if (chCode === 8) {
    for (let s = 0; s < curBlockSize; s++) {
      channelData[1][s] = channelData[0][s] - channelData[1][s];
    }
  } else if (chCode === 9) {
    for (let s = 0; s < curBlockSize; s++) {
      channelData[0][s] = channelData[1][s] + channelData[0][s];
    }
  } else if (chCode === 10) {
    for (let s = 0; s < curBlockSize; s++) {
      const mid = channelData[0][s];
      const side = channelData[1][s];
      const m2 = mid * 2 + (side & 1);
      channelData[0][s] = Math.floor((m2 + side) / 2);
      channelData[1][s] = Math.floor((m2 - side) / 2);
    }
  }
}

/** How far a sample of each source width moves to become 16 bits: right for wider samples, left for 8-bit ones. */
const SAMPLE_SHIFT_TO_16_BITS: Readonly<Record<number, number>> = { 8: 8, 24: -8, 32: -16 };

/** The samples of one frame, channel after channel for each instant, scaled to 16 bits and clamped. */
function interleaveFrame(channelData: readonly FlacSampleArray[], blockSize: number, bitsPerSample: number): Int16Array {
  const channels = channelData.length;
  const shift = SAMPLE_SHIFT_TO_16_BITS[bitsPerSample] ?? 0;
  const frame = new Int16Array(blockSize * channels);
  const scaleDown = shift < 0 ? 1 << -shift : 1;
  const scaleUp = shift > 0 ? 1 << shift : 1;
  for (let s = 0; s < blockSize; s++) {
    for (let c = 0; c < channels; c++) {
      const raw = channelData[c][s];
      const val = shift < 0 ? Math.floor(raw / scaleDown) : raw * scaleUp;
      frame[s * channels + c] = Math.max(-32768, Math.min(32767, val));
    }
  }
  return frame;
}

function resolveFlacBlockSize(reader: BitReader, bsCode: number, fallback: number): number {
  if (bsCode === 1) return 192;
  if (bsCode >= 2 && bsCode <= 5) return 576 * (1 << (bsCode - 2));
  if (bsCode === 6) return reader.readBits(8) + 1;
  if (bsCode === 7) return reader.readBits(16) + 1;
  if (bsCode >= 8 && bsCode <= 15) return 256 * (1 << (bsCode - 8));
  return fallback || 4096;
}

export function decodeFlac(buffer: Buffer): DecodedAudio {
  if (!buffer || buffer.length < 42 || buffer.toString('ascii', 0, 4) !== 'fLaC') {
    throw new ConversionFailedError(UNSUPPORTED_AUDIO_MESSAGE);
  }

  let offset = 4;
  let sampleRate = 44100;
  let channels = 2;
  let bitsPerSample = 16;
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
    }

    offset += 4 + blockLength;
    if (isLast) break;
  }

  assertDecodableLayout(channels, sampleRate);

  // 2. Decode Frames
  const reader = new BitReader(buffer, offset);
  const outChunks: Int16Array[] = [];
  let outLength = 0;

  while (!reader.isEof() && reader.getBytePos() < buffer.length - 4) {
    if (!seekFrameSync(reader, buffer)) break;

    const sync = reader.readBits(14);
    if (sync !== 0x3ffe) {
      reader.alignToByte();
      continue;
    }

    reader.readBit(); // reserved (0)
    reader.readBit(); // blocking strategy
    const bsCode = reader.readBits(4);
    const srCode = reader.readBits(4);
    const chCode = reader.readBits(4);
    reader.readBits(3); // sample size code
    reader.readBit(); // reserved (0)
    reader.readUtf8Number(); // frame or sample number

    const curBlockSize = resolveFlacBlockSize(reader, bsCode, minBlockSize);
    if (srCode === 12) sampleRate = reader.readBits(8) * 1000;
    else if (srCode === 13) sampleRate = reader.readBits(16);
    else if (srCode === 14) sampleRate = reader.readBits(16) * 10;

    reader.readBits(8); // Frame header CRC-8

    const chCount = chCode <= 7 ? chCode + 1 : 2;
    if (chCount > MAX_PURE_CHANNELS || chCount !== channels || outLength + curBlockSize * chCount > MAX_PURE_DECODED_SAMPLES) {
      throw new ConversionFailedError(UNSUPPORTED_AUDIO_MESSAGE);
    }

    const channelData: FlacSampleArray[] = [];
    for (let c = 0; c < chCount; c++) {
      let subframeBps = bitsPerSample;
      if ((chCode === 8 || chCode === 10) && c === 1) subframeBps++;
      else if (chCode === 9 && c === 0) subframeBps++;
      channelData.push(decodeFlacSubframe(reader, curBlockSize, subframeBps));
    }

    decorrelateFlacChannels(channelData, curBlockSize, chCode);
    const frameSamples = interleaveFrame(channelData, curBlockSize, bitsPerSample);
    outChunks.push(frameSamples);
    outLength += frameSamples.length;

    reader.alignToByte();
    reader.readBits(16); // CRC-16
  }

  if (outLength === 0) {
    throw new ConversionFailedError(UNSUPPORTED_AUDIO_MESSAGE);
  }

  const samples = new Int16Array(outLength);
  let written = 0;
  for (const chunk of outChunks) {
    samples.set(chunk, written);
    written += chunk.length;
  }
  return {
    samples,
    sampleRate,
    channels,
    bitsPerSample: 16,
    duration: samples.length / (channels * sampleRate),
    sourceBitsPerSample: bitsPerSample,
    sourceSampleFormat: 'int',
  };
}

// ============================================================================
// 3. MP3, AAC and Ogg (Vorbis, Opus): no in-process decoder
// ============================================================================

/**
 * These codecs need FFmpeg to decode. A faithful MP3 decoder needs side information, the bit reservoir, scalefactors,
 * Huffman tables, stereo processing, the hybrid filterbank and the polyphase synthesis (ISO/IEC 11172-3); AAC LC needs
 * window switching, overlap-add, TNS, PNS, intensity and mid/side stereo and the full ISO/IEC 14496-3 codebook set;
 * Vorbis and Opus need their own codebooks and transforms. None is implemented here, so a source in one of them fails
 * closed (HTTP 503) before any bytes are read.
 */
function refuseWithoutFfmpeg(codec: string): never {
  throw new EngineUnavailableError(
    'ffmpeg',
    `Native FFmpeg engine is required to decode ${codec} audio; there is no in-process ${codec} decoder (Fail-Closed).`
  );
}

// ============================================================================
// 4. Universal Audio Decoder Dispatcher
// ============================================================================

/**
 * Universal Audio Decoder Dispatcher
 * Automatically detects audio format from magic bytes or format hint,
 * and decodes into signed 16-bit PCM samples.
 */
export function decodeAudioBuffer(buffer: Buffer, formatHint?: string): DecodedAudio {
  if (!buffer || buffer.length === 0) {
    throw new ConversionFailedError(UNSUPPORTED_AUDIO_MESSAGE);
  }

  const hint = (formatHint || '').toLowerCase().trim();

  // Explicit hint priority when container magic is ambiguous or wrapped
  if (hint === 'aac' || hint === 'adts' || hint === 'm4a') {
    return refuseWithoutFfmpeg('AAC');
  }
  if (hint === 'ogg' || hint === 'oga' || hint === 'opus' || hint === 'vorbis') {
    return refuseWithoutFfmpeg('Ogg');
  }
  if (hint === 'flac') {
    return decodeFlac(buffer);
  }
  if (hint === 'mp3') {
    return refuseWithoutFfmpeg('MP3');
  }
  if (hint === 'wav' || hint === 'wave' || hint === 'aiff' || hint === 'aif' || hint === 'pcm') {
    return decodeWav(buffer);
  }

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

  // 3. Ogg (starts with OggS)
  if (buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'OggS') {
    return refuseWithoutFfmpeg('Ogg');
  }

  // 4. AAC ADTS (starts with 0xFF followed by 0xF0..0xFF with layer == 00)
  if (
    buffer.length >= 7 &&
    buffer[0] === 0xff &&
    (buffer[1] & 0xf6) === 0xf0
  ) {
    return refuseWithoutFfmpeg('AAC');
  }

  // 5. MP3 (sync word 0xFFE0..0xFFFF, layer != 00)
  if (
    buffer.length >= 2 &&
    buffer[0] === 0xff &&
    (buffer[1] & 0xe0) === 0xe0 &&
    (buffer[1] & 0x06) !== 0
  ) {
    return refuseWithoutFfmpeg('MP3');
  }

  // 6. Audio stream with ID3v2 header: inspect post-ID3 payload
  if (buffer.length >= 10 && buffer.toString('ascii', 0, 3) === 'ID3') {
    const tagSize =
      ((buffer[6] & 0x7f) << 21) |
      ((buffer[7] & 0x7f) << 14) |
      ((buffer[8] & 0x7f) << 7) |
      (buffer[9] & 0x7f);
    let postId3 = 10 + tagSize;
    if (buffer[5] & 0x10) postId3 += 10;

    if (postId3 < buffer.length) {
      if (
        buffer.length - postId3 >= 7 &&
        buffer[postId3] === 0xff &&
        (buffer[postId3 + 1] & 0xf6) === 0xf0
      ) {
        return refuseWithoutFfmpeg('AAC');
      }
      if (
        buffer.length - postId3 >= 4 &&
        buffer.toString('ascii', postId3, postId3 + 4) === 'fLaC'
      ) {
        return decodeFlac(buffer.subarray(postId3));
      }
    }
    return refuseWithoutFfmpeg('MP3');
  }

  // Unsupported formats (video containers like MP4, MKV, WebM or unknown codecs)
  throw new ConversionFailedError(UNSUPPORTED_AUDIO_MESSAGE);
}
