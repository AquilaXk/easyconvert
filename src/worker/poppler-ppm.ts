import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { crc32 } from '../lib/conversions/crc32';
import { ConversionFailedError, UnsupportedOptionError } from '../lib/types';
import { executeSandboxedBinary, SandboxedBufferLimitError, type SandboxedExecutionOptions } from './sandbox';

/**
 * PNG pages from Poppler without Poppler's PNG writer.
 *
 * `pdftoppm -png` spends more time compressing the page (libpng, every filter tried per row) than rasterising it
 * (about 9 ms of 14 ms for a letter page at 72 dpi, 22 of 32 ms at 150 dpi). The worker asks for the uncompressed PPM
 * page instead and compresses it with the in-process encoder, which writes a PNG with the same pixels, the same
 * 8-bit RGB layout and the same pixel density.
 */

/** A page larger than this (raw RGB bytes) is rendered the way it always was, as a PNG written by Poppler. */
export const PPM_PAGE_MAX_BYTES = 128 * 1024 * 1024;
/** Raw bytes one batch of pages may leave on disk before they are encoded: the batch holds at most this many letter pages. */
const PPM_BATCH_BYTES = 48 * 1024 * 1024;
const PPM_BATCH_MAX_PAGES = 8;
const LETTER_WIDTH_INCHES = 8.5;
const LETTER_HEIGHT_INCHES = 11;
const RGB_CHANNELS = 3;
const PPM_MAGIC = 'P6';
const PPM_MAX_VALUE = 255;
/** `P6`, two sizes and the maximum value, each followed by one white space: far below this many bytes. */
const PPM_HEADER_MAX_BYTES = 64;
const METRES_PER_INCH = 0.0254;
const WHITE_SPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);

export interface PpmPage {
  width: number;
  height: number;
  /** Offset of the first pixel byte. */
  dataOffset: number;
}

/** Pages one `pdftoppm` run may render before their raw files are encoded and removed, for pages of roughly letter size. */
export function ppmBatchPages(dpi: number): number {
  const letterBytes = RGB_CHANNELS * LETTER_WIDTH_INCHES * dpi * LETTER_HEIGHT_INCHES * dpi;
  return Math.max(1, Math.min(PPM_BATCH_MAX_PAGES, Math.floor(PPM_BATCH_BYTES / letterBytes)));
}

/** Splits the pages of an interval into batches of at most `size` consecutive pages. */
export function splitIntoBatches(start: number, end: number, size: number): Array<{ start: number; end: number }> {
  const batches: Array<{ start: number; end: number }> = [];
  for (let first = start; first <= end; first += size) {
    batches.push({ start: first, end: Math.min(end, first + size - 1) });
  }
  return batches;
}

class PpmReader {
  private at = 0;
  constructor(private readonly bytes: Buffer) {}

  private skipComments(): void {
    for (;;) {
      while (this.at < this.bytes.length && WHITE_SPACE.has(this.bytes[this.at])) this.at++;
      if (this.bytes[this.at] !== 0x23) return;
      while (this.at < this.bytes.length && this.bytes[this.at] !== 0x0a) this.at++;
    }
  }

  token(): string {
    this.skipComments();
    const begin = this.at;
    while (this.at < this.bytes.length && !WHITE_SPACE.has(this.bytes[this.at]) && this.at - begin < PPM_HEADER_MAX_BYTES) this.at++;
    return this.bytes.toString('latin1', begin, this.at);
  }

  /** The single white space byte that separates the header from the pixels. */
  endOfHeader(): number {
    if (this.at >= this.bytes.length || !WHITE_SPACE.has(this.bytes[this.at])) throw malformed('the header is not closed');
    return this.at + 1;
  }
}

function malformed(reason: string): ConversionFailedError {
  return new ConversionFailedError(`The PDF renderer wrote a page image that is not a binary PPM: ${reason}.`);
}

/** The size of a binary PPM (`P6`, 8 bits) from its first bytes. Anything else is refused: a page is never guessed. */
export function parsePpmHeader(head: Buffer): PpmPage {
  const reader = new PpmReader(head);
  if (reader.token() !== PPM_MAGIC) throw malformed('it does not start with P6');
  const width = Number(reader.token());
  const height = Number(reader.token());
  const maxValue = Number(reader.token());
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw malformed('the size is not two positive integers');
  if (maxValue !== PPM_MAX_VALUE) throw malformed(`the sample range is ${maxValue}, not ${PPM_MAX_VALUE}`);
  return { width, height, dataOffset: reader.endOfHeader() };
}

/** True when the file holds pages too large to compress in memory next to the others. */
export function exceedsPpmPageLimit(sizeBytes: number): boolean {
  return sizeBytes > PPM_PAGE_MAX_BYTES;
}

const PNG_SIGNATURE_BYTES = 8;
const PNG_CHUNK_OVERHEAD_BYTES = 12;
const PNG_IHDR_BYTES = 13;
const PNG_PHYS_DATA_BYTES = 9;
const PNG_METRE_UNIT = 1;

/**
 * The pixel density Poppler records: whole pixels per metre, rounded down (150 dpi is 5905, where rounding to the
 * nearest would write 5906).
 */
function pixelsPerMetre(dpi: number): number {
  return Math.floor(dpi / METRES_PER_INCH);
}

/**
 * The PNG with Poppler's pixel density: one `pHYs` chunk after the header chunk, where Poppler writes it. The encoder
 * writes a chunk of its own there (1000 pixels per metre) which is replaced; asking the encoder for the density would
 * also embed a colour profile, which Poppler's pages do not have.
 */
