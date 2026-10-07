/**
 * OPFS audio streams: raw PCM, PCM WAV, 8-bit WAV and IMA ADPCM WAV, converted window by window.
 *
 * Raw PCM has no header, so a raw source is only converted when the options state what it is: `sampleRate`,
 * `channels` and `bitDepth` for a conversion that writes a WAV, `bitDepth` for one that only reorders or narrows
 * samples. A WAV source is read with the strict RIFF walker, so its header gives the rate, channels and sample
 * size and the audio is exactly the data chunk (a LIST chunk before it or a trailer after it is not audio).
 *
 * The output length of every conversion here follows from the input length, so each WAV header is written once,
 * complete, ahead of the audio, and a stream that ends with another length is refused instead of repaired. A
 * trailing partial sample or frame is never dropped: input that is not a whole number of samples (frames,
 * blocks) is an EdgeUnsupportedError and the server engine decides what to do with it.
 */

import { decodeImaBlock, encodeImaBlock, IMA_MAX_CHANNELS, imaFormatFor, newImaChannelStates, parseImaFormatBody, writeImaWavHeader, type ImaFormat } from '../media/ima-adpcm';
import { readWavLayout, refuse, walkWavChunks } from '../media/wav-demux';
import { assertWritablePcmFormat, riffPadBytes, writePcmWavHeader, type PcmWavFormat } from '../media/wav-writer';
import { type ChunkTransformerFn, concatBytes, isLastChunk } from './chunk-transformer';
import { EdgeUnsupportedError } from './worker-errors';

const BITS_PER_BYTE = 8;
const BYTES_PER_INT16 = 2;
const U8_SILENCE = 128;
const U8_SHIFT = 8;
const U8_BITS = 8;
const PCM16_BITS = 16;
const SWAP_BIT_DEPTHS: ReadonlySet<number> = new Set([16, 24, 32]);
const SIXTEEN_BIT_ONLY: ReadonlySet<number> = new Set([16]);
const WAV_BIT_DEPTHS: ReadonlySet<number> = new Set([8, 16, 24, 32]);

type Options = Record<string, unknown> | undefined;

/** The raw PCM facts a caller states in the options, since a header-less stream cannot. */
export interface RawPcmOptions {
  sampleRate?: number;
  channels?: number;
  bitDepth?: number;
}

function readStatedNumber(options: Options, name: keyof RawPcmOptions): number {
  const value = options?.[name];
  if (value === undefined) throw refuse(`raw PCM has no header; the ${name} option has to state it`);
  if (typeof value !== 'number') throw refuse(`${name} ${String(value)} is not a number`);
  return value;
}

function readBitDepth(options: Options, allowed: ReadonlySet<number>): number {
  const bitDepth = readStatedNumber(options, 'bitDepth');
  if (!allowed.has(bitDepth)) throw refuse(`bitDepth ${bitDepth} is not one of ${[...allowed].join(', ')}`);
  return bitDepth;
}

function readRawFormat(options: Options, allowedBitDepths: ReadonlySet<number>): PcmWavFormat {
  const format = {
    sampleRate: readStatedNumber(options, 'sampleRate'),
    channels: readStatedNumber(options, 'channels'),
    bitDepth: readBitDepth(options, allowedBitDepths),
  };
  assertWritablePcmFormat(format);
  return format;
}

function requireWholeUnits(bytes: number, unitBytes: number, what: string): void {
  if (bytes % unitBytes !== 0) {
    throw refuse(`the audio is not a whole number of ${what} (${bytes} bytes of ${unitBytes}-byte units)`);
  }
}

function requireAudio(dataBytes: number): void {
  if (dataBytes === 0) throw refuse('the audio holds no samples');
}

// --- the shared window loop --------------------------------------------------------------------------------

/** What a conversion writes: a header up front, audio converted unit by unit, and whatever follows the last unit. */
interface AudioSink {
  header: Uint8Array;
  /** Input bytes the sink consumes at a time; a window's incomplete last unit waits for the next window. */
  unitBytes: number;
  write(units: Uint8Array): Uint8Array;
  finish(): Uint8Array;
}

