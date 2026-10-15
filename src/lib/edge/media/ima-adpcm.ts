/**
 * IMA ADPCM in WAVE files (format tag 0x11), after the IMA recommended practices for digital audio.
 *
 * A file is a run of blocks of `blockAlign` bytes. Each block opens with a 4-byte header per channel (the
 * channel's first sample as an int16 predictor, a step index 0..88, and a zero byte) and continues with 4-bit
 * codes: for one channel the codes follow in pairs, low nibble first; for two channels the codes come in groups
 * of 4 bytes (8 samples) of channel 0 then 4 bytes of channel 1. A block therefore carries
 * `(blockAlign - 4 * channels) * 2 / channels + 1` samples per channel. The format chunk is 20 bytes
 * (cbSize 2, wSamplesPerBlock), a `fact` chunk states the sample count per channel, and the data is a whole
 * number of blocks, the last one padded. The step table and index adjustments are the IMA tables; a sample is
 * rebuilt as `step / 8 + (code & 4 ? step : 0) + (code & 2 ? step / 2 : 0) + (code & 1 ? step / 4 : 0)`.
 */

import { CorruptStreamError } from '../../types';
import { EdgeUnsupportedError } from '../workers/worker-errors';
import { refuse, WAV_MAX_SAMPLE_RATE } from './wav-demux';
import { riffPadBytes, writeAscii } from './wav-writer';

export const IMA_FORMAT_TAG = 0x11;
export const IMA_MAX_CHANNELS = 2;
export const IMA_WAV_HEADER_BYTES = 60;

const IMA_BITS_PER_SAMPLE = 4;
const IMA_MAX_STEP_INDEX = 88;
const IMA_CHANNEL_HEADER_BYTES = 4;
const IMA_GROUP_BYTES = 4;
const IMA_SAMPLES_PER_GROUP = 8;
const IMA_BLOCK_ALIGN_UNIT = 256;
const IMA_RATE_UNIT_HZ = 11_000;
const FMT_COMMON_BODY_BYTES = 16;
const FMT_IMA_BODY_BYTES = 20;
const FMT_IMA_CB_SIZE = 2;
const FACT_BODY_BYTES = 4;
/** RIFF body bytes besides the data: WAVE, the fmt chunk (8 + 20), the fact chunk (8 + 4) and the data header (8). */
const IMA_RIFF_OVERHEAD_BYTES = 52;
const UINT32_MAX = 0xffff_ffff;
const NIBBLE_MASK = 0x0f;
const SIGN_BIT = 8;
const INT16_MAX = 32_767;
const INT16_MIN = -32_768;

const IMA_STEP_TABLE: readonly number[] = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107,
  118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894,
  6484, 7132, 7845, 8630, 9493, 10_442, 11_487, 12_635, 13_899, 15_289, 16_818, 18_500, 20_350, 22_385, 24_623,
  27_086, 29_794, 32_767,
];
const IMA_INDEX_ADJUST: readonly number[] = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];

export interface ImaFormat {
  sampleRate: number;
  channels: number;
  blockAlign: number;
  /** Samples per channel in one block, the first of which sits in the block header. */
  samplesPerBlock: number;
}

/** The running state of one channel: the sample the decoder holds and the position in the step table. */
export interface ImaChannelState {
  predictor: number;
  stepIndex: number;
}

export function imaSamplesPerBlock(blockAlign: number, channels: number): number {
  return ((blockAlign - IMA_CHANNEL_HEADER_BYTES * channels) * 2) / channels + 1;
}

/** The format to write for a rate and channel count: 256 bytes per channel per 11 kHz of sample rate, as is customary. */
export function imaFormatFor(sampleRate: number, channels: number): ImaFormat {
  const blockAlign = IMA_BLOCK_ALIGN_UNIT * channels * Math.max(1, Math.floor(sampleRate / IMA_RATE_UNIT_HZ));
  return { sampleRate, channels, blockAlign, samplesPerBlock: imaSamplesPerBlock(blockAlign, channels) };
}

export function newImaChannelStates(channels: number): ImaChannelState[] {
  return Array.from({ length: channels }, () => ({ predictor: 0, stepIndex: 0 }));
}

