import zlib from 'node:zlib';
import type { RawDecodable } from './image-jxl-metadata';

/**
 * The picture `djxl` decodes, taken as raw samples instead of as the PNG it compresses.
 *
 * Writing the PNG is most of the decoder's time: libjxl decodes a 1024 x 631 picture in 22 ms on four threads and then spends 100 ms
 * compressing it on one (arm64 Linux VM; `djxl` 0.7.0), and the image pipeline inflates the file again right after. The same decoder
 * writes a Netpbm file (PPM, or PAM with an alpha channel) of the very same samples in the time of the decode. What a Netpbm file leaves
 * out is the PNG's colour chunks (`iCCP`, `cICP`, ...), which change the file the pipeline writes, so they are kept: they depend on the
 * colour encoding in the metadata of the codestream and on nothing else, and the first picture of each metadata (image-jxl-metadata.ts)
 * is decoded the usual way, which says what the decoder writes for it. Every later picture with the same metadata takes the samples from
 * the Netpbm file and gets the same chunks. The pipeline then reads a PNG whose pixels and chunks are the ones of the decoder's PNG, in
 * a deflate stream of stored blocks (RFC 1951 section 3.2.4), which costs a copy and a checksum instead of a compression.
 *
 * Anything that is not as expected (a header that is not the one the metadata promised, a chunk besides the colour ones in the decoder's
 * PNG, a sample depth other than 8 or 16) leaves the picture to the PNG the decoder writes.
 *
 * Sources: the stored-block layout and the adler32 follow RFC 1950 and RFC 1951 and zlib's `adler32.c` (github.com/madler/zlib, tag
 * v1.3.1 = commit 51b7f2abdade, zlib License): the base 65521 and the 5552 bytes (`NMAX`) that fit before the sums are reduced. The
 * decoder's Netpbm output is libjxl's own (`lib/extras/enc/pnm.cc` of the `djxl` in the distribution).
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHUNK_HEADER_BYTES = 8;
const CHUNK_OVERHEAD_BYTES = 12;
const IHDR_DATA_BYTES = 13;
const IHDR_DEPTH_OFFSET = 8;
const IHDR_COLOUR_TYPE_OFFSET = 9;
/** The chunks the decoder writes from the colour encoding of a picture, and that a Netpbm file does not have. */
const COLOUR_CHUNKS: ReadonlySet<string> = new Set(['iCCP', 'cICP', 'sRGB', 'gAMA', 'cHRM']);
const IEND_CHUNK = Buffer.from('0000000049454e44ae426082', 'hex');
const COLOUR_TYPE_RGB = 2;
const COLOUR_TYPE_RGB_ALPHA = 6;

const ZLIB_HEADER = Buffer.from([0x78, 0x01]);
/** A stored block holds at most 65535 bytes (RFC 1951): the final-block flag, its length, the length's complement. */
const STORED_BLOCK_MAX_BYTES = 0xffff;
const STORED_BLOCK_HEADER_BYTES = 5;
const ZLIB_TRAILER_BYTES = 4;
const CRC_BYTES = 4;
/** Largest data length of one PNG chunk. */
const MAX_CHUNK_BYTES = 0x7fffffff;
/** The most bytes the adler sums can take before their 32-bit accumulators overflow (zlib `NMAX`). */
const ADLER_BLOCK = 5552;
const ADLER_MODULUS = 65521;

/** The colour chunks of the PNG the decoder wrote for a given metadata. */
interface LearnedPng {
  chunks: Buffer;
  bitDepth: number;
  colourType: number;
}

const MAX_LEARNED = 64;
const learned = new Map<string, LearnedPng>();

const cacheKey = (decoder: string, plan: RawDecodable): string => `${decoder}\0${plan.metadataBits}`;