interface AudioStart {
  /** Offset of the first audio byte in the input and the number of audio bytes. */
  dataStart: number;
  dataBytes: number;
  sink: AudioSink;
}

const NO_BYTES = new Uint8Array(0);

function createAudioTransformer(begin: (firstWindow: Uint8Array, totalSize: number) => AudioStart): ChunkTransformerFn {
  let started: (AudioStart & { carry: Uint8Array; consumed: number }) | null = null;
  return (chunk, offset, totalSize) => {
    const parts: Uint8Array[] = [];
    if (!started) {
      started = { ...begin(chunk, totalSize), carry: NO_BYTES, consumed: 0 };
      parts.push(started.sink.header);
    }
    const state = started;
    // Only the part of this window inside the data chunk is audio: a header before it and a trailer after it are not.
    const from = Math.max(offset, state.dataStart);
    const to = Math.min(offset + chunk.byteLength, state.dataStart + state.dataBytes);
    if (from < to) {
      const audio = chunk.subarray(from - offset, to - offset);
      state.consumed += audio.byteLength;
      const data = state.carry.byteLength > 0 ? concatBytes([state.carry, audio]) : audio;
      const whole = data.byteLength - (data.byteLength % state.sink.unitBytes);
      state.carry = data.slice(whole);
      if (whole > 0) parts.push(state.sink.write(data.subarray(0, whole)));
    }
    if (isLastChunk(offset, chunk.byteLength, totalSize)) {
      if (state.consumed !== state.dataBytes || state.carry.byteLength > 0) {
        throw refuse('the input ended before the audio the header states');
      }
      parts.push(state.sink.finish());
    }
    return concatBytes(parts);
  };
}

/** A sink that writes the audio bytes as they are, after `header`, with `pad` bytes at the end. */
function passthroughSink(header: Uint8Array, unitBytes: number, pad: number): AudioSink {
  return { header, unitBytes, write: (units) => units, finish: () => new Uint8Array(pad) };
}

/** 16-bit signed little-endian samples to unsigned 8-bit: the top byte of the sample, offset to 128. */
function u8Sink(header: Uint8Array, wrapsWav: boolean, totalSamples: number): AudioSink {
  return {
    header,
    unitBytes: BYTES_PER_INT16,
    write(units) {
      const view = new DataView(units.buffer, units.byteOffset, units.byteLength);
      const out = new Uint8Array(units.byteLength / BYTES_PER_INT16);
      for (let i = 0; i < out.length; i++) out[i] = (view.getInt16(i * BYTES_PER_INT16, true) >> U8_SHIFT) + U8_SILENCE;
      return out;
    },
    finish: () => new Uint8Array(wrapsWav ? riffPadBytes(totalSamples) : 0),
  };
}

// --- the pairs ---------------------------------------------------------------------------------------------

/** Reorders the bytes of each whole sample, which keeps the stream's length and carries a split sample over. */
function createSwapTransformer(options: Options): ChunkTransformerFn {
  const wordBytes = readBitDepth(options, SWAP_BIT_DEPTHS) / BITS_PER_BYTE;
  let carry: Uint8Array = NO_BYTES;
  let checked = false;
  return (chunk, _offset, totalSize) => {
    if (!checked) {
      checked = true;
      requireWholeUnits(totalSize, wordBytes, `${wordBytes * BITS_PER_BYTE}-bit samples`);
    }
    const data = carry.byteLength > 0 ? concatBytes([carry, chunk]) : chunk;
    const whole = data.byteLength - (data.byteLength % wordBytes);
    carry = data.slice(whole);
    const out = new Uint8Array(whole);
    for (let i = 0; i < whole; i += wordBytes) {
      for (let k = 0; k < wordBytes; k++) out[i + k] = data[i + wordBytes - 1 - k];
    }
    return out;
  };
}