function clampInt16(value: number): number {
  return Math.max(INT16_MIN, Math.min(INT16_MAX, value));
}

function nextIndex(index: number, code: number): number {
  return Math.max(0, Math.min(IMA_MAX_STEP_INDEX, index + IMA_INDEX_ADJUST[code]));
}

/** Encodes one sample as a 4-bit code against the decoder state, and moves the state as the decoder will. */
function encodeSample(sample: number, state: ImaChannelState): number {
  const step = IMA_STEP_TABLE[state.stepIndex];
  let diff = sample - state.predictor;
  let code = 0;
  if (diff < 0) {
    code = SIGN_BIT;
    diff = -diff;
  }
  let delta = step >> 3;
  if (diff >= step) {
    code |= 4;
    diff -= step;
    delta += step;
  }
  if (diff >= step >> 1) {
    code |= 2;
    diff -= step >> 1;
    delta += step >> 1;
  }
  if (diff >= step >> 2) {
    code |= 1;
    delta += step >> 2;
  }
  state.predictor = clampInt16(state.predictor + (code & SIGN_BIT ? -delta : delta));
  state.stepIndex = nextIndex(state.stepIndex, code);
  return code;
}

function decodeSample(code: number, state: ImaChannelState): number {
  const step = IMA_STEP_TABLE[state.stepIndex];
  let delta = step >> 3;
  if (code & 4) delta += step;
  if (code & 2) delta += step >> 1;
  if (code & 1) delta += step >> 2;
  state.predictor = clampInt16(state.predictor + (code & SIGN_BIT ? -delta : delta));
  state.stepIndex = nextIndex(state.stepIndex, code);
  return state.predictor;
}

/**
 * Encodes one block. `pcm` holds `count` interleaved frames (at most `samplesPerBlock`); a short last block is
 * completed with silent frames, which the `fact` chunk excludes from the audio.
 */
export function encodeImaBlock(
  pcm: Int16Array,
  count: number,
  format: ImaFormat,
  states: ImaChannelState[],
  out: Uint8Array
): void {
  const { channels, samplesPerBlock } = format;
  out.fill(0, 0, format.blockAlign);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  for (let c = 0; c < channels; c++) {
    const state = states[c];
    state.predictor = pcm[c];
    view.setInt16(IMA_CHANNEL_HEADER_BYTES * c, state.predictor, true);
    out[IMA_CHANNEL_HEADER_BYTES * c + 2] = state.stepIndex;
  }
  const codesStart = IMA_CHANNEL_HEADER_BYTES * channels;
  for (let n = 1; n < samplesPerBlock; n++) {
    const group = Math.floor((n - 1) / IMA_SAMPLES_PER_GROUP);
    const within = (n - 1) % IMA_SAMPLES_PER_GROUP;
    for (let c = 0; c < channels; c++) {
      const code = encodeSample(n < count ? pcm[n * channels + c] : 0, states[c]);
      const at = codesStart + (group * channels + c) * IMA_GROUP_BYTES + (within >> 1);
      out[at] |= within % 2 === 0 ? code : code << IMA_BITS_PER_SAMPLE;
    }
  }
}

/** Decodes one block into `out` (`samplesPerBlock * channels` interleaved samples). */
export function decodeImaBlock(block: Uint8Array, format: ImaFormat, out: Int16Array): void {
  const { channels, samplesPerBlock } = format;
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  const states: ImaChannelState[] = [];
  for (let c = 0; c < channels; c++) {
    const stepIndex = block[IMA_CHANNEL_HEADER_BYTES * c + 2];
    if (stepIndex > IMA_MAX_STEP_INDEX) {
      throw new CorruptStreamError(`An IMA ADPCM block has step index ${stepIndex}, above ${IMA_MAX_STEP_INDEX}.`);
    }
    states.push({ predictor: view.getInt16(IMA_CHANNEL_HEADER_BYTES * c, true), stepIndex });
    out[c] = states[c].predictor;
  }
  const codesStart = IMA_CHANNEL_HEADER_BYTES * channels;
  const groups = (samplesPerBlock - 1) / IMA_SAMPLES_PER_GROUP;
  for (let g = 0; g < groups; g++) {
    for (let c = 0; c < channels; c++) {
      const at = codesStart + (g * channels + c) * IMA_GROUP_BYTES;
      for (let k = 0; k < IMA_SAMPLES_PER_GROUP; k++) {
        const byte = block[at + (k >> 1)];
        const code = k % 2 === 0 ? byte & NIBBLE_MASK : byte >> IMA_BITS_PER_SAMPLE;
        out[(1 + g * IMA_SAMPLES_PER_GROUP + k) * channels + c] = decodeSample(code, states[c]);
      }
    }
  }
}

