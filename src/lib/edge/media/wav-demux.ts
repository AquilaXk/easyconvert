/**
 * Strict RIFF/WAVE demuxer for the edge WebCodecs worker.
 *
 * It walks the chunks (RIFF: a four-character id, a little-endian size, the body, and one pad byte
 * after an odd-sized body), so LIST, fact, JUNK and any other chunk before or after `fmt ` and `data` are
 * skipped. Supported audio is integer PCM at 16, 24 or 32 bits and IEEE float at 32 bits, plain or in a
 * WAVE_FORMAT_EXTENSIBLE header. Everything else (other tags, 8-bit, 64-bit float, RF64, RIFX) throws
 * EdgeUnsupportedError, as does any chunk that runs past the file. Timestamps are computed from the frame
 * index, never from the sample bytes.
 *
 * `walkWavChunks` is the same walk over the first bytes of a file, so the OPFS streams read the header of a
 * file they cannot hold whole with the very rules that read it here.
 */

import { EdgeUnsupportedError } from '../workers/worker-errors';
import type { DemuxedMediaSample, DemuxedTrackInfo } from './media-types';

/** Chunks walked before the data chunk is found. */
export const WAV_MAX_CHUNKS = 1_024;
export const WAV_MAX_CHANNELS = 8;
export const WAV_MAX_SAMPLE_RATE = 768_000;
/** Samples (20 ms blocks) one file may be cut into. */
export const WAV_MAX_BLOCKS = 1_000_000;

const MICROS_PER_SECOND = 1_000_000;
const BLOCK_MILLIS = 20;
const MILLIS_PER_SECOND = 1_000;
const BITS_PER_BYTE = 8;
const RIFF_HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
const FMT_MIN_BYTES = 16;
const FMT_EXTENSIBLE_MIN_BYTES = 40;
const EXTENSIBLE_CB_SIZE_MIN = 22;
const UNKNOWN_DATA_SIZE = 0xffffffff;

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;
const PCM_BIT_DEPTHS: ReadonlySet<number> = new Set([16, 24, 32]);
const FLOAT_BIT_DEPTH = 32;
/**
 * The bytes after the format tag in the KSDATAFORMAT_SUBTYPE GUIDs that wrap a WAVE format tag
 * ({tag}-0000-0010-8000-00AA00389B71), starting at byte 26 of the fmt body: the zero high half of Data1, then
 * Data2, Data3 and Data4.
 */
const SUBFORMAT_TAIL_OFFSET = 26;
const SUBFORMAT_GUID_TAIL =[0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];

export function refuse(message: string): EdgeUnsupportedError {
  return new EdgeUnsupportedError(`WAV: ${message}; the server engine converts this file.`);
}

export interface WavFormat {
  isFloat: boolean;
  bitsPerSample: number;
  channels: number;
  sampleRate: number;
  blockAlign: number;
}

export function fourcc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

export function parseFormat(
  view: DataView,
  start: number,
  size: number,
  pcmBitDepths: ReadonlySet<number> = PCM_BIT_DEPTHS
): WavFormat {
  if (size < FMT_MIN_BYTES) throw refuse('the fmt chunk is too short');
  let tag = view.getUint16(start, true);
  const channels = view.getUint16(start + 2, true);
  const sampleRate = view.getUint32(start + 4, true);
  const blockAlign = view.getUint16(start + 12, true);
  const bitsPerSample = view.getUint16(start + 14, true);

  if (tag === FORMAT_EXTENSIBLE) {
    if (size < FMT_EXTENSIBLE_MIN_BYTES || view.getUint16(start + 16, true) < EXTENSIBLE_CB_SIZE_MIN) {
      throw refuse('the WAVE_FORMAT_EXTENSIBLE header is too short');
    }
    tag = view.getUint16(start + 24, true);
    const tailMatches = SUBFORMAT_GUID_TAIL.every((byte, i) => view.getUint8(start + SUBFORMAT_TAIL_OFFSET + i) === byte);
    if (!tailMatches) {
      throw refuse('the WAVE_FORMAT_EXTENSIBLE subformat is not a WAVE format tag');
    }
  }

  const isFloat = tag === FORMAT_FLOAT;
  if (tag !== FORMAT_PCM && !isFloat) throw refuse(`format tag 0x${tag.toString(16)} is not PCM or IEEE float`);
  if (isFloat && bitsPerSample !== FLOAT_BIT_DEPTH) throw refuse(`${bitsPerSample}-bit float is not read`);
  if (!isFloat && !pcmBitDepths.has(bitsPerSample)) throw refuse(`${bitsPerSample}-bit PCM is not read`);
  if (channels < 1 || channels > WAV_MAX_CHANNELS) throw refuse(`${channels} is not a supported channel count`);
  if (sampleRate < 1 || sampleRate > WAV_MAX_SAMPLE_RATE) throw refuse(`${sampleRate} Hz is not a supported sample rate`);
  const expectedAlign = (channels * bitsPerSample) / BITS_PER_BYTE;
  if (blockAlign !== expectedAlign) {
    throw refuse(`block align ${blockAlign} disagrees with ${channels} channels of ${bitsPerSample} bits`);
  }
  return { isFloat, bitsPerSample, channels, sampleRate, blockAlign };
}

function codecLabel(format: WavFormat): string {
  if (format.isFloat) return 'pcm-f32';
  return `pcm-s${format.bitsPerSample}`;
}