/** What the decoder's PNG says about the metadata it came from: its colour chunks, in order; null when it holds anything else or has them out of place. */
function learnPng(png: Buffer): LearnedPng | null {
  if (png.length < PNG_SIGNATURE.length || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;
  const kept: Buffer[] = [];
  let header: Buffer | null = null;
  let seenData = false;
  for (let at = PNG_SIGNATURE.length; at + CHUNK_OVERHEAD_BYTES <= png.length; ) {
    const length = png.readUInt32BE(at);
    const end = at + CHUNK_OVERHEAD_BYTES + length;
    if (end > png.length) return null;
    const type = png.toString('latin1', at + 4, at + CHUNK_HEADER_BYTES);
    if (header === null) {
      if (type !== 'IHDR' || length !== IHDR_DATA_BYTES) return null;
      header = png.subarray(at + CHUNK_HEADER_BYTES, at + CHUNK_HEADER_BYTES + IHDR_DATA_BYTES);
    } else if (type === 'IDAT') {
      seenData = true;
    } else if (type === 'IEND') {
      return seenData ? { chunks: Buffer.concat(kept), bitDepth: header[IHDR_DEPTH_OFFSET], colourType: header[IHDR_COLOUR_TYPE_OFFSET] } : null;
    } else if (COLOUR_CHUNKS.has(type) && !seenData) {
      kept.push(png.subarray(at, end));
    } else {
      return null;
    }
    at = end;
  }
  return null;
}

/** Remembers what the decoder's PNG says about `plan`'s metadata, for the pictures that come after it; a PNG that holds more than colour chunks teaches nothing. */
export function learnFromDecoderPng(decoder: string, plan: RawDecodable, png: Buffer): void {
  const lesson = learnPng(png);
  if (lesson === null) return;
  if (learned.size >= MAX_LEARNED) learned.delete(learned.keys().next().value as string);
  learned.set(cacheKey(decoder, plan), lesson);
}

/** Whether the decoder's PNG for `plan`'s metadata is known, so that the next picture with them can be taken as raw samples. */
export function hasLearnedPng(decoder: string, plan: RawDecodable): boolean {
  return learned.has(cacheKey(decoder, plan));
}

/** The name of the Netpbm file the decoder is asked for: PPM has no alpha channel (a newer decoder drops it there), PAM has. */
export const rawOutputName = (plan: RawDecodable, base: string): string => `${base}.${plan.alpha ? 'pam' : 'ppm'}`;

interface Netpbm {
  width: number;
  height: number;
  channels: number;
  maxValue: number;
  /** Where the samples start. */
  offset: number;
}

const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);