function withPixelDensity(png: Buffer, dpi: number): Buffer {
  const at = PNG_SIGNATURE_BYTES + PNG_CHUNK_OVERHEAD_BYTES + PNG_IHDR_BYTES;
  const chunk = Buffer.alloc(PNG_CHUNK_OVERHEAD_BYTES + PNG_PHYS_DATA_BYTES);
  chunk.writeUInt32BE(PNG_PHYS_DATA_BYTES, 0);
  chunk.write('pHYs', 4, 'latin1');
  chunk.writeUInt32BE(pixelsPerMetre(dpi), 8);
  chunk.writeUInt32BE(pixelsPerMetre(dpi), 12);
  chunk.writeUInt8(PNG_METRE_UNIT, 16);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 4 + 4 + PNG_PHYS_DATA_BYTES)), 17);
  const encoderOwnsOne = png.toString('latin1', at + 4, at + 8) === 'pHYs';
  const after = encoderOwnsOne ? at + chunk.length : at;
  return Buffer.concat([png.subarray(0, at), chunk, png.subarray(after)]);
}

/**
 * The PNG of one binary PPM page held in memory, with the pixel density Poppler's PNG pages have. A file that holds
 * more or fewer pixels than its header says is refused.
 */
export async function compressPpmPage(file: Buffer, dpi: number): Promise<Buffer> {
  const { width, height, dataOffset } = parsePpmHeader(file.subarray(0, PPM_HEADER_MAX_BYTES * 2));
  const expected = width * height * RGB_CHANNELS;
  if (file.length - dataOffset !== expected) {
    throw malformed(`${file.length - dataOffset} pixel bytes for a ${width} x ${height} page, expected ${expected}`);
  }
  const png = await sharp(file.subarray(dataOffset), { raw: { width, height, channels: RGB_CHANNELS } })
    .png({ compressionLevel: 5, adaptiveFiltering: true })
    .toBuffer();
  return withPixelDensity(png, dpi);
}

/** Number of bytes the first page of a stream of binary PPM pages takes, or null when the stream ends inside it. */
export function ppmPageEnd(stream: Buffer): number | null {
  const { width, height, dataOffset } = parsePpmHeader(stream.subarray(0, PPM_HEADER_MAX_BYTES * 2));
  const end = dataOffset + width * height * RGB_CHANNELS;
  return end <= stream.length ? end : null;
}

/** Compresses one PPM page file into a PNG file and removes the PPM. */
export async function encodePpmPageAsPng(ppmPath: string, pngPath: string, dpi: number): Promise<void> {
  fs.writeFileSync(pngPath, await compressPpmPage(fs.readFileSync(ppmPath), dpi));
  fs.rmSync(ppmPath, { force: true });
}

/** The `pdftoppm` arguments of a PNG request, as the same request for PPM pages (the program's default output). */
function asRawPages(pngArguments: readonly string[]): string[] {
  return pngArguments.filter((argument) => argument !== '-png');
}

/**
 * Renders one batch of pages to PNG files in `tempDir`: Poppler writes PPM pages and the worker compresses them. A page
 * above the raw-size limit is not held in memory: the batch is drawn again with Poppler's own PNG writer, as every page
 * was before. `pngArguments` is the `pdftoppm` command line of the batch with `-png`.
 */
export async function renderPngBatch(pdftoppm: string, tempDir: string, dpi: number, sandbox: SandboxedExecutionOptions, pngArguments: readonly string[]): Promise<void> {
  const isRawPage = (name: string) => name.startsWith('page') && name.endsWith('.ppm');
  let fitsInMemory = true;
  try {
    await executeSandboxedBinary(pdftoppm, asRawPages(pngArguments), { ...sandbox, maxFileSize: PPM_PAGE_MAX_BYTES });
  } catch (err) {
    if (!(err instanceof SandboxedBufferLimitError)) throw err;
    fitsInMemory = false;
  }
  const rawPages = fs.readdirSync(tempDir).filter(isRawPage);
  if (fitsInMemory && rawPages.some((name) => exceedsPpmPageLimit(fs.statSync(path.join(tempDir, name)).size))) fitsInMemory = false;
  if (!fitsInMemory) {
    for (const name of rawPages) fs.rmSync(path.join(tempDir, name), { force: true });
    await executeSandboxedBinary(pdftoppm, [...pngArguments], sandbox);
    return;
  }
  await Promise.all(rawPages.map((name) => encodePpmPageAsPng(path.join(tempDir, name), path.join(tempDir, name.replace(/\.ppm$/, '.png')), dpi)));
}

/** True when the request names pages (`page` or `pages`), so the pages to render depend on the document. */
export function selectsPages(options: { page?: unknown; pages?: unknown }): boolean {
  const named = (value: unknown) => value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '');
  return named(options.page) || named(options.pages);
}

/** Raster density of a PDF page image: the default and the range the API accepts. */
const PDF_RASTER_DEFAULT_DPI = 150;
const PDF_RASTER_MIN_DPI = 72;
const PDF_RASTER_MAX_DPI = 600;

/** The raster density of a PDF page image, validated against the range the API accepts. */
export function resolvePdfRasterDpi(options: { dpi?: number }): number {
  const dpi = options.dpi ?? PDF_RASTER_DEFAULT_DPI;
  if (!Number.isFinite(dpi) || dpi < PDF_RASTER_MIN_DPI || dpi > PDF_RASTER_MAX_DPI) {
    throw new UnsupportedOptionError(`The dpi option ${options.dpi} is outside the supported range of ${PDF_RASTER_MIN_DPI} to ${PDF_RASTER_MAX_DPI}.`);
  }
  return dpi;
}
