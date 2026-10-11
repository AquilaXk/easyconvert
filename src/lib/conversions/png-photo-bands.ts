import zlib from 'node:zlib';
import { ConversionFailedError } from '../types';
import { getCpuPool, runCpuTask } from '../workers/cpu-pool';
import { crc32 } from './crc32';

/**
 * Parallel writer for 16-bit photographic PNGs (PNG Third Edition, W3C, sections 7 and 12.8).
 *
 * The image library writes the picture once with stored (uncompressed) deflate blocks, which carries every chunk its
 * pipeline decided on (colour profile, EXIF, resolution) and the scanlines in PNG byte order. This module reads the
 * scanlines back, filters each row with the filter that has the smallest sum of absolute differences (the heuristic
 * of the specification, evaluated on a centred window of the row), and compresses horizontal bands of rows on pool
 * threads. Every band is a raw deflate segment ending in a sync flush, so the segments join into one zlib stream; the
 * Adler-32 of the whole stream is combined from the sums of the bands.
 */

const PNG_SIGNATURE_BYTES = 8;
const CHUNK_OVERHEAD_BYTES = 12;
const CHUNK_TYPE_OFFSET = 4;
const CHUNK_DATA_OFFSET = 8;
const IHDR_WIDTH_OFFSET = 0;
const IHDR_HEIGHT_OFFSET = 4;
const IHDR_DEPTH_OFFSET = 8;
const IHDR_COLOUR_TYPE_OFFSET = 9;
const IHDR_INTERLACE_OFFSET = 12;
const SIXTEEN_BITS = 16;
const BYTES_PER_SAMPLE = 2;
const ZLIB_HEADER = Uint8Array.of(0x78, 0x9c);
const STORED_BLOCK_HEADER_BYTES = 5;
const STORED_FINAL_FLAG = 1;
const STORED_TYPE_MASK = 6;
const ADLER_BASE = 65521;
const ADLER_NMAX = 5552;
const ADLER_BYTES = 4;
const BAND_ROWS_TARGET = 128;
const MAX_BANDS = 16;
const IDAT = 'IDAT';
const SAMPLES_OF_COLOUR_TYPE: Readonly<Record<number, number>> = { 0: 1, 2: 3, 4: 2, 6: 4 };

const FILTER_NONE = 0;
const FILTER_SUB = 1;
const FILTER_UP = 2;
const FILTER_AVERAGE = 3;
const FILTER_PAETH = 4;
const BYTE_MASK = 0xff;
const SIGNED_SPLIT = 128;
const BYTE_RADIX = 256;
/** Share of a row (an eighth) the filter choice reads, from its middle; the chosen filter is applied to the whole row. */
const WINDOW_DIVISOR = 8;
const MIN_WINDOW_PIXELS = 64;

/** |v| of a byte read as signed: the weight a filtered byte adds to the cost of a row. */
const MAGNITUDE = new Uint8Array(BYTE_RADIX);
for (let v = 0; v < BYTE_RADIX; v++) MAGNITUDE[v] = v < SIGNED_SPLIT ? v : BYTE_RADIX - v;

export interface PngBandLayout {
  /** Bytes of one row without its filter byte. */
  rowBytes: number;
  /** Bytes of one pixel. */
  bytesPerPixel: number;
  height: number;
}

/** What a pool thread is asked to do: filter and compress rows [firstRow, endRow) of the scanlines. */
export interface PngBandPayload extends PngBandLayout {
  /** The scanlines (filter byte 0 and the row, for every row) in memory shared with the calling thread. */
  scanlines: Uint8Array;
  firstRow: number;
  endRow: number;
}

export interface PngBandResult {
  /** A raw deflate segment of the filtered rows: a sync flush at its end, and the final block for the last band. */
  deflate: Uint8Array;
  /** Adler-32 of the filtered rows (filter bytes included) of this band. */
  adler: number;
  filteredBytes: number;
}

function png16Failure(message: string): ConversionFailedError {
  return new ConversionFailedError(`16-bit PNG: ${message}`);
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  const length = bytes.length;
  for (let at = 0; at < length; ) {
    const end = Math.min(at + ADLER_NMAX, length);
    for (; at < end; at++) {
      a += bytes[at];
      b += a;
    }
    a %= ADLER_BASE;
    b %= ADLER_BASE;
  }
  return ((b << 16) | a) >>> 0;
}

