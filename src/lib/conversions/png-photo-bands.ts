import os from 'node:os';
import zlib from 'node:zlib';
import { ConversionFailedError } from '../types';
import { getCpuPool, runCpuTask } from '../workers/cpu-pool';
import { crc32 } from './crc32';

/**
 * Parallel writer for 16-bit photographic PNGs (PNG Third Edition, W3C, sections 7 and 12.8).
 *
 * The caller hands over the samples of the picture (as the image library's raw output returns them) and a template: a tiny
 * PNG written by the same pipeline, which carries every chunk the pipeline decided on (colour profile, EXIF, resolution).
 * This module chooses one filter for the picture, the one with the smallest sum of absolute differences on sample rows (the
 * heuristic of the specification), applies it to every row, and compresses horizontal bands of rows on pool threads.
 * Every band is a raw deflate segment ending in a sync flush, so the segments join into one zlib stream; the Adler-32 of
 * the whole stream is combined from the sums of the bands.
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
const IHDR_BYTES = 13;
const COLOUR_TYPE_OF_CHANNELS: Readonly<Record<number, number>> = { 1: 0, 2: 4, 3: 2, 4: 6 };
const ADLER_BASE = 65521;
const ADLER_BYTES = 4;
const BAND_ROWS_TARGET = 128;
const MAX_BANDS = 16;
const IDAT = 'IDAT';

const FILTER_NONE = 0;
const FILTER_SUB = 1;
const FILTER_UP = 2;
const FILTER_AVERAGE = 3;
const FILTER_PAETH = 4;
const BYTE_MASK = 0xff;
const SIGNED_SPLIT = 128;
const BYTE_RADIX = 256;

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
  /** The filter type applied to every row of the picture. */
  filter: number;
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

/**
 * Adler-32 of `bytes`, from the trailer of a zlib stream of stored blocks: the library computes it at memory speed, where a
 * loop in script costs as much as the compression of the same bytes.
 */
function adler32(bytes: Uint8Array): number {
  const stream = zlib.deflateSync(bytes, { level: 0 });
  return stream.readUInt32BE(stream.length - ADLER_BYTES);
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

/** Rows of one picture filtered by the same filter type are cheapest for Sub, Up and Average; Paeth is chosen when it saves at least 1%. */
const PAETH_PENALTY = 1.01;

/** |Paeth predictor error| inputs: the predictor of PNG (section 9.4) for left a, above b and above-left c. */
function paethPredictor(a: number, b: number, c: number): number {
  const pa = b > c ? b - c : c - b;
  const pb = a > c ? a - c : c - a;
  const pc = a + b - 2 * c;
  const pcAbs = pc < 0 ? -pc : pc;
  if (pa <= pb && pa <= pcAbs) return a;
  return pb <= pcAbs ? b : c;
}

/**
 * Filters rows [firstRow, endRow) of `scanlines` (stride rowBytes + 1; the byte at the start of a row is its filter type) with
 * the filter `filter` into a new array that holds the filter byte and the filtered row of each.
 */
export function filterBand(layout: PngBandLayout, scanlines: Uint8Array, firstRow: number, endRow: number, filter: number): Uint8Array {
  const { rowBytes, bytesPerPixel: bpp } = layout;
  const stride = rowBytes + 1;
  const out = new Uint8Array((endRow - firstRow) * stride);
  const zeroRow = new Uint8Array(rowBytes);
  for (let y = firstRow; y < endRow; y++) {
    const row = y * stride + 1;
    const above = y > 0 ? row - stride : 0;
    const prev = y > 0 ? scanlines : zeroRow;
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
      case FILTER_PAETH:
        for (let i = 0; i < bpp; i++) out[o + i] = scanlines[row + i] - prev[above + i];
        for (let i = bpp; i < rowBytes; i++) out[o + i] = scanlines[row + i] - paethPredictor(scanlines[row + i - bpp], prev[above + i], prev[above + i - bpp]);
        break;
      default:
        throw png16Failure(`filter type ${filter} does not exist`);
    }
  }
  return out;
}