function createRawPcmToU8Transformer(options: Options): ChunkTransformerFn {
  readBitDepth(options, SIXTEEN_BIT_ONLY);
  return createAudioTransformer((_first, totalSize) => {
    requireWholeUnits(totalSize, BYTES_PER_INT16, `${PCM16_BITS}-bit samples`);
    return { dataStart: 0, dataBytes: totalSize, sink: u8Sink(NO_BYTES, false, totalSize / BYTES_PER_INT16) };
  });
}

function createRawPcmToU8WavTransformer(options: Options): ChunkTransformerFn {
  const format = readRawFormat(options, SIXTEEN_BIT_ONLY);
  const frameBytes = format.channels * BYTES_PER_INT16;
  return createAudioTransformer((_first, totalSize) => {
    requireWholeUnits(totalSize, frameBytes, 'frames');
    requireAudio(totalSize);
    const samples = totalSize / BYTES_PER_INT16;
    const header = writePcmWavHeader({ ...format, bitDepth: U8_BITS }, samples);
    return { dataStart: 0, dataBytes: totalSize, sink: u8Sink(header, true, samples) };
  });
}

function create16BitWavToU8Transformer(wrapsWav: boolean): ChunkTransformerFn {
  return createAudioTransformer((first, totalSize) => {
    const { format, dataStart, dataBytes } = readWavLayout(first, totalSize);
    if (format.isFloat || format.bitsPerSample !== PCM16_BITS) {
      throw refuse(`wav to u8 reads 16-bit integer PCM, not ${format.isFloat ? 'float' : `${format.bitsPerSample}-bit PCM`}`);
    }
    requireWholeUnits(dataBytes, format.blockAlign, 'frames');
    requireAudio(dataBytes);
    const samples = dataBytes / BYTES_PER_INT16;
    const header = wrapsWav
      ? writePcmWavHeader({ sampleRate: format.sampleRate, channels: format.channels, bitDepth: U8_BITS }, samples)
      : NO_BYTES;
    return { dataStart, dataBytes, sink: u8Sink(header, wrapsWav, samples) };
  });
}

function createWavToRawTransformer(): ChunkTransformerFn {
  return createAudioTransformer((first, totalSize) => {
    const { format, dataStart, dataBytes } = readWavLayout(first, totalSize);
    requireWholeUnits(dataBytes, format.blockAlign, 'frames');
    requireAudio(dataBytes);
    return { dataStart, dataBytes, sink: passthroughSink(NO_BYTES, 1, 0) };
  });
}

function createRawPcmToWavTransformer(options: Options): ChunkTransformerFn {
  const format = readRawFormat(options, WAV_BIT_DEPTHS);
  const frameBytes = (format.channels * format.bitDepth) / BITS_PER_BYTE;
  return createAudioTransformer((_first, totalSize) => {
    requireWholeUnits(totalSize, frameBytes, 'frames');
    requireAudio(totalSize);
    const header = writePcmWavHeader(format, totalSize);
    return { dataStart: 0, dataBytes: totalSize, sink: passthroughSink(header, frameBytes, riffPadBytes(totalSize)) };
  });
}

function refuseImaChannels(channels: number): never {
  throw refuse(`IMA ADPCM output here is 1 or 2 channels; the audio has ${channels}`);
}