/** Adler-32 of two consecutive runs from the sums of each (the combination zlib uses; `length2` is the second run's length). */
export function combineAdler32(adler1: number, adler2: number, length2: number): number {
  const remainder = length2 % ADLER_BASE;
  let sum1 = adler1 & 0xffff;
  let sum2 = (remainder * sum1) % ADLER_BASE;
  sum1 += (adler2 & 0xffff) + ADLER_BASE - 1;
  sum2 += ((adler1 >>> 16) & 0xffff) + ((adler2 >>> 16) & 0xffff) + ADLER_BASE - remainder;
  if (sum1 >= ADLER_BASE) sum1 -= ADLER_BASE;
  if (sum1 >= ADLER_BASE) sum1 -= ADLER_BASE;
  if (sum2 >= ADLER_BASE * 2) sum2 -= ADLER_BASE * 2;
  if (sum2 >= ADLER_BASE) sum2 -= ADLER_BASE;
  return ((sum2 << 16) | sum1) >>> 0;
}

/**
 * Filters rows [firstRow, endRow) of `scanlines` (stride rowBytes + 1; the byte at the start of a row is its filter type,
 * written as the rows are filtered) into a new array. A row's filter is the one with the smallest sum of absolute
 * differences over a centred window of the row; ties go to the lower filter number, as in libpng.
 */
export function filterBand(layout: PngBandLayout, scanlines: Uint8Array, firstRow: number, endRow: number): Uint8Array {
  const { rowBytes, bytesPerPixel: bpp } = layout;
  const stride = rowBytes + 1;
  const out = new Uint8Array((endRow - firstRow) * stride);
  const zeroRow = new Uint8Array(rowBytes);
  const windowPixels = Math.max(MIN_WINDOW_PIXELS, Math.floor(rowBytes / bpp / WINDOW_DIVISOR));
  const windowBytes = Math.min(rowBytes - bpp, windowPixels * bpp);
  // The window starts on a pixel boundary after the first pixel, so every byte in it has a left neighbour.
  const windowStart = Math.max(bpp, Math.floor((rowBytes - windowBytes) / 2 / bpp) * bpp);
  const windowEnd = Math.min(rowBytes, windowStart + windowBytes);
  const magnitude = MAGNITUDE;

  for (let y = firstRow; y < endRow; y++) {
    const row = y * stride + 1;
    const above = y > 0 ? row - stride : 0;
    const prev = y > 0 ? scanlines : zeroRow;
    let costNone = 0;
    let costSub = 0;
    let costUp = 0;
    let costAverage = 0;
    let costPaeth = 0;
    for (let i = windowStart; i < windowEnd; i++) {
      const x = scanlines[row + i];
      const a = scanlines[row + i - bpp];
      const b = prev[above + i];
      const c = prev[above + i - bpp];
      costNone += magnitude[x];
      costSub += magnitude[(x - a) & BYTE_MASK];
      costUp += magnitude[(x - b) & BYTE_MASK];
      costAverage += magnitude[(x - ((a + b) >> 1)) & BYTE_MASK];
      const p = a + b - c;
      const pa = p > a ? p - a : a - p;
      const pb = p > b ? p - b : b - p;
      const pc = p > c ? p - c : c - p;
      let predictor = c;
      if (pa <= pb && pa <= pc) predictor = a;
      else if (pb <= pc) predictor = b;
      costPaeth += magnitude[(x - predictor) & BYTE_MASK];
    }
    let filter = FILTER_NONE;
    let best = costNone;
    if (costSub < best) {
      filter = FILTER_SUB;
      best = costSub;
    }
    if (costUp < best) {
      filter = FILTER_UP;
      best = costUp;
    }
    if (costAverage < best) {
      filter = FILTER_AVERAGE;
      best = costAverage;
    }
    if (costPaeth < best) filter = FILTER_PAETH;

    const target = (y - firstRow) * stride;
    out[target] = filter;
    const o = target + 1;
    switch (filter) {
      case FILTER_NONE:
        out.set(scanlines.subarray(row, row + rowBytes), o);
        break;
      case FILTER_SUB:
        for (let i = 0; i < bpp; i++) out[o + i] = scanlines[row + i];
        for (let i = bpp; i < rowBytes; i++) out[o + i] = scanlines[row + i] - scanlines[row + i - bpp];
        break;
      case FILTER_UP:
        for (let i = 0; i < rowBytes; i++) out[o + i] = scanlines[row + i] - prev[above + i];
        break;
      case FILTER_AVERAGE:
        for (let i = 0; i < bpp; i++) out[o + i] = scanlines[row + i] - (prev[above + i] >> 1);
        for (let i = bpp; i < rowBytes; i++) out[o + i] = scanlines[row + i] - ((scanlines[row + i - bpp] + prev[above + i]) >> 1);
        break;
      default:
        for (let i = 0; i < bpp; i++) out[o + i] = scanlines[row + i] - prev[above + i];
        for (let i = bpp; i < rowBytes; i++) {
          const a = scanlines[row + i - bpp];
          const b = prev[above + i];
          const c = prev[above + i - bpp];
          const p = a + b - c;
          const pa = p > a ? p - a : a - p;
          const pb = p > b ? p - b : b - p;
          const pc = p > c ? p - c : c - p;
          let predictor = c;
          if (pa <= pb && pa <= pc) predictor = a;
          else if (pb <= pc) predictor = b;
          out[o + i] = scanlines[row + i] - predictor;
        }
    }
  }
  return out;
}

