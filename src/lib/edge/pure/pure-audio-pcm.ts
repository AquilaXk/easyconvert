/**
 * The sample side of the pure audio engine: decode a WAV (or described raw PCM) without changing what its
 * samples are, mix between mono and stereo, resample, and write the result in the format it came in.
 *
 * Integer audio is held left-justified in 32-bit integers (a 16-bit sample is shifted up 16 bits), so 8, 16, 24
 * and 32-bit PCM all round-trip exactly and a depth is written back by dropping zero low bits. IEEE float audio is
 * held as 32-bit floats. Mixing and resampling work on those values and round to the nearest sample of the
 * source's own depth when they write; nothing here narrows the depth.
 */

import { resamplePlanarFloat, resampleInterleavedInt16 } from '../../conversions/audio-resampler';
import { readWavLayout, WAV_MAX_CHANNELS, WAV_MAX_SAMPLE_RATE } from '../media/wav-demux';
import { assertWritablePcmFormat, writeFloatWavHeader, writePcmWavHeader } from '../media/wav-writer';
import { EdgeUnsupportedError } from '../workers/worker-errors';

export interface RawPcmFormat {
  sampleRate: number;
  channels: number;
  /** 8 (unsigned), 16, 24 or 32 (signed integers, little-endian). */
  bitDepth: number;
}

export interface DecodedAudio {
  sampleRate: number;
  channels: number;
  /** Bits per sample of the source: 8, 16, 24 or 32. */
  bitDepth: number;
  isFloat: boolean;
  /** Interleaved samples: left-justified 32-bit integers, or floats in -1..1 for IEEE float audio. */
  samples: Int32Array | Float32Array;
}

const MONO = 1;
const STEREO = 2;
const BITS_PER_BYTE = 8;
const INT32_BITS = 32;
const INT32_MAX = 2_147_483_647;
const INT32_MIN = -2_147_483_648;
const U8_SILENCE = 128;
const U8_BITS = 8;
const PCM16_BITS = 16;
const PCM24_BITS = 24;
const INT32_FULL_SCALE = 2 ** 31;
const RAW_PCM_BIT_DEPTHS: ReadonlySet<number> = new Set([8, 16, 24, 32]);
/** Integer PCM depths the reader accepts in a WAV: the strict walker reads 16, 24 and 32; this adds 8. */
const WAV_READ_BIT_DEPTHS: ReadonlySet<number> = new Set([8, 16, 24, 32]);

export function refuse(message: string): EdgeUnsupportedError {
  return new EdgeUnsupportedError(`Pure audio: ${message}; the server engine converts this file.`);
}

/** The raw PCM description a conversion carries, checked; throws EdgeUnsupportedError when it is missing or wrong. */
export function checkedRawFormat(source: RawPcmFormat | undefined): RawPcmFormat {
  if (!source) {
    throw refuse('raw PCM has no header, so the source option has to state its sampleRate, channels and bitDepth');
  }
  const { sampleRate, channels, bitDepth } = source;
  if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > WAV_MAX_SAMPLE_RATE) {
    throw refuse(`sampleRate ${sampleRate} is not an integer from 1 to ${WAV_MAX_SAMPLE_RATE}`);
  }
  if (!Number.isInteger(channels) || channels < 1 || channels > WAV_MAX_CHANNELS) {
    throw refuse(`channels ${channels} is not an integer from 1 to ${WAV_MAX_CHANNELS}`);
  }
  if (!RAW_PCM_BIT_DEPTHS.has(bitDepth)) {
    throw refuse(`bitDepth ${bitDepth} is not one of ${[...RAW_PCM_BIT_DEPTHS].join(', ')}`);
  }
  return source;
}

/**
 * Reads WAV bytes (or raw PCM that `raw` describes). The WAV header is read with the strict RIFF walker: integer
 * PCM at 8, 16, 24 or 32 bits and 32-bit float are read, every other format tag is an EdgeUnsupportedError, and so
 * is a data chunk that runs past the file or ends inside a frame.
 */
export function decodeAudio(bytes: Uint8Array, raw?: RawPcmFormat): DecodedAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let sampleRate: number;
  let channels: number;
  let bitDepth: number;
  let isFloat = false;
  let dataStart = 0;
  let dataBytes = bytes.byteLength;

  if (raw) {
    ({ sampleRate, channels, bitDepth } = checkedRawFormat(raw));
  } else {
    const layout = readWavLayout(bytes, bytes.byteLength, WAV_READ_BIT_DEPTHS);
    ({ sampleRate, channels, isFloat } = layout.format);
    bitDepth = layout.format.bitsPerSample;
    dataStart = layout.dataStart;
    dataBytes = layout.dataBytes;
  }

  const frameBytes = (channels * bitDepth) / BITS_PER_BYTE;
  if (dataBytes % frameBytes !== 0) {
    throw refuse(`the audio is not a whole number of frames (${dataBytes} bytes of ${frameBytes}-byte frames)`);
  }
  if (dataBytes === 0) throw refuse('the file holds no audio');
  const count = (dataBytes / frameBytes) * channels;
  const step = bitDepth / BITS_PER_BYTE;

  if (isFloat) {
    const samples = new Float32Array(count);
    for (let i = 0; i < count; i++) samples[i] = view.getFloat32(dataStart + i * step, true);
    return { sampleRate, channels, bitDepth, isFloat, samples };
  }
  const samples = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const at = dataStart + i * step;
    if (bitDepth === U8_BITS) {
      // Unsigned 8-bit PCM (0..255) -> signed, left-justified
      samples[i] = (view.getUint8(at) - U8_SILENCE) << (INT32_BITS - U8_BITS);
    } else if (bitDepth === PCM16_BITS) {
      samples[i] = view.getInt16(at, true) << (INT32_BITS - PCM16_BITS);
    } else if (bitDepth === PCM24_BITS) {
      const value = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16);
      samples[i] = value << (INT32_BITS - PCM24_BITS);
    } else {
      samples[i] = view.getInt32(at, true);
    }
  }
  return { sampleRate, channels, bitDepth, isFloat, samples };
}