/** The 60-byte header (RIFF, fmt, fact, data) of an IMA ADPCM WAV of `frames` samples per channel in `blocks` blocks. */
export function writeImaWavHeader(format: ImaFormat, frames: number, blocks: number): Uint8Array {
  const dataBytes = blocks * format.blockAlign;
  const riffSize = IMA_RIFF_OVERHEAD_BYTES + dataBytes + riffPadBytes(dataBytes);
  if (riffSize > UINT32_MAX || frames > UINT32_MAX) {
    throw new EdgeUnsupportedError('The audio is too long for a 32-bit RIFF size (RF64 is not written).');
  }
  const out = new Uint8Array(IMA_WAV_HEADER_BYTES);
  const view = new DataView(out.buffer);
  writeAscii(out, 0, 'RIFF');
  view.setUint32(4, riffSize, true);
  writeAscii(out, 8, 'WAVEfmt ');
  view.setUint32(16, FMT_IMA_BODY_BYTES, true);
  view.setUint16(20, IMA_FORMAT_TAG, true);
  view.setUint16(22, format.channels, true);
  view.setUint32(24, format.sampleRate, true);
  view.setUint32(28, Math.round((format.sampleRate * format.blockAlign) / format.samplesPerBlock), true);
  view.setUint16(32, format.blockAlign, true);
  view.setUint16(34, IMA_BITS_PER_SAMPLE, true);
  view.setUint16(36, FMT_IMA_CB_SIZE, true);
  view.setUint16(38, format.samplesPerBlock, true);
  writeAscii(out, 40, 'fact');
  view.setUint32(44, FACT_BODY_BYTES, true);
  view.setUint32(48, frames, true);
  writeAscii(out, 52, 'data');
  view.setUint32(56, dataBytes, true);
  return out;
}

/** Reads and checks the fmt body of an IMA ADPCM WAV. */
export function parseImaFormatBody(view: DataView, start: number, size: number): ImaFormat {
  if (size < FMT_COMMON_BODY_BYTES) throw refuse('the fmt chunk is too short');
  const tag = view.getUint16(start, true);
  if (tag !== IMA_FORMAT_TAG) throw refuse(`format tag 0x${tag.toString(16)} is not IMA ADPCM`);
  if (size < FMT_IMA_BODY_BYTES) throw refuse('the fmt chunk is too short for IMA ADPCM');
  const channels = view.getUint16(start + 2, true);
  const sampleRate = view.getUint32(start + 4, true);
  const blockAlign = view.getUint16(start + 12, true);
  const bits = view.getUint16(start + 14, true);
  const samplesPerBlock = view.getUint16(start + 18, true);
  if (channels < 1 || channels > IMA_MAX_CHANNELS) throw refuse(`IMA ADPCM is read for 1 or 2 channels, not ${channels}`);
  if (sampleRate < 1 || sampleRate > WAV_MAX_SAMPLE_RATE) throw refuse(`${sampleRate} Hz is not a supported sample rate`);
  if (bits !== IMA_BITS_PER_SAMPLE) throw refuse(`IMA ADPCM has 4 bits per sample, not ${bits}`);
  const codeBytes = blockAlign - IMA_CHANNEL_HEADER_BYTES * channels;
  if (codeBytes <= 0 || codeBytes % (IMA_GROUP_BYTES * channels) !== 0) {
    throw refuse(`block align ${blockAlign} is not a whole number of ${channels}-channel code groups`);
  }
  if (samplesPerBlock !== imaSamplesPerBlock(blockAlign, channels)) {
    throw refuse(`${samplesPerBlock} samples per block disagrees with block align ${blockAlign}`);
  }
  return { sampleRate, channels, blockAlign, samplesPerBlock };
}