export interface WavChunkWalk<F> {
  format: F;
  /** Byte offset of the first audio byte. */
  dataStart: number;
  /** Bytes of audio the data chunk states (or, for an unknown length, that run to the end of the file). */
  dataBytes: number;
}

/**
 * Walks the chunks of a RIFF/WAVE file up to its data chunk. `bytes` is the file or its first bytes and
 * `fileSize` the length of the whole file; the fmt body is read by `parseFormat`. With `onChunk`, every chunk
 * between fmt and data is handed over and has to lie inside `bytes`; without it, chunks are skipped by size.
 */
export function walkWavChunks<F>(
  bytes: Uint8Array,
  fileSize: number,
  parseFormatBody: (view: DataView, start: number, size: number) => F,
  onChunk?: (id: string, view: DataView, bodyStart: number, size: number) => void
): WavChunkWalk<F> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < RIFF_HEADER_BYTES || fileSize < RIFF_HEADER_BYTES || fourcc(bytes, 0) !== 'RIFF' || fourcc(bytes, 8) !== 'WAVE') {
    throw refuse('the file is not a RIFF/WAVE file (RF64 and RIFX are not read)');
  }

  let format: F | undefined;
  let offset = RIFF_HEADER_BYTES;
  for (let chunks = 0; offset < fileSize; chunks++) {
    if (chunks >= WAV_MAX_CHUNKS) throw refuse(`more than ${WAV_MAX_CHUNKS} chunks before the audio data (chunk limit)`);
    if (fileSize - offset < CHUNK_HEADER_BYTES) throw refuse('the file ends inside a truncated chunk header');
    if (bytes.byteLength - offset < CHUNK_HEADER_BYTES) throw refuse('the header chunks run past the bytes read from the start of the file');
    const id = fourcc(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const bodyStart = offset + CHUNK_HEADER_BYTES;
    const available = fileSize - bodyStart;

    if (id === 'data') {
      if (format === undefined) throw refuse('the data chunk comes before the fmt chunk');
      // A streamed file states 0xFFFFFFFF when the length was unknown; its data then runs to the end.
      const dataBytes = size === UNKNOWN_DATA_SIZE ? available : size;
      if (dataBytes > available) throw refuse(`the data chunk of ${dataBytes} bytes runs past the end of the file`);
      return { format, dataStart: bodyStart, dataBytes };
    }
    if (size > available) throw refuse(`the ${id.trim()} chunk of ${size} bytes runs past the end of the file`);
    const insideBytes = bodyStart + size <= bytes.byteLength;
    if (id === 'fmt ') {
      if (format !== undefined) throw refuse('the file has more than one fmt chunk');
      if (!insideBytes) throw refuse('the fmt chunk runs past the bytes read from the start of the file');
      format = parseFormatBody(view, bodyStart, size);
    } else if (onChunk) {
      if (!insideBytes) throw refuse(`the ${id.trim()} chunk runs past the bytes read from the start of the file`);
      onChunk(id, view, bodyStart, size);
    }
    // Chunks are padded to an even length (RIFF); the pad byte is not part of the size.
    offset = bodyStart + size + (size % 2);
  }
  if (format === undefined) throw refuse('the file has no fmt chunk');
  throw refuse('the file has no data chunk');
}

/** Reads the PCM or IEEE float layout of a WAV file (or of its first bytes, with the length of the whole file). */
export function readWavLayout(
  bytes: Uint8Array,
  fileSize: number = bytes.byteLength,
  pcmBitDepths: ReadonlySet<number> = PCM_BIT_DEPTHS
): WavChunkWalk<WavFormat> {
  return walkWavChunks(bytes, fileSize, (view, start, size) => parseFormat(view, start, size, pcmBitDepths));
}

/** Demuxes a RIFF/WAVE file into one PCM audio track cut into 20 ms samples. */
export function demuxWav(buffer: ArrayBuffer): DemuxedTrackInfo {
  const bytes = new Uint8Array(buffer);
  const { format, dataStart, dataBytes } = readWavLayout(bytes);

  // The data is a whole number of frames; a trailing partial frame is not audio.
  const frames = Math.floor(dataBytes / format.blockAlign);
  if (frames === 0) throw refuse('the data chunk holds no audio frames');
  const framesPerBlock = Math.max(1, Math.round((format.sampleRate * BLOCK_MILLIS) / MILLIS_PER_SECOND));
  if (Math.ceil(frames / framesPerBlock) > WAV_MAX_BLOCKS) throw refuse('the audio is longer than the block limit allows');

  const samples: DemuxedMediaSample[] = [];
  for (let frame = 0; frame < frames; frame += framesPerBlock) {
    const blockFrames = Math.min(framesPerBlock, frames - frame);
    const start = dataStart + frame * format.blockAlign;
    samples.push({
      data: bytes.subarray(start, start + blockFrames * format.blockAlign),
      timestampMicros: Math.round((frame * MICROS_PER_SECOND) / format.sampleRate),
      durationMicros: Math.round((blockFrames * MICROS_PER_SECOND) / format.sampleRate),
      isKeyFrame: true,
      type: 'audio',
    });
  }

  return {
    type: 'audio',
    codec: codecLabel(format),
    timescale: format.sampleRate,
    sampleRate: format.sampleRate,
    channels: format.channels,
    samples,
  };
}
