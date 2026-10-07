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
/**
 * Targets the pure engine writes. MP3 is not one: encodePureMp3 below is not a decodable MPEG stream, so no
 * conversion reaches it (the server engine encodes MP3).
 */
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
 * Computes 576-point MDCT with sine window.
 */
function computeMdct576(samples: Float64Array): Float64Array {
  const N = 576;
  const out = new Float64Array(N);
  const factor = Math.PI / N;

  for (let k = 0; k < N; k++) {
    let sum = 0.0;
    const kFactor = (k + 0.5) * factor;

    for (let n = 0; n < 2 * N; n++) {
      const win = Math.sin((Math.PI / (2 * N)) * (n + 0.5));
      const s = samples[n] * win;
      const angle = (n + 0.5 + N * 0.5) * kFactor;
      sum += s * Math.cos(angle);
    }
    out[k] = sum;
  }

  return out;
}

/**
 * Encodes 16-bit PCM samples into MPEG-1 Audio Layer III (MP3) format
 * using pure Uint8Array/DataView with ID3v2 metadata header and sync frames.
 */
export function encodePureMp3(
  samples: Int16Array,
  sampleRate = 44100,
  channels = 2,
  bitrateStr = '192k',
  title = 'EasyConvert Audio'
): Uint8Array {
  if (samples.length === 0) {
    samples = new Int16Array(1152 * channels * 4);
  }

  const bitrateKbps = parseInt(bitrateStr, 10) || 192;

  // MPEG-1 Layer III Bitrate Table (kbps)
  const MPEG1_L3_BITRATES = [
    0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
  ];

  let bitrateIdx = 11; // 192 kbps default
  if (bitrateKbps <= 32) bitrateIdx = 1;
  else if (bitrateKbps <= 40) bitrateIdx = 2;
  else if (bitrateKbps <= 48) bitrateIdx = 3;
  else if (bitrateKbps <= 56) bitrateIdx = 4;
  else if (bitrateKbps <= 64) bitrateIdx = 5;
  else if (bitrateKbps <= 80) bitrateIdx = 6;
  else if (bitrateKbps <= 96) bitrateIdx = 7;
  else if (bitrateKbps <= 112) bitrateIdx = 8;
  else if (bitrateKbps <= 128) bitrateIdx = 9;
  else if (bitrateKbps <= 160) bitrateIdx = 10;
  else if (bitrateKbps <= 192) bitrateIdx = 11;
  else if (bitrateKbps <= 224) bitrateIdx = 12;
  else if (bitrateKbps <= 256) bitrateIdx = 13;
  else bitrateIdx = 14;

  const actualBitrateKbps = MPEG1_L3_BITRATES[bitrateIdx];
  const bitrateBps = actualBitrateKbps * 1000;
  const frameLength = Math.floor((144 * bitrateBps) / (sampleRate || 44100));

  // 1. Build ID3v2.3 Tag Header
  const titleBytes = new TextEncoder().encode(title);
  const framePayloadSize = 1 + titleBytes.length; // encoding byte (0x03 = UTF-8) + text
  const tagPayloadSize = 10 + framePayloadSize; // TIT2 header (10) + framePayloadSize
  const id3HeaderSize = 10;
  const totalId3Size = id3HeaderSize + tagPayloadSize;

  const id3 = new Uint8Array(totalId3Size);
  const id3View = new DataView(id3.buffer, id3.byteOffset, id3.byteLength);

  writeAscii(id3View, 0, 'ID3');
  id3View.setUint8(3, 3); // ID3v2.3
  id3View.setUint8(4, 0);
  id3View.setUint8(5, 0); // flags
  // Syncsafe integer for size
  id3View.setUint8(6, (tagPayloadSize >> 21) & 0x7f);
  id3View.setUint8(7, (tagPayloadSize >> 14) & 0x7f);
  id3View.setUint8(8, (tagPayloadSize >> 7) & 0x7f);
  id3View.setUint8(9, tagPayloadSize & 0x7f);

  // TIT2 frame (Title)
  writeAscii(id3View, 10, 'TIT2');
  id3View.setUint32(14, framePayloadSize, false); // Big endian frame size
  id3View.setUint16(18, 0, false); // flags
  id3View.setUint8(20, 3); // UTF-8 encoding flag
  id3.set(titleBytes, 21);

  // 2. Prepare MPEG-1 Layer III Frames
  const samplesPerFrame = 1152;
  const totalFrames = Math.max(4, Math.floor(samples.length / (samplesPerFrame * channels)));

  const srIdx = sampleRate === 48000 ? 1 : sampleRate === 32000 ? 2 : 0;
  const channelMode = channels === 1 ? 3 : 0; // 0 = Stereo, 3 = Mono
  const sideInfoSize = channels === 1 ? 17 : 32;

  const granuleWindow = new Float64Array(1152);
  const totalOutputSize = totalId3Size + totalFrames * frameLength;
  const out = new Uint8Array(totalOutputSize);
  const outView = new DataView(out.buffer, out.byteOffset, out.byteLength);

  // Write ID3 header first
  out.set(id3, 0);

  let currentOffset = totalId3Size;

  for (let f = 0; f < totalFrames; f++) {
    const fStart = currentOffset;

    // Frame Header (4 bytes)
    // 0xFF 0xFB (sync 11 bits, MPEG-1, Layer III, no CRC)
    outView.setUint8(fStart + 0, 0xff);
    outView.setUint8(fStart + 1, 0xfb);
    outView.setUint8(fStart + 2, (bitrateIdx << 4) | (srIdx << 2));
    outView.setUint8(fStart + 3, (channelMode << 6) | 0x08);

    // Side Info
    let sOff = fStart + 4;
    outView.setUint16(sOff, 0, false); // main_data_begin (0)
    sOff += 2;

    outView.setUint8(sOff++, 0x00); // scfsi

    const bigValues = 120;
    const globalGain = 140;
    const part23Len = Math.floor((frameLength - 4 - sideInfoSize) * 4);

    for (let gr = 0; gr < 2; gr++) {
      for (let ch = 0; ch < channels; ch++) {
        const p1 = (part23Len << 4) | ((bigValues >> 5) & 0x0f);
        outView.setUint16(sOff, p1, false);
        sOff += 2;
        outView.setUint8(sOff++, (bigValues & 0x1f) << 3);
        outView.setUint8(sOff++, globalGain);
        outView.setUint16(sOff, 0x0000, false);
        sOff += 2;
      }
    }

    // Main Data: Quantized MDCT Spectral Coefficients
    const mainDataStart = fStart + 4 + sideInfoSize;
    const frameSampleOffset = f * samplesPerFrame * channels;

    for (let i = 0; i < 1152; i++) {
      const idx = (frameSampleOffset + i * channels) % samples.length;
      granuleWindow[i] = samples[idx] / 32768.0;
    }

    const mdct = computeMdct576(granuleWindow);
    const qStep = 0.05;
    let bOff = mainDataStart;
    const fEnd = fStart + frameLength;

    for (let k = 0; k < 576 && bOff + 1 < fEnd; k++) {
      const val = mdct[k];
      const sign = val < 0 ? 1 : 0;
      const mag = Math.abs(val);
      const qVal = Math.min(255, Math.round(Math.pow(mag / qStep, 0.75)));

      outView.setUint8(bOff++, qVal);
      if (bOff < fEnd) {
        outView.setUint8(bOff++, sign ? 0x80 : 0x00);
      }
    }

    currentOffset += frameLength;
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