/** The task of one pool thread: filter a band, compress it as a segment of the shared deflate stream. */
export function encodePngBand(payload: PngBandPayload): PngBandResult {
  const filtered = filterBand(payload, payload.scanlines, payload.firstRow, payload.endRow);
  const last = payload.endRow === payload.height;
  const deflate = zlib.deflateRawSync(filtered, {
    strategy: zlib.constants.Z_RLE,
    finishFlush: last ? zlib.constants.Z_FINISH : zlib.constants.Z_SYNC_FLUSH,
  });
  return { deflate, adler: adler32(filtered), filteredBytes: filtered.length };
}

/** Rows read at each of the places of the picture that decide whether run-length matching is enough. */
const PROBE_ROWS = 16;
const PROBE_PLACES: readonly number[] = [1 / 6, 1 / 2, 5 / 6];
/** Run-length matching is kept while it writes at most this much more than string matching on the probe. */
const RUN_LENGTH_TOLERANCE = 1.02;
const PROBE_MATCHING_LEVEL = 1;

/**
 * Run-length matching with Huffman coding is about three times faster than string matching and writes the same bytes
 * when the filtered rows are sensor noise (the low byte of a 16-bit photograph), which string matching cannot use. A
 * picture with structure (smooth areas, repeated texture) is smaller with string matching, and the general encoder
 * writes it better. A sample of rows from three places of the picture says which kind this is.
 */
function isNoiseDominated(layout: PngBandLayout, scanlines: Uint8Array): boolean {
  const stride = layout.rowBytes + 1;
  const rows = Math.min(PROBE_ROWS, layout.height);
  const sample = new Uint8Array(PROBE_PLACES.length * rows * stride);
  PROBE_PLACES.forEach((place, index) => {
    const first = Math.min(layout.height - rows, Math.floor(layout.height * place));
    sample.set(filterBand(layout, scanlines, first, first + rows), index * rows * stride);
  });
  const runLength = zlib.deflateRawSync(sample, { strategy: zlib.constants.Z_RLE }).length;
  const matched = zlib.deflateRawSync(sample, { level: PROBE_MATCHING_LEVEL, strategy: zlib.constants.Z_FILTERED }).length;
  return runLength <= matched * RUN_LENGTH_TOLERANCE;
}

interface PngChunk {
  type: string;
  /** The whole chunk as written: length, type, data and CRC. */
  bytes: Uint8Array;
  data: Uint8Array;
}

function readChunks(png: Uint8Array): PngChunk[] {
  const chunks: PngChunk[] = [];
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  for (let at = PNG_SIGNATURE_BYTES; at < png.length; ) {
    if (at + CHUNK_OVERHEAD_BYTES > png.length) throw png16Failure('the picture ends inside a chunk');
    const length = view.getUint32(at);
    const end = at + CHUNK_OVERHEAD_BYTES + length;
    if (end > png.length) throw png16Failure('the picture ends inside a chunk');
    chunks.push({
      type: Buffer.from(png.subarray(at + CHUNK_TYPE_OFFSET, at + CHUNK_DATA_OFFSET)).toString('latin1'),
      bytes: png.subarray(at, end),
      data: png.subarray(at + CHUNK_DATA_OFFSET, at + CHUNK_DATA_OFFSET + length),
    });
    at = end;
  }
  return chunks;
}

/** Joins the stored (uncompressed) deflate blocks of the zlib stream in `idat` into `target`; returns the bytes written. */
function copyStoredPayload(idat: PngChunk[], target: Uint8Array): number {
  const stream = idat.length === 1 ? idat[0].data : Buffer.concat(idat.map((chunk) => chunk.data));
  let at = 2;
  let written = 0;
  for (;;) {
    if (at + STORED_BLOCK_HEADER_BYTES > stream.length) throw png16Failure('the stored pixel stream ends inside a block');
    const header = stream[at];
    if ((header & STORED_TYPE_MASK) !== 0) throw png16Failure('the pixel stream is not stored');
    const length = stream[at + 1] | (stream[at + 2] << 8);
    at += STORED_BLOCK_HEADER_BYTES;
    if (at + length > stream.length || written + length > target.length) throw png16Failure('the stored pixel stream does not match the picture size');
    target.set(stream.subarray(at, at + length), written);
    written += length;
    at += length;
    if ((header & STORED_FINAL_FLAG) !== 0) return written;
  }
}

