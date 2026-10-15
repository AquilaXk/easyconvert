/**
 * A RIFF/WAVE reader written from the Microsoft RIFF and multimedia WAVE specifications for tests: it walks
 * every chunk (with the pad byte after an odd body), checks that the sizes agree with the file length, and
 * reports the fmt fields. It imports nothing from src, so it is an independent oracle for the WAV writers.
 */

export interface WalkedWav {
  riffSize: number;
  fileSize: number;
  chunkIds: string[];
  formatTag: number;
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
  /** wSamplesPerBlock of an IMA ADPCM format chunk. */
  samplesPerBlock?: number;
  cbSize?: number;
  /** dwSampleLength of the fact chunk, when present. */
  factSamples?: number;
  dataOffset: number;
  dataSize: number;
}

const RIFF_HEADER = 12;
const CHUNK_HEADER = 8;

function id(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}

/** Walks a WAVE file; throws when a size, a pad byte or the RIFF length disagrees with the file. */
export function walkWav(bytes: Uint8Array): WalkedWav {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < RIFF_HEADER || id(bytes, 0) !== 'RIFF' || id(bytes, 8) !== 'WAVE') throw new Error('wav: not RIFF/WAVE');
  const riffSize = view.getUint32(4, true);
  if (riffSize !== bytes.length - CHUNK_HEADER) {
    throw new Error(`wav: RIFF size ${riffSize} != file size ${bytes.length} - 8`);
  }
  const found: Partial<WalkedWav> = { riffSize, fileSize: bytes.length, chunkIds: [] };
  const chunkIds: string[] = [];
  let at = RIFF_HEADER;
  while (at < bytes.length) {
    if (bytes.length - at < CHUNK_HEADER) throw new Error('wav: truncated chunk header');
    const chunkId = id(bytes, at);
    const size = view.getUint32(at + 4, true);
    const body = at + CHUNK_HEADER;
    if (body + size > bytes.length) throw new Error(`wav: ${chunkId} chunk runs past the end of the file`);
    chunkIds.push(chunkId);
    if (chunkId === 'fmt ') {
      found.formatTag = view.getUint16(body, true);
      found.channels = view.getUint16(body + 2, true);
      found.sampleRate = view.getUint32(body + 4, true);
      found.byteRate = view.getUint32(body + 8, true);
      found.blockAlign = view.getUint16(body + 12, true);
      found.bitsPerSample = view.getUint16(body + 14, true);
      if (size >= 18) found.cbSize = view.getUint16(body + 16, true);
      if (size >= 20) found.samplesPerBlock = view.getUint16(body + 18, true);
    } else if (chunkId === 'fact') {
      found.factSamples = view.getUint32(body, true);
    } else if (chunkId === 'data') {
      found.dataOffset = body;
      found.dataSize = size;
    }
    const padded = size + (size % 2);
    if (body + padded > bytes.length) throw new Error(`wav: ${chunkId} pad byte is missing`);
    at = body + padded;
  }
  if (found.dataOffset === undefined || found.formatTag === undefined) throw new Error('wav: no fmt or data chunk');
  found.chunkIds = chunkIds;
  return found as WalkedWav;
}
