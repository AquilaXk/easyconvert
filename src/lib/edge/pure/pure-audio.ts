/**
 * Pure Isomorphic Audio Converter (Level 0 Fast-Path)
 *
 * Implements pure TypedArray-based WAV parsing, standard RIFF WAV encoding,
 * and pure TypeScript MPEG-1 Layer III (MP3) encoding using Uint8Array and DataView
 * (strictly zero Node.js Buffer dependencies).
 *
 * Nothing is assumed about a source: a WAV states its own format and anything but integer PCM or float is refused,
 * and raw PCM is read only when the caller describes it. A different sample rate or channel layout in the options
 * is produced by resampling (the project's polyphase resampler) and remixing, never by relabelling the header;
 * a layout the engine cannot mix is an EdgeUnsupportedError and the server engine converts the file.
 */

import { WAV_MAX_CHANNELS, WAV_MAX_SAMPLE_RATE } from '../media/wav-demux';
import { EdgeUnsupportedError } from '../workers/worker-errors';
import {
  checkedRawFormat,
  decodeAudio,
  encodeAudioWav,
  refuse,
  remixAudio,
  resampleAudio,
  type RawPcmFormat,
} from './pure-audio-pcm';

export type { RawPcmFormat } from './pure-audio-pcm';

export interface PureAudioResult {
  data: Uint8Array;
  mimeType: string;
  extension: string;
}

export interface PureAudioOptions {
  /** Output sample rate; the audio is resampled to it. Omitted, the source rate stays. */
  sampleRate?: number;
  /** Output channel count (1 or 2); the audio is remixed to it. Omitted, the source layout stays. */
  channels?: number;
  bitrate?: string;
  title?: string;
  /** The description of a raw PCM source (`pcm`, `raw`). */
  source?: RawPcmFormat;
}

const SUPPORTED_AUDIO_SOURCES = new Set(['wav', 'pcm', 'raw']);
const RAW_AUDIO_SOURCES = new Set(['pcm', 'raw']);
/** Targets the pure engine writes. Lossy targets such as MP3 are encoded by the server engine. */
const SUPPORTED_AUDIO_TARGETS = new Set(['wav']);

const AUDIO_MIME_MAP: Record<string, string> = {
  wav: 'audio/wav',
};

const STEREO = 2;
const BYTES_PER_INT16 = 2;
const UINT32_MAX = 0xffff_ffff;
const WAV_PCM_HEADER_BYTES = 44;
/** The id and size words in front of a RIFF body, which the RIFF size does not count. */
const RIFF_HEADER_BYTES = 8;
const INT16_MIN = -32_768;
const INT16_MAX = 32_767;
const INT16_SHIFT = 16;

function writeAscii(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * Checks whether the source and target formats are supported by the pure audio engine. A raw PCM source
 * (`pcm`, `raw`) is supported only when `options.source` describes it.
 */
export function isPureAudioConvertible(
  sourceFormat: string,
  targetFormat: string,
  options?: Pick<PureAudioOptions, 'source'>
): boolean {
  const src = sourceFormat.toLowerCase();
  const tgt = targetFormat.toLowerCase();
  if (!SUPPORTED_AUDIO_SOURCES.has(src) || !SUPPORTED_AUDIO_TARGETS.has(tgt)) return false;
  return !RAW_AUDIO_SOURCES.has(src) || options?.source !== undefined;
}

/**
 * A 16-bit view of WAV bytes (or of raw PCM that `raw` describes): the interleaved samples rounded to 16 bits
 * (float audio scaled by 32767), with the rate and channels the file states. Conversions do not use it, because
 * they keep the source's own depth; it is for callers that need 16-bit samples, such as an encoder.
 */
export function parseWavPcm(
  bytes: Uint8Array,
  raw?: RawPcmFormat
): {
  samples: Int16Array;
  sampleRate: number;
  channels: number;
} {
  const audio = decodeAudio(bytes, raw);
  const samples = new Int16Array(audio.samples.length);
  for (let i = 0; i < samples.length; i++) {
    const value = audio.isFloat ? audio.samples[i] * INT16_MAX : audio.samples[i] / 2 ** INT16_SHIFT;
    samples[i] = Math.max(INT16_MIN, Math.min(INT16_MAX, Math.round(value)));
  }
  return { samples, sampleRate: audio.sampleRate, channels: audio.channels };
}

/**
 * Encodes 16-bit PCM samples into standard RIFF WAV format using Uint8Array and DataView.
 */
export function encodePcmToWav(samples: Int16Array, sampleRate: number, channels: number): Uint8Array {
  if (!Number.isInteger(channels) || channels < 1 || channels > WAV_MAX_CHANNELS) {
    throw refuse(`${channels} channels are not a WAV layout this engine writes`);
  }
  if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > WAV_MAX_SAMPLE_RATE) {
    throw refuse(`${sampleRate} Hz is not a sample rate this engine writes`);
  }
  if (samples.length % channels !== 0) {
    throw refuse(`${samples.length} samples are not a whole number of frames of ${channels} channels`);
  }
  const blockAlign = channels * BYTES_PER_INT16;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * BYTES_PER_INT16;
  const totalSize = WAV_PCM_HEADER_BYTES + dataSize;
  if (totalSize - RIFF_HEADER_BYTES > UINT32_MAX) throw refuse('the audio is too long for a 32-bit RIFF size');

  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

  // 1. RIFF chunk descriptor
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');

  // 2. 'fmt ' subchunk
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 = PCM)
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // BitsPerSample

  // 3. 'data' subchunk
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // 4. PCM audio samples
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(44 + i * 2, samples[i], true);
  }

  return out;
}

/**
 * Converts WAV (or described raw PCM) to WAV purely using typed arrays. The source layout, rate and sample format
 * (8, 16, 24 or 32-bit integer, or 32-bit float) are kept unless the options name others; naming others remixes
 * (mono and stereo) and resamples the samples, never just the header. Mono and stereo are the layouts it writes.
 */
export function convertPureAudio(
  input: Uint8Array,
  sourceFormat: string,
  targetFormat: string,
  options: PureAudioOptions = {}
): PureAudioResult {
  const src = sourceFormat.toLowerCase();
  const tgt = targetFormat.toLowerCase();

  if (!isPureAudioConvertible(src, tgt, options)) {
    if (RAW_AUDIO_SOURCES.has(src) && SUPPORTED_AUDIO_TARGETS.has(tgt)) checkedRawFormat(options.source);
    throw new EdgeUnsupportedError(`Pure audio engine does not support conversion from '${src}' to '${tgt}'.`);
  }

  const decoded = decodeAudio(input, RAW_AUDIO_SOURCES.has(src) ? options.source : undefined);
  if (decoded.channels > STEREO) {
    throw refuse(`the pure engine mixes and writes 1 or 2 channels, and the audio has ${decoded.channels}`);
  }
  const targetChannels = options.channels ?? decoded.channels;
  const targetSampleRate = options.sampleRate ?? decoded.sampleRate;

  // Remix first (fewer samples to resample when mixing down), then resample.
  const audio = resampleAudio(remixAudio(decoded, targetChannels), targetSampleRate);

  return {
    data: encodeAudioWav(audio),
    mimeType: AUDIO_MIME_MAP[tgt],
    extension: tgt,
  };
}
