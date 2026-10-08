import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { ConversionFailedError } from '../types';
import { float32BitsToFloat16 } from './float16';

/**
 * OpenEXR scanline writer for linear RGB, after the OpenEXR file layout specification: magic and version,
 * a header of typed attributes, an offset table with one 64-bit entry per chunk, and the chunks. The pixel
 * type is HALF (binary16, rounded to nearest even) or FLOAT; compression is NONE, ZIPS (one scanline per
 * chunk) or ZIP (sixteen), which reorders the bytes of a chunk into even and odd halves, applies the byte
 * predictor and deflates the result. A chunk that deflate would not shrink is stored as it is.
 */

export type ExrCompression = 'none' | 'zips' | 'zip';

/** Largest width or height written; a data window is 32-bit but readers allocate from it. */
export const EXR_MAX_SIDE = 65_536;
/** zlib level of ZIP chunks: level 1 keeps natural images near 31% of the raw size at 150 MB/s. */
const ZIP_LEVEL = 1;
/** Compressions as the attribute stores them (OpenEXR `Compression` enum). */
const COMPRESSION_CODE: Record<ExrCompression, number> = { none: 0, zips: 2, zip: 3 };
const SCANLINES_PER_CHUNK: Record<ExrCompression, number> = { none: 1, zips: 1, zip: 16 };
const PIXEL_TYPE_HALF = 1;
const PIXEL_TYPE_FLOAT = 2;
const CHANNEL_ORDER = [2, 1, 0] as const; // B, G, R: the order the file stores, alphabetical
const CHANNEL_NAMES = ['B', 'G', 'R'] as const;
const RGB_CHANNELS = 3;
const OFFSET_ENTRY_BYTES = 8;
const CHUNK_HEADER_BYTES = 8;
const BYTE_PREDICTOR_BIAS = 128 + 256;
/** Chunks deflating at once: node's zlib thread pool has four threads by default. */
const COMPRESS_CONCURRENCY = 4;
const deflate = promisify(zlib.deflate);

interface Plan {
  header: Buffer;
  width: number;
  height: number;
  isHalf: boolean;
  compression: ExrCompression;
  chunkCount: number;
  rowsPerChunk: number;
}

function addAttribute(parts: Buffer[], name: string, type: string, value: Buffer): void {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(value.length, 0);
  parts.push(Buffer.from(`${name}\0`, 'ascii'), Buffer.from(`${type}\0`, 'ascii'), size, value);
}

function plan(pixels: Float32Array, width: number, height: number, isHalf: boolean, compression: ExrCompression): Plan {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > EXR_MAX_SIDE || height > EXR_MAX_SIDE) {
    throw new ConversionFailedError(`An EXR file holds 1 to ${EXR_MAX_SIDE} pixels on a side; the picture is ${width} x ${height}.`);
  }
  if (pixels.length !== width * height * RGB_CHANNELS) {
    throw new ConversionFailedError(`EXR encoding needs ${width * height * RGB_CHANNELS} linear samples, got ${pixels.length}.`);
  }
  if (!(compression in COMPRESSION_CODE)) {
    throw new ConversionFailedError(`EXR compression "${String(compression)}" is not supported; use none, zips or zip.`);
  }
  const parts: Buffer[] = [Buffer.from([0x76, 0x2f, 0x31, 0x01]), Buffer.from([0x02, 0x00, 0x00, 0x00])];
  const channels: Buffer[] = CHANNEL_NAMES.map((name) => {
    const entry = Buffer.alloc(name.length + 1 + 16);
    entry.write(`${name}\0`, 0, 'ascii');
    const at = name.length + 1;
    entry.writeInt32LE(isHalf ? PIXEL_TYPE_HALF : PIXEL_TYPE_FLOAT, at);
    entry.writeInt32LE(1, at + 8); // xSampling
    entry.writeInt32LE(1, at + 12); // ySampling
    return entry;
  });
  channels.push(Buffer.from([0]));
  addAttribute(parts, 'channels', 'chlist', Buffer.concat(channels));
  addAttribute(parts, 'compression', 'compression', Buffer.from([COMPRESSION_CODE[compression]]));
  const window = Buffer.alloc(16);
  window.writeInt32LE(width - 1, 8);
  window.writeInt32LE(height - 1, 12);
  addAttribute(parts, 'dataWindow', 'box2i', window);
  addAttribute(parts, 'displayWindow', 'box2i', window);
  addAttribute(parts, 'lineOrder', 'lineOrder', Buffer.from([0]));
  const one = Buffer.alloc(4);
  one.writeFloatLE(1, 0);
  addAttribute(parts, 'pixelAspectRatio', 'float', one);
  addAttribute(parts, 'screenWindowCenter', 'v2f', Buffer.alloc(8));
  addAttribute(parts, 'screenWindowWidth', 'float', one);
  parts.push(Buffer.from([0]));
  const rowsPerChunk = SCANLINES_PER_CHUNK[compression];
  return { header: Buffer.concat(parts), width, height, isHalf, compression, chunkCount: Math.ceil(height / rowsPerChunk), rowsPerChunk };
}

/**
 * The bytes of chunk `index` as the compressor wants them: for each scanline, each channel's row, with the even
 * and odd bytes already split into the two halves of the buffer (the ZIP reordering), or in file order for NONE.
 */