function chunkOf(type: string, parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(CHUNK_OVERHEAD_BYTES + length);
  const view = new DataView(out.buffer);
  view.setUint32(0, length);
  out.set(Buffer.from(type, 'latin1'), CHUNK_TYPE_OFFSET);
  let at = CHUNK_DATA_OFFSET;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  view.setUint32(at, crc32(out.subarray(CHUNK_TYPE_OFFSET, at)));
  return out;
}

/**
 * Rewrites a 16-bit PNG whose pixels are stored uncompressed (the image library at compression level 0) as a filtered,
 * compressed one. Every chunk other than IDAT is kept as it is, in its place. Returns null for a picture with structure,
 * which string matching writes smaller than this writer does (see `isNoiseDominated`): the caller encodes that one with
 * the general encoder.
 */
export async function recompressStoredPng16(stored: Uint8Array, options: { signal?: AbortSignal } = {}): Promise<Buffer | null> {
  const chunks = readChunks(stored);
  const header = chunks[0];
  if (header?.type !== 'IHDR' || header.data.length !== 13) throw png16Failure('the picture has no header');
  const view = new DataView(header.data.buffer, header.data.byteOffset, header.data.byteLength);
  const width = view.getUint32(IHDR_WIDTH_OFFSET);
  const height = view.getUint32(IHDR_HEIGHT_OFFSET);
  const samples = SAMPLES_OF_COLOUR_TYPE[header.data[IHDR_COLOUR_TYPE_OFFSET]];
  if (header.data[IHDR_DEPTH_OFFSET] !== SIXTEEN_BITS || samples === undefined || header.data[IHDR_INTERLACE_OFFSET] !== 0) {
    throw png16Failure('only a non-interlaced greyscale, grey-alpha, RGB or RGBA picture of 16 bits per sample is rewritten');
  }
  const bytesPerPixel = samples * BYTES_PER_SAMPLE;
  const layout: PngBandLayout = { rowBytes: width * bytesPerPixel, bytesPerPixel, height };
  const scanlines = new Uint8Array(new SharedArrayBuffer((layout.rowBytes + 1) * height));
  const written = copyStoredPayload(
    chunks.filter((chunk) => chunk.type === IDAT),
    scanlines
  );
  if (written !== scanlines.length) throw png16Failure('the stored pixel stream does not match the picture size');
  if (!isNoiseDominated(layout, scanlines)) return null;

  const bands = Math.min(MAX_BANDS, Math.max(getCpuPool().threadLimit, Math.ceil(height / BAND_ROWS_TARGET)));
  const rowsPerBand = Math.ceil(height / bands);
  const tasks: Promise<PngBandResult>[] = [];
  for (let firstRow = 0; firstRow < height; firstRow += rowsPerBand) {
    const payload: PngBandPayload = { ...layout, scanlines, firstRow, endRow: Math.min(height, firstRow + rowsPerBand) };
    tasks.push(runCpuTask<PngBandResult>('pngBand', payload, { signal: options.signal }));
  }
  const results = await Promise.all(tasks);

  let adler = results[0].adler;
  for (const result of results.slice(1)) adler = combineAdler32(adler, result.adler, result.filteredBytes);
  const trailer = new Uint8Array(ADLER_BYTES);
  new DataView(trailer.buffer).setUint32(0, adler);

  const pieces: Uint8Array[] = [stored.subarray(0, PNG_SIGNATURE_BYTES)];
  let placed = false;
  for (const chunk of chunks) {
    if (chunk.type !== IDAT) {
      pieces.push(chunk.bytes);
      continue;
    }
    if (placed) continue;
    placed = true;
    results.forEach((result, index) => {
      const deflate = Buffer.from(result.deflate.buffer, result.deflate.byteOffset, result.deflate.byteLength);
      const parts: Uint8Array[] = [deflate];
      if (index === 0) parts.unshift(ZLIB_HEADER);
      if (index === results.length - 1) parts.push(trailer);
      pieces.push(chunkOf(IDAT, parts));
    });
  }
  return Buffer.concat(pieces);
}