/** The sum of the absolute values (bytes read as signed) of the rows [firstRow, endRow) filtered with `filter`. */
function filterCost(layout: PngBandLayout, scanlines: Uint8Array, firstRow: number, endRow: number, filter: number): number {
  const filtered = filterBand(layout, scanlines, firstRow, endRow, filter);
  const stride = layout.rowBytes + 1;
  let cost = 0;
  for (let row = 0; row < endRow - firstRow; row++) for (let i = row * stride + 1; i < (row + 1) * stride; i++) cost += MAGNITUDE[filtered[i]];
  return cost;
}

/** Rows read at each of the places of the picture that decide the filter and the compression. */
const PROBE_ROWS = 8;
const PROBE_PLACES: readonly number[] = [1 / 6, 1 / 2, 5 / 6];

function probeRows(layout: PngBandLayout): number[] {
  const rows = Math.min(PROBE_ROWS, layout.height);
  return PROBE_PLACES.map((place) => Math.min(layout.height - rows, Math.floor(layout.height * place)));
}

/**
 * The filter of the picture: the one with the smallest sum of absolute differences over sample rows from three places of the
 * picture (PNG Third Edition, section 12.8). A 16-bit photograph is noise below its top byte, so one filter is within a
 * percent of the best row-by-row choice, and applying one filter costs a fifth of choosing among five for every row.
 * Paeth, which costs several times as much to apply, is chosen only when it saves more than `PAETH_PENALTY`.
 */
function chooseFilter(layout: PngBandLayout, scanlines: Uint8Array): number {
  const rows = Math.min(PROBE_ROWS, layout.height);
  const costs = new Map<number, number>();
  for (const filter of [FILTER_SUB, FILTER_UP, FILTER_AVERAGE, FILTER_PAETH]) {
    let cost = 0;
    for (const first of probeRows(layout)) cost += filterCost(layout, scanlines, first, first + rows, filter);
    costs.set(filter, filter === FILTER_PAETH ? cost * PAETH_PENALTY : cost);
  }
  let best = FILTER_SUB;
  for (const [filter, cost] of costs) if (cost < (costs.get(best) as number)) best = filter;
  return best;
}

/** The task of one pool thread: filter a band, compress it as a segment of the shared deflate stream. */
export function encodePngBand(payload: PngBandPayload): PngBandResult {
  const filtered = filterBand(payload, payload.scanlines, payload.firstRow, payload.endRow, payload.filter);
  const last = payload.endRow === payload.height;
  const deflate = zlib.deflateRawSync(filtered, {
    strategy: zlib.constants.Z_RLE,
    finishFlush: last ? zlib.constants.Z_FINISH : zlib.constants.Z_SYNC_FLUSH,
  });
  return { deflate, adler: adler32(filtered), filteredBytes: filtered.length };
}

/** Run-length matching is kept while it writes at most this much more than string matching on the probe. */
const RUN_LENGTH_TOLERANCE = 1.02;
const PROBE_MATCHING_LEVEL = 1;

/**
 * Run-length matching with Huffman coding is about three times faster than string matching and writes the same bytes
 * when the filtered rows are sensor noise (the low byte of a 16-bit photograph), which string matching cannot use. A
 * picture with structure (smooth areas, repeated texture) is smaller with string matching, and the general encoder
 * writes it better. The sample rows, filtered, say which kind this is.
 */