function chunkBytes(pixels: Float32Array, p: Plan, index: number, split: boolean): Uint8Array {
  const firstRow = index * p.rowsPerChunk;
  const rows = Math.min(p.rowsPerChunk, p.height - firstRow);
  const bytesPerSample = p.isHalf ? 2 : 4;
  const samples = rows * RGB_CHANNELS * p.width;
  const out = new Uint8Array(samples * bytesPerSample);
  const bits = new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.length);
  let k = 0;
  for (let y = firstRow; y < firstRow + rows; y += 1) {
    for (const channel of CHANNEL_ORDER) {
      let source = y * p.width * RGB_CHANNELS + channel;
      for (let x = 0; x < p.width; x += 1, source += RGB_CHANNELS, k += 1) {
        if (p.isHalf) {
          const half = float32BitsToFloat16(bits[source]);
          if (split) {
            out[k] = half & 0xff;
            out[samples + k] = half >>> 8;
          } else {
            out[k * 2] = half & 0xff;
            out[k * 2 + 1] = half >>> 8;
          }
        } else {
          const b = bits[source];
          const at = k * 4;
          if (split) {
            // Even bytes (0 and 2 of each sample) fill the first half, odd bytes (1 and 3) the second.
            out[k * 2] = b & 0xff;
            out[k * 2 + 1] = (b >>> 16) & 0xff;
            out[samples * 2 + k * 2] = (b >>> 8) & 0xff;
            out[samples * 2 + k * 2 + 1] = b >>> 24;
          } else {
            out[at] = b & 0xff;
            out[at + 1] = (b >>> 8) & 0xff;
            out[at + 2] = (b >>> 16) & 0xff;
            out[at + 3] = b >>> 24;
          }
        }
      }
    }
  }
  return out;
}

/** The OpenEXR ZIP predictor: each byte becomes its difference from the one before, offset to stay in 0..255. */
function applyPredictor(bytes: Uint8Array): void {
  let previous = bytes[0];
  for (let i = 1; i < bytes.length; i += 1) {
    const current = bytes[i];
    bytes[i] = (current - previous + BYTE_PREDICTOR_BIAS) & 0xff;
    previous = current;
  }
}

function chunkRecord(firstRow: number, data: Uint8Array): Buffer {
  const record = Buffer.alloc(CHUNK_HEADER_BYTES + data.length);
  record.writeInt32LE(firstRow, 0);
  record.writeUInt32LE(data.length, 4);
  record.set(data, CHUNK_HEADER_BYTES);
  return record;
}

function assemble(p: Plan, records: Buffer[]): Buffer {
  const table = Buffer.alloc(p.chunkCount * OFFSET_ENTRY_BYTES);
  let offset = p.header.length + table.length;
  records.forEach((record, i) => {
    // 64-bit little-endian offset from two 32-bit halves: files stay far below 2^53 bytes.
    table.writeUInt32LE(offset % 0x100000000, i * OFFSET_ENTRY_BYTES);
    table.writeUInt32LE(Math.floor(offset / 0x100000000), i * OFFSET_ENTRY_BYTES + 4);
    offset += record.length;
  });
  return Buffer.concat([p.header, table, ...records]);
}

function reducedOrRaw(compressed: Uint8Array, rawLength: number, raw: () => Uint8Array): Uint8Array {
  return compressed.length < rawLength ? compressed : raw();
}

/** Encodes linear RGB (interleaved, width x height x 3) as a single-part scanline OpenEXR file. */
export function encodeOpenExr(
  pixels: Float32Array,
  width: number,
  height: number,
  isHalf: boolean = true,
  compression: ExrCompression = 'zip'
): Buffer {
  const p = plan(pixels, width, height, isHalf, compression);
  const records: Buffer[] = [];
  for (let index = 0; index < p.chunkCount; index += 1) {
    const firstRow = index * p.rowsPerChunk;
    if (compression === 'none') {
      records.push(chunkRecord(firstRow, chunkBytes(pixels, p, index, false)));
      continue;
    }
    const split = chunkBytes(pixels, p, index, true);
    applyPredictor(split);
    const rawLength = split.length;
    const compressed = zlib.deflateSync(split, { level: ZIP_LEVEL });
    // The stored form is the unreordered samples; build them only when deflate did not help.
    records.push(chunkRecord(firstRow, reducedOrRaw(compressed, rawLength, () => chunkBytes(pixels, p, index, false))));
  }
  return assemble(p, records);
}

/** `encodeOpenExr` with the chunks deflated on the zlib thread pool, several at a time. */
export async function encodeOpenExrAsync(
  pixels: Float32Array,
  width: number,
  height: number,
  isHalf: boolean = true,
  compression: ExrCompression = 'zip'
): Promise<Buffer> {
  const p = plan(pixels, width, height, isHalf, compression);
  const records: Buffer[] = new Array<Buffer>(p.chunkCount);
  let next = 0;
  const work = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= p.chunkCount) return;
      const firstRow = index * p.rowsPerChunk;
      if (compression === 'none') {
        records[index] = chunkRecord(firstRow, chunkBytes(pixels, p, index, false));
        continue;
      }
      const split = chunkBytes(pixels, p, index, true);
      applyPredictor(split);
      const rawLength = split.length;
      const compressed = await deflate(split, { level: ZIP_LEVEL });
      records[index] = chunkRecord(firstRow, reducedOrRaw(compressed, rawLength, () => chunkBytes(pixels, p, index, false)));
    }
  };
  await Promise.all(Array.from({ length: Math.min(COMPRESS_CONCURRENCY, p.chunkCount) }, work));
  return assemble(p, records);
}
