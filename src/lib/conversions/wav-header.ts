import fs from 'node:fs';

/**
 * Header facts of a RIFF/WAVE file with uncompressed samples, read without a media prober: the duration and the
 * existence of one audio stream, which the ffmpeg paths need before every job. Anything this reader is not certain
 * about (another sample format, an unknown or truncated data size, a malformed chunk) answers `null`, and the caller asks
 * ffprobe instead; the reader never guesses.
 */

/** Bytes read from the start of the file; the format and data chunk headers sit in the first few hundred bytes. */
export const WAV_HEADER_SCAN_BYTES = 64 * 1024;
/** Chunks examined before giving up. */
const WAV_CHUNKS_MAX = 64;
const RIFF_HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
const FMT_PCM_MIN_BYTES = 16;
const FMT_EXTENSIBLE_MIN_BYTES = 40;
const FORMAT_PCM = 1;
const FORMAT_IEEE_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;
const EXTENSIBLE_SUBFORMAT_OFFSET = 24;
const CHANNELS_MAX = 64;
const BITS_PER_BYTE = 8;
const UNKNOWN_DATA_SIZE = 0xffffffff;

export interface WavPcmInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Bytes of sample data the data chunk declares (and the file holds). */
  dataBytes: number;
  durationSeconds: number;
}

function isPcmTag(tag: number): boolean {
  return tag === FORMAT_PCM || tag === FORMAT_IEEE_FLOAT;
}

/** Parses the header of a WAVE file held in `head` (its first bytes); `fileSize` is the size of the whole file. */
export function parseWavPcmHeader(head: Uint8Array, fileSize: number): WavPcmInfo | null {
  if (head.length < RIFF_HEADER_BYTES) return null;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const isRiff = view.getUint32(0, false) === 0x52494646; // "RIFF"
  const isWave = view.getUint32(8, false) === 0x57415645; // "WAVE"
  if (!isRiff || !isWave) return null;

  let format: { sampleRate: number; channels: number; bitsPerSample: number; blockAlign: number } | null = null;
  let offset = RIFF_HEADER_BYTES;
  for (let chunk = 0; chunk < WAV_CHUNKS_MAX && offset + CHUNK_HEADER_BYTES <= head.length; chunk++) {
    const id = view.getUint32(offset, false);
    const size = view.getUint32(offset + 4, true);
    const body = offset + CHUNK_HEADER_BYTES;
    if (id === 0x666d7420) {
      // "fmt "
      if (size < FMT_PCM_MIN_BYTES || body + FMT_PCM_MIN_BYTES > head.length) return null;
      let tag = view.getUint16(body, true);
      if (tag === FORMAT_EXTENSIBLE) {
        if (size < FMT_EXTENSIBLE_MIN_BYTES || body + FMT_EXTENSIBLE_MIN_BYTES > head.length) return null;
        tag = view.getUint16(body + EXTENSIBLE_SUBFORMAT_OFFSET, true);
      }
      if (!isPcmTag(tag)) return null;
      format = {
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        blockAlign: view.getUint16(body + 12, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === 0x64617461) {
      // "data"
      if (format === null || size === 0 || size === UNKNOWN_DATA_SIZE) return null;
      // A data chunk that runs past the end of the file is sized by the file, which only the prober decides.
      if (body + size > fileSize) return null;
      const { channels, sampleRate, bitsPerSample, blockAlign } = format;
      if (channels < 1 || channels > CHANNELS_MAX || sampleRate < 1 || bitsPerSample < BITS_PER_BYTE) return null;
      if (blockAlign !== channels * Math.ceil(bitsPerSample / BITS_PER_BYTE)) return null;
      const frames = Math.floor(size / blockAlign);
      if (frames < 1) return null;
      return { sampleRate, channels, bitsPerSample, dataBytes: size, durationSeconds: frames / sampleRate };
    }
    // Chunks are padded to an even size.
    offset = body + size + (size % 2);
  }
  return null;
}

/** Reads the PCM facts of the WAVE file at `filePath`, or null when it is not one this reader can answer exactly. */
export function readWavPcmInfo(filePath: string): WavPcmInfo | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const fileSize = fs.fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(fileSize, WAV_HEADER_SCAN_BYTES));
    const read = fs.readSync(fd, head, 0, head.length, 0);
    return parseWavPcmHeader(head.subarray(0, read), fileSize);
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}