/** Encodes whole frames into IMA ADPCM blocks; the last block is completed and `fact` states the true length. */
function imaEncodeSink(format: ImaFormat, frames: number): AudioSink {
  const blocks = Math.ceil(frames / format.samplesPerBlock);
  const states = newImaChannelStates(format.channels);
  const pcm = new Int16Array(format.samplesPerBlock * format.channels);
  let filled = 0;
  const encodeBlock = (count: number): Uint8Array => {
    const block = new Uint8Array(format.blockAlign);
    encodeImaBlock(pcm, count, format, states, block);
    return block;
  };
  return {
    header: writeImaWavHeader(format, frames, blocks),
    unitBytes: format.channels * BYTES_PER_INT16,
    write(units) {
      const view = new DataView(units.buffer, units.byteOffset, units.byteLength);
      const samplesPerFrame = format.channels;
      const out: Uint8Array[] = [];
      for (let at = 0; at < units.byteLength; at += samplesPerFrame * BYTES_PER_INT16) {
        for (let c = 0; c < samplesPerFrame; c++) {
          pcm[filled * samplesPerFrame + c] = view.getInt16(at + c * BYTES_PER_INT16, true);
        }
        filled++;
        if (filled === format.samplesPerBlock) {
          out.push(encodeBlock(filled));
          filled = 0;
        }
      }
      return concatBytes(out);
    },
    finish: () => (filled > 0 ? encodeBlock(filled) : NO_BYTES),
  };
}

function createWavToImaTransformer(): ChunkTransformerFn {
  return createAudioTransformer((first, totalSize) => {
    const { format, dataStart, dataBytes } = readWavLayout(first, totalSize);
    if (format.isFloat || format.bitsPerSample !== PCM16_BITS) {
      throw refuse(`IMA ADPCM is written from 16-bit integer PCM, not ${format.isFloat ? 'float' : `${format.bitsPerSample}-bit PCM`}`);
    }
    if (format.channels > IMA_MAX_CHANNELS) refuseImaChannels(format.channels);
    requireWholeUnits(dataBytes, format.blockAlign, 'frames');
    requireAudio(dataBytes);
    const ima = imaFormatFor(format.sampleRate, format.channels);
    return { dataStart, dataBytes, sink: imaEncodeSink(ima, dataBytes / format.blockAlign) };
  });
}

function createRawPcmToImaTransformer(options: Options): ChunkTransformerFn {
  const format = readRawFormat(options, SIXTEEN_BIT_ONLY);
  if (format.channels > IMA_MAX_CHANNELS) refuseImaChannels(format.channels);
  const frameBytes = format.channels * BYTES_PER_INT16;
  return createAudioTransformer((_first, totalSize) => {
    requireWholeUnits(totalSize, frameBytes, 'frames');
    requireAudio(totalSize);
    const ima = imaFormatFor(format.sampleRate, format.channels);
    return { dataStart: 0, dataBytes: totalSize, sink: imaEncodeSink(ima, totalSize / frameBytes) };
  });
}

/** Decodes IMA ADPCM blocks to 16-bit PCM, stopping at the sample count the `fact` chunk states. */
function imaDecodeSink(format: ImaFormat, frames: number, header: Uint8Array): AudioSink {
  const block = new Int16Array(format.samplesPerBlock * format.channels);
  let remaining = frames;
  return {
    header,
    unitBytes: format.blockAlign,
    write(units) {
      const blocks = units.byteLength / format.blockAlign;
      const out = new Uint8Array(Math.min(remaining, blocks * format.samplesPerBlock) * format.channels * BYTES_PER_INT16);
      const view = new DataView(out.buffer);
      let written = 0;
      for (let b = 0; b < blocks && remaining > 0; b++) {
        decodeImaBlock(units.subarray(b * format.blockAlign, (b + 1) * format.blockAlign), format, block);
        const taken = Math.min(remaining, format.samplesPerBlock);
        for (let i = 0; i < taken * format.channels; i++) view.setInt16((written + i) * BYTES_PER_INT16, block[i], true);
        written += taken * format.channels;
        remaining -= taken;
      }
      return out;
    },
    finish() {
      if (remaining !== 0) throw refuse('the IMA ADPCM data holds fewer samples than the file states');
      return NO_BYTES;
    },
  };
}