/** The header of a binary PPM (`P6`) or PAM (`P7`, with the tuple type RGB_ALPHA) file, or null when it is anything else. */
function readNetpbm(file: Buffer, alpha: boolean): Netpbm | null {
  const text = file.toString('latin1', 0, Math.min(file.length, 256));
  if (alpha) {
    const header = /^P7\n((?:[A-Z_]+ [^\n]*\n|#[^\n]*\n)*)ENDHDR\n/.exec(text);
    if (header === null) return null;
    const fields = new Map<string, string>();
    for (const line of header[1].split('\n')) if (line !== '' && line[0] !== '#') fields.set(line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1));
    if (fields.get('DEPTH') !== '4' || fields.get('TUPLTYPE') !== 'RGB_ALPHA') return null;
    return { width: Number(fields.get('WIDTH')), height: Number(fields.get('HEIGHT')), channels: 4, maxValue: Number(fields.get('MAXVAL')), offset: header[0].length };
  }
  const header = /^P6\s+(\d+)\s+(\d+)\s+(\d+)[ \t\r\n]/.exec(text);
  if (header === null || !WHITESPACE.has(file[header[0].length - 1])) return null;
  return { width: Number(header[1]), height: Number(header[2]), channels: 3, maxValue: Number(header[3]), offset: header[0].length };
}

/** The adler32 (RFC 1950) of `bytes[from, to)` continued from `adler`; the accumulators are reduced once per `ADLER_BLOCK` bytes. */
function adler32(adler: number, bytes: Uint8Array, from: number, to: number): number {
  let low = adler & 0xffff;
  let high = adler >>> 16;
  for (let at = from; at < to; ) {
    const stop = Math.min(at + ADLER_BLOCK, to);
    for (; at < stop; at += 1) {
      low += bytes[at];
      high += low;
    }
    low %= ADLER_MODULUS;
    high %= ADLER_MODULUS;
  }
  return ((high << 16) | low) >>> 0;
}

const chunkOf = (type: string, data: Buffer): Buffer => {
  const chunk = Buffer.alloc(CHUNK_OVERHEAD_BYTES + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 'latin1');
  data.copy(chunk, CHUNK_HEADER_BYTES);
  chunk.writeUInt32BE(zlib.crc32(chunk.subarray(4, CHUNK_HEADER_BYTES + data.length)), CHUNK_HEADER_BYTES + data.length);
  return chunk;
};

/**
 * Writes the scanlines of `file` (`height` rows of `rowBytes` bytes from `offset`), each with a filter byte of 0 in front, as stored
 * deflate blocks at `at`; returns where they end and the adler32 of the filtered data.
 */
function writeStoredBlocks(png: Buffer, at: number, file: Buffer, offset: number, rowBytes: number, height: number): { end: number; adler: number } {
  const scanline = rowBytes + 1;
  const filteredBytes = scanline * height;
  let out = at;
  let adler = 1;
  for (let sent = 0; sent < filteredBytes; ) {
    const length = Math.min(STORED_BLOCK_MAX_BYTES, filteredBytes - sent);
    png[out] = sent + length === filteredBytes ? 1 : 0;
    png.writeUInt16LE(length, out + 1);
    png.writeUInt16LE(~length & 0xffff, out + 3);
    out += STORED_BLOCK_HEADER_BYTES;
    const blockStart = out;
    for (let filtered = sent; filtered < sent + length; ) {
      const row = Math.floor(filtered / scanline);
      const column = filtered - row * scanline;
      if (column === 0) {
        png[out] = 0;
        out += 1;
        filtered += 1;
      } else {
        const from = offset + row * rowBytes + column - 1;
        const run = Math.min(scanline - column, sent + length - filtered);
        out += file.copy(png, out, from, from + run);
        filtered += run;
      }
    }
    adler = adler32(adler, png, blockStart, out);
    sent += length;
  }
  return { end: out, adler };
}

/**
 * The PNG for the samples of a Netpbm file `djxl` wrote: the colour chunks of the PNG it writes for the same metadata, then the
 * samples in stored deflate blocks. Null when the file is not the picture `plan` and `expectedPixels` describe, or when no PNG of this
 * metadata has been seen.
 */
export function pngFromNetpbm(decoder: string, plan: RawDecodable, file: Buffer, expectedPixels: number): Buffer | null {
  const lesson = learned.get(cacheKey(decoder, plan));
  const netpbm = readNetpbm(file, plan.alpha);
  if (lesson === undefined || netpbm === null) return null;
  const { width, height, channels, maxValue, offset } = netpbm;
  const bytesPerSample = plan.bitsPerSample / 8;
  const expectedMaxValue = 2 ** plan.bitsPerSample - 1;
  const colourType = plan.alpha ? COLOUR_TYPE_RGB_ALPHA : COLOUR_TYPE_RGB;
  if (maxValue !== expectedMaxValue || lesson.bitDepth !== plan.bitsPerSample || lesson.colourType !== colourType) return null;
  if (width * height !== expectedPixels || file.length !== offset + width * height * channels * bytesPerSample) return null;
  const rowBytes = width * channels * bytesPerSample;
  const filteredBytes = (rowBytes + 1) * height;
  const blocks = Math.ceil(filteredBytes / STORED_BLOCK_MAX_BYTES);
  const dataBytes = ZLIB_HEADER.length + blocks * STORED_BLOCK_HEADER_BYTES + filteredBytes + ZLIB_TRAILER_BYTES;
  if (dataBytes > MAX_CHUNK_BYTES) return null;

  const header = Buffer.alloc(IHDR_DATA_BYTES);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[IHDR_DEPTH_OFFSET] = plan.bitsPerSample;
  header[IHDR_COLOUR_TYPE_OFFSET] = colourType;
  const prefix = Buffer.concat([PNG_SIGNATURE, chunkOf('IHDR', header), lesson.chunks]);
  const png = Buffer.allocUnsafe(prefix.length + CHUNK_OVERHEAD_BYTES + dataBytes + IEND_CHUNK.length);
  let out = prefix.copy(png, 0);
  const dataStart = out + CHUNK_HEADER_BYTES;
  png.writeUInt32BE(dataBytes, out);
  png.write('IDAT', out + 4, 'latin1');
  out = dataStart + ZLIB_HEADER.copy(png, dataStart);
  const stored = writeStoredBlocks(png, out, file, offset, rowBytes, height);
  out = stored.end;
  png.writeUInt32BE(stored.adler, out);
  out += ZLIB_TRAILER_BYTES;
  png.writeUInt32BE(zlib.crc32(png.subarray(dataStart - 4, out)), out);
  out += CRC_BYTES;
  IEND_CHUNK.copy(png, out);
  return png;
}