function isNoiseDominated(layout: PngBandLayout, scanlines: Uint8Array, filter: number): boolean {
  const stride = layout.rowBytes + 1;
  const rows = Math.min(PROBE_ROWS, layout.height);
  const places = probeRows(layout);
  const sample = new Uint8Array(places.length * rows * stride);
  places.forEach((first, index) => sample.set(filterBand(layout, scanlines, first, first + rows, filter), index * rows * stride));
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

export interface PhotoPng16Input {
  /**
   * The samples of the picture, rows of width x channels 16-bit values in the byte order of the host (the image library's
   * `raw` output with depth `ushort`). They are put in PNG byte order in place: the caller does not use them afterwards.
   */
  samples: Buffer;
  width: number;
  height: number;
  /** 1 (grey), 2 (grey and alpha), 3 (RGB) or 4 (RGB and alpha). */
  channels: number;
  /** A PNG written by the same pipeline: its chunks other than IHDR, IDAT and IEND are the chunks of the result, in their places. */
  template: Uint8Array;
}

/**
 * Writes the picture as a 16-bit PNG: rows filtered and compressed in bands on pool threads. Returns null for a picture with
 * structure, which string matching writes smaller than this writer does (see `isNoiseDominated`): the caller encodes that
 * one with the general encoder.
 */
export async function writePhotoPng16(input: PhotoPng16Input, options: { signal?: AbortSignal } = {}): Promise<Buffer | null> {
  const { samples, width, height, channels, template } = input;
  const colourType = COLOUR_TYPE_OF_CHANNELS[channels];
  if (colourType === undefined) throw png16Failure(`${channels} channels are not a greyscale, grey-alpha, RGB or RGBA picture`);
  const bytesPerPixel = channels * BYTES_PER_SAMPLE;
  const layout: PngBandLayout = { rowBytes: width * bytesPerPixel, bytesPerPixel, height };
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || samples.length !== layout.rowBytes * height) {
    throw png16Failure(`the samples do not make a ${width} x ${height} picture of ${channels} channels`);
  }
  const chunks = readChunks(template);
  const templateHeader = chunks[0];
  if (templateHeader?.type !== 'IHDR' || templateHeader.data.length !== IHDR_BYTES || templateHeader.data[IHDR_DEPTH_OFFSET] !== SIXTEEN_BITS || templateHeader.data[IHDR_COLOUR_TYPE_OFFSET] !== colourType || templateHeader.data[IHDR_INTERLACE_OFFSET] !== 0) {
    throw png16Failure('the template is not a non-interlaced 16-bit PNG of the same colour type as the samples');
  }

  // PNG samples are big-endian; the rows go into memory the pool threads share, each behind its filter byte.
  if (os.endianness() === 'LE') samples.swap16();
  const stride = layout.rowBytes + 1;
  const scanlines = new Uint8Array(new SharedArrayBuffer(stride * height));
  for (let y = 0; y < height; y++) scanlines.set(samples.subarray(y * layout.rowBytes, (y + 1) * layout.rowBytes), y * stride + 1);
  const filter = chooseFilter(layout, scanlines);
  if (!isNoiseDominated(layout, scanlines, filter)) return null;

  const bands = Math.min(MAX_BANDS, Math.max(getCpuPool().threadLimit, Math.ceil(height / BAND_ROWS_TARGET)));
  const rowsPerBand = Math.ceil(height / bands);
  const tasks: Promise<PngBandResult>[] = [];
  for (let firstRow = 0; firstRow < height; firstRow += rowsPerBand) {
    const payload: PngBandPayload = { ...layout, filter, scanlines, firstRow, endRow: Math.min(height, firstRow + rowsPerBand) };
    tasks.push(runCpuTask<PngBandResult>('pngBand', payload, { signal: options.signal }));
  }
  const results = await Promise.all(tasks);

  let adler = results[0].adler;
  for (const result of results.slice(1)) adler = combineAdler32(adler, result.adler, result.filteredBytes);
  const trailer = new Uint8Array(ADLER_BYTES);
  new DataView(trailer.buffer).setUint32(0, adler);

  const header = Buffer.alloc(IHDR_BYTES);
  header.writeUInt32BE(width, IHDR_WIDTH_OFFSET);
  header.writeUInt32BE(height, IHDR_HEIGHT_OFFSET);
  header[IHDR_DEPTH_OFFSET] = SIXTEEN_BITS;
  header[IHDR_COLOUR_TYPE_OFFSET] = colourType;
  const pieces: Uint8Array[] = [template.subarray(0, PNG_SIGNATURE_BYTES), chunkOf('IHDR', [header])];
  let placed = false;
  for (const chunk of chunks.slice(1)) {
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
  if (!placed) throw png16Failure('the template has no pixel data chunk to take the place of');
  return Buffer.concat(pieces);
}