/** Mixes interleaved audio between 1 and 2 channels: mono to both sides, stereo to the mean of the two. */
export function remixAudio(audio: DecodedAudio, to: number): DecodedAudio {
  const from = audio.channels;
  if (from === to) return audio;
  const source = audio.samples;
  const frames = source.length / from;
  const samples = audio.isFloat ? new Float32Array(frames * to) : new Int32Array(frames * to);
  if (from === MONO && to === STEREO) {
    for (let i = 0; i < frames; i++) {
      samples[i * STEREO] = source[i];
      samples[i * STEREO + 1] = source[i];
    }
  } else if (from === STEREO && to === MONO) {
    for (let i = 0; i < frames; i++) {
      const mean = (source[i * STEREO] + source[i * STEREO + 1]) / STEREO;
      // Integer audio rounds the mean to the nearest sample (a tie goes up); float keeps it.
      samples[i] = audio.isFloat ? mean : Math.round(mean);
    }
  } else {
    throw refuse(`remixing ${from} channels to ${to} channels is not done on the edge (only mono and stereo)`);
  }
  return { ...audio, channels: to, samples };
}

function toPlanar(samples: Int32Array | Float32Array, channels: number, scale: number): Float32Array[] {
  const frames = samples.length / channels;
  const planar = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) planar[c][i] = samples[i * channels + c] / scale;
  }
  return planar;
}

/** Resamples to `rate` with the project's polyphase resampler, keeping the source's sample format. */
export function resampleAudio(audio: DecodedAudio, rate: number): DecodedAudio {
  if (rate === audio.sampleRate) return audio;
  const { channels, bitDepth } = audio;
  if (!audio.isFloat && bitDepth === PCM16_BITS) {
    const shift = INT32_BITS - PCM16_BITS;
    const narrow = Int16Array.from(audio.samples as Int32Array, (value) => value >> shift);
    const resampled = resampleInterleavedInt16(narrow, audio.sampleRate, rate, channels);
    return { ...audio, sampleRate: rate, samples: Int32Array.from(resampled, (value) => value << shift) };
  }

  const scale = audio.isFloat ? 1 : INT32_FULL_SCALE;
  const planar = toPlanar(audio.samples, channels, scale);
  // Integer output at 8 bits is dithered to its own grid; 24 and 32 bits and float are left as computed.
  const outputBitDepth = audio.isFloat ? 'float' : (bitDepth as 8 | 24 | 32);
  const quality = bitDepth === U8_BITS ? 'standard' : 'high';
  const out = resamplePlanarFloat(planar, audio.sampleRate, rate, { quality, outputBitDepth });
  const frames = out[0].length;
  const samples = audio.isFloat ? new Float32Array(frames * channels) : new Int32Array(frames * channels);
  for (let c = 0; c < channels; c++) {
    for (let i = 0; i < frames; i++) {
      const value = out[c][i];
      samples[i * channels + c] = audio.isFloat ? value : Math.max(INT32_MIN, Math.min(INT32_MAX, Math.round(value * scale)));
    }
  }
  return { ...audio, sampleRate: rate, samples };
}

/** Writes the audio as a WAV of the format it was read in: the same depth, integer or float, at its own rate. */
export function encodeAudioWav(audio: DecodedAudio): Uint8Array {
  const { sampleRate, channels, bitDepth, isFloat, samples } = audio;
  const bytesPerSample = bitDepth / BITS_PER_BYTE;
  const dataBytes = samples.length * bytesPerSample;
  const header = isFloat
    ? writeFloatWavHeader({ sampleRate, channels }, samples.length / channels)
    : writePcmWavHeader({ sampleRate, channels, bitDepth }, dataBytes);
  assertWritablePcmFormat({ sampleRate, channels, bitDepth });
  const out = new Uint8Array(header.length + dataBytes + (dataBytes % 2));
  out.set(header, 0);
  const view = new DataView(out.buffer);
  const step = 2 ** (INT32_BITS - bitDepth);
  const max = 2 ** (bitDepth - 1) - 1;
  const min = -(2 ** (bitDepth - 1));
  for (let i = 0; i < samples.length; i++) {
    const at = header.length + i * bytesPerSample;
    if (isFloat) {
      view.setFloat32(at, samples[i], true);
      continue;
    }
    // The nearest sample of this depth (a tie goes up); unchanged audio has zero low bits and is exact.
    const value = Math.max(min, Math.min(max, Math.round(samples[i] / step)));
    if (bitDepth === U8_BITS) {
      view.setUint8(at, value + U8_SILENCE);
    } else if (bitDepth === PCM16_BITS) {
      view.setInt16(at, value, true);
    } else if (bitDepth === PCM24_BITS) {
      view.setUint8(at, value & 0xff);
      view.setUint8(at + 1, (value >> 8) & 0xff);
      view.setUint8(at + 2, (value >> 16) & 0xff);
    } else {
      view.setInt32(at, value, true);
    }
  }
  return out;
}
