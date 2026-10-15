/**
 * Writes the RIFF/WAVE header of integer PCM audio whose length is known before the first sample is written.
 *
 * The RIFF size (everything after the first eight bytes) and the data size are exact on the first write: the
 * streams that use this know their output length from the input length, and a mismatch at the end is an error,
 * so a header never states a length the file does not have. RIFF sizes are 32-bit; RF64 is not written, so audio
 * that does not fit is refused. A data chunk of odd length is followed by one pad byte, which the RIFF size counts.
 */

import { EdgeUnsupportedError } from '../workers/worker-errors';
import { WAV_MAX_CHANNELS, WAV_MAX_SAMPLE_RATE } from './wav-demux';

export const WAV_PCM_HEADER_BYTES = 44;
/** Bytes of RIFF body (after the 8-byte RIFF header) that are not audio: WAVE, the fmt chunk and the data header. */
const PCM_RIFF_OVERHEAD_BYTES = 36;
const FMT_PCM_BODY_BYTES = 16;
const FORMAT_TAG_PCM = 1;
const BITS_PER_BYTE = 8;
const UINT32_MAX = 0xffff_ffff;
const PCM_WRITTEN_BIT_DEPTHS: ReadonlySet<number> = new Set([8, 16, 24, 32]);

export interface PcmWavFormat {
  sampleRate: number;
  channels: number;
  bitDepth: number;
}

export function writeAscii(out: Uint8Array, at: number, text: string): void {
  for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i);
}

/** The bytes of padding after a chunk body of `size` bytes. */
export function riffPadBytes(size: number): number {
  return size % 2;
}

/** Throws EdgeUnsupportedError unless the format is one this writer states exactly. */
export function assertWritablePcmFormat(format: PcmWavFormat): void {
  const { sampleRate, channels, bitDepth } = format;
  if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > WAV_MAX_SAMPLE_RATE) {
    throw new EdgeUnsupportedError(`sampleRate ${sampleRate} is not an integer from 1 to ${WAV_MAX_SAMPLE_RATE}.`);
  }
  if (!Number.isInteger(channels) || channels < 1 || channels > WAV_MAX_CHANNELS) {
    throw new EdgeUnsupportedError(`channels ${channels} is not an integer from 1 to ${WAV_MAX_CHANNELS}.`);
  }
  if (!PCM_WRITTEN_BIT_DEPTHS.has(bitDepth)) {
    throw new EdgeUnsupportedError(`bitDepth ${bitDepth} is not one of ${[...PCM_WRITTEN_BIT_DEPTHS].join(', ')}.`);
  }
}

/** The 44-byte header of a PCM WAV whose data chunk holds `dataBytes` bytes (whole frames). */
export function writePcmWavHeader(format: PcmWavFormat, dataBytes: number): Uint8Array {
  assertWritablePcmFormat(format);
  const blockAlign = (format.channels * format.bitDepth) / BITS_PER_BYTE;
  if (dataBytes % blockAlign !== 0) throw new EdgeUnsupportedError('The audio is not a whole number of frames.');
  const riffSize = PCM_RIFF_OVERHEAD_BYTES + dataBytes + riffPadBytes(dataBytes);
  if (riffSize > UINT32_MAX) {
    throw new EdgeUnsupportedError('The audio is too long for a 32-bit RIFF size (RF64 is not written).');
  }
  const out = new Uint8Array(WAV_PCM_HEADER_BYTES);
  const view = new DataView(out.buffer);
  writeAscii(out, 0, 'RIFF');
  view.setUint32(4, riffSize, true);
  writeAscii(out, 8, 'WAVEfmt ');
  view.setUint32(16, FMT_PCM_BODY_BYTES, true);
  view.setUint16(20, FORMAT_TAG_PCM, true);
  view.setUint16(22, format.channels, true);
  view.setUint32(24, format.sampleRate, true);
  view.setUint32(28, format.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, format.bitDepth, true);
  writeAscii(out, 36, 'data');
  view.setUint32(40, dataBytes, true);
  return out;
}

const FORMAT_TAG_FLOAT = 3;
const FLOAT_BITS = 32;
const FLOAT_FMT_BODY_BYTES = 18;
const FACT_BODY_BYTES = 4;
/** Bytes of RIFF body besides the data in a float file: WAVE, the fmt chunk (8 + 18), the fact chunk (8 + 4), the data header (8). */
const FLOAT_RIFF_OVERHEAD_BYTES = 50;
export const WAV_FLOAT_HEADER_BYTES = 58;

/**
 * The 58-byte header (RIFF, fmt, fact, data) of a 32-bit IEEE float WAV of `frames` frames. A non-PCM format
 * states its sample count in a fact chunk, and its fmt chunk carries the cbSize field (0).
 */
export function writeFloatWavHeader(format: { sampleRate: number; channels: number }, frames: number): Uint8Array {
  assertWritablePcmFormat({ ...format, bitDepth: FLOAT_BITS });
  const blockAlign = (format.channels * FLOAT_BITS) / BITS_PER_BYTE;
  const dataBytes = frames * blockAlign;
  const riffSize = FLOAT_RIFF_OVERHEAD_BYTES + dataBytes;
  if (riffSize > UINT32_MAX || frames > UINT32_MAX) {
    throw new EdgeUnsupportedError('The audio is too long for a 32-bit RIFF size (RF64 is not written).');
  }
  const out = new Uint8Array(WAV_FLOAT_HEADER_BYTES);
  const view = new DataView(out.buffer);
  writeAscii(out, 0, 'RIFF');
  view.setUint32(4, riffSize, true);
  writeAscii(out, 8, 'WAVEfmt ');
  view.setUint32(16, FLOAT_FMT_BODY_BYTES, true);
  view.setUint16(20, FORMAT_TAG_FLOAT, true);
  view.setUint16(22, format.channels, true);
  view.setUint32(24, format.sampleRate, true);
  view.setUint32(28, format.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, FLOAT_BITS, true);
  view.setUint16(36, 0, true);
  writeAscii(out, 38, 'fact');
  view.setUint32(42, FACT_BODY_BYTES, true);
  view.setUint32(46, frames, true);
  writeAscii(out, 50, 'data');
  view.setUint32(54, dataBytes, true);
  return out;
}