function createImaToPcmTransformer(wrapsWav: boolean): ChunkTransformerFn {
  return createAudioTransformer((first, totalSize) => {
    let factFrames: number | undefined;
    const { format, dataStart, dataBytes } = walkWavChunks(first, totalSize, parseImaFormatBody, (id, view, body, size) => {
      if (id === 'fact' && size >= BYTES_PER_INT16 * 2) factFrames = view.getUint32(body, true);
    });
    requireWholeUnits(dataBytes, format.blockAlign, 'IMA ADPCM blocks');
    requireAudio(dataBytes);
    const blocks = dataBytes / format.blockAlign;
    const available = blocks * format.samplesPerBlock;
    const frames = factFrames ?? available;
    // The stated count has to fall in the last block; a fact chunk that says otherwise describes another file.
    if (frames < 1 || frames > available || frames <= (blocks - 1) * format.samplesPerBlock) {
      throw refuse(`the fact chunk states ${frames} samples but ${blocks} blocks of ${format.samplesPerBlock} hold ${available}`);
    }
    const pcmFormat = { sampleRate: format.sampleRate, channels: format.channels, bitDepth: PCM16_BITS };
    const header = wrapsWav ? writePcmWavHeader(pcmFormat, frames * format.channels * BYTES_PER_INT16) : NO_BYTES;
    return { dataStart, dataBytes, sink: imaDecodeSink(format, frames, header) };
  });
}

interface AudioPair {
  /** Whether the pair reads a raw PCM stream, so that the options have to describe it. */
  readsRawPcm: boolean;
  build(options: Options): ChunkTransformerFn;
}

const AUDIO_PAIRS: ReadonlyMap<string, AudioPair> = new Map<string, AudioPair>([
  ['pcm:pcm_be', { readsRawPcm: true, build: createSwapTransformer }],
  ['pcm_le:pcm_be', { readsRawPcm: true, build: createSwapTransformer }],
  ['pcm_be:pcm', { readsRawPcm: true, build: createSwapTransformer }],
  ['pcm_be:pcm_le', { readsRawPcm: true, build: createSwapTransformer }],
  ['pcm:pcm_u8', { readsRawPcm: true, build: createRawPcmToU8Transformer }],
  ['pcm:u8', { readsRawPcm: true, build: createRawPcmToU8WavTransformer }],
  ['pcm:wav', { readsRawPcm: true, build: createRawPcmToWavTransformer }],
  ['pcm:adpcm', { readsRawPcm: true, build: createRawPcmToImaTransformer }],
  ['wav:pcm_u8', { readsRawPcm: false, build: () => create16BitWavToU8Transformer(false) }],
  ['wav:u8', { readsRawPcm: false, build: () => create16BitWavToU8Transformer(true) }],
  ['wav:pcm', { readsRawPcm: false, build: createWavToRawTransformer }],
  ['wav:adpcm', { readsRawPcm: false, build: createWavToImaTransformer }],
  ['adpcm:wav', { readsRawPcm: false, build: () => createImaToPcmTransformer(true) }],
  ['adpcm:pcm', { readsRawPcm: false, build: () => createImaToPcmTransformer(false) }],
]);

/** The transformer of an audio pair, or null when the pair is not an audio pair. Throws when the options fall short. */
export function resolveAudioStreamTransformer(source: string, target: string, options?: Options): ChunkTransformerFn | null {
  return AUDIO_PAIRS.get(`${source}:${target}`)?.build(options) ?? null;
}

/**
 * Whether the pair is an OPFS audio conversion that can run with these options: a raw PCM source needs the
 * options that describe it; every other audio source describes itself.
 */
export function isStreamableAudioPair(source: string, target: string, options?: Options): boolean {
  const pair = AUDIO_PAIRS.get(`${source}:${target}`);
  if (!pair) return false;
  if (!pair.readsRawPcm) return true;
  try {
    pair.build(options);
    return true;
  } catch (error) {
    if (error instanceof EdgeUnsupportedError) return false;
    throw error;
  }
}

/** Whether `source` to `target` is an audio pair of this module, whatever the options say. */
export function isAudioStreamPair(source: string, target: string): boolean {
  return AUDIO_PAIRS.has(`${source}:${target}`);
}
