import type { SharpOptions } from 'sharp';
import type { FrameSelection } from './image-frames';
import { openLimitedSharp } from './image-input-limits';
import { readUInt16, readUInt32, tiffDirectoryOffsets } from './image-tiff-directories';

/**
 * The resolution a picture states, and the size of the page that follows from it. A PDF, PostScript or EPS page holds a picture at
 * its stored print size: `pixels x 72 / dpi` points on each axis. The pixels are never resampled, only the page and the placement
 * change. A picture that states no resolution is one pixel to the point (72 dpi).
 *
 * Read from the file's own header, on each axis, as the format defines it:
 *  - TIFF 6.0 section 8: XResolution and YResolution (RATIONAL) with ResolutionUnit (2 inch, the default when absent; 3
 *    centimetre; 1 no absolute unit), from the directory of the page;
 *  - PNG 1.2 `pHYs` (ISO/IEC 15948 section 11.3.5.3): pixels per unit on each axis, unit 1 is the metre, unit 0 an aspect ratio;
 *  - JFIF 1.02 APP0: Xdensity and Ydensity with units 1 (dots per inch) or 2 (dots per centimetre); units 0 is an aspect ratio. A JPEG
 *    whose JFIF density is no unit falls to the Exif XResolution and YResolution of its APP1 segment (Exif 2.32 section 4.6.4, the
 *    TIFF tags above);
 *  - any other container with an Exif block (WebP, HEIF, AVIF) in the image library's Exif buffer, read as the TIFF directory it is.
 *
 * A density is kept to a tenth of a dpi (2,835 pixels per metre is 72.009, which is 72). Counted as no resolution, so one pixel to the point: a unit that is not an absolute length, a value that is missing for one axis,
 * zero, negative or not finite, and exactly one pixel per millimetre (25.4 dpi), which the image library writes into a PNG or TIFF
 * whose maker set none (the repository's OCR reader gives the same reason). The image library's own `density` is not used: it keeps
 * one axis, rounds to a whole number, and reports a made-up value for a PNG of unit 0 and a TIFF of unit 1.
 */

export interface PrintDensity {
  /** Dots per inch across the picture. */
  x: number;
  /** Dots per inch down the picture. */
  y: number;
}

export interface PageSize {
  width: number;
  height: number;
}

export const POINTS_PER_INCH = 72;
/** Largest page side the common readers accept (ISO 32000-1 Annex C.2: 14400 units). */
export const PDF_MAX_PAGE_POINTS = 14_400;
export const DEFAULT_PRINT_DENSITY: PrintDensity = { x: POINTS_PER_INCH, y: POINTS_PER_INCH };

const CM_PER_INCH = 2.54;
const INCH_PER_METRE = 0.0254;
/** One pixel per millimetre in dots per inch, and how far a stored value may lie from it (a TIFF stores it as 25.39999962). */
const LIBRARY_PLACEHOLDER_DPI = 25.4;
const PLACEHOLDER_TOLERANCE_DPI = 0.01;
const DPI_STEPS_PER_UNIT = 10;

const TIFF_TAG_X_RESOLUTION = 0x011a;
const TIFF_TAG_Y_RESOLUTION = 0x011b;
const TIFF_TAG_RESOLUTION_UNIT = 0x0128;
const TIFF_TYPE_SHORT = 3;
const TIFF_TYPE_RATIONAL = 5;
const TIFF_UNIT_INCH = 2;
const TIFF_UNIT_CM = 3;
const TIFF_HEADER_BYTES = 8;
const TIFF_MAGIC = 42;
const TIFF_COUNT_BYTES = 2;
const TIFF_ENTRY_BYTES = 12;
const TIFF_VALUE_OFFSET = 8;
const TIFF_RATIONAL_BYTES = 8;
/** Entries of a directory read; a real one holds a few dozen. */
const TIFF_MAX_ENTRIES = 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CHUNK_HEADER_BYTES = 8;
const PNG_CHUNK_CRC_BYTES = 4;
const PNG_PHYS_BYTES = 9;
const PNG_UNIT_METRE = 1;
/** Chunks looked at before giving up; `pHYs` precedes the first IDAT, so a real file has a handful. */
const PNG_MAX_CHUNKS = 64;

const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8]);
const JPEG_APP0 = 0xe0;
const JPEG_APP1 = 0xe1;
const JPEG_SOS = 0xda;
const JPEG_EOI = 0xd9;
const JPEG_SEGMENT_HEADER_BYTES = 4;
const JPEG_LENGTH_BYTES = 2;
const JFIF_ID = Buffer.from('JFIF\0', 'latin1');
const JFIF_BODY_BYTES = 12;
const JFIF_UNITS_AT = 7;
const JFIF_X_DENSITY_AT = 8;
const JFIF_Y_DENSITY_AT = 10;
const JFIF_UNIT_INCH = 1;
const JFIF_UNIT_CM = 2;
const EXIF_ID = Buffer.from('Exif\0\0', 'latin1');
/** Exif orientations that turn the picture a quarter turn (5 to 8): its two axes change places. */
const FIRST_QUARTER_TURN_ORIENTATION = 5;
const LAST_ORIENTATION = 8;

/** A density kept to a tenth of a dpi: a density stored in pixels per metre is a rounded figure (72 dpi is 2,835, which is 72.009), and the tenth undoes it. */
const roundedDpi = (dpi: number): number => Math.round(dpi * DPI_STEPS_PER_UNIT) / DPI_STEPS_PER_UNIT;

function validDensity(x: number, y: number): PrintDensity | null {
  const usable = [x, y].every((dpi) => Number.isFinite(dpi) && dpi > 0);
  if (!usable) return null;
  const [dotsX, dotsY] = [roundedDpi(x), roundedDpi(y)];
  const placeholder = [dotsX, dotsY].every((dpi) => Math.abs(dpi - LIBRARY_PLACEHOLDER_DPI) < PLACEHOLDER_TOLERANCE_DPI);
  return placeholder || dotsX <= 0 || dotsY <= 0 ? null : { x: dotsX, y: dotsY };
}

function rationalAt(block: Buffer, at: number, little: boolean): number | null {
  if (at + TIFF_RATIONAL_BYTES > block.length) return null;
  const denominator = readUInt32(block, at + 4, little);
  return denominator === 0 ? null : readUInt32(block, at, little) / denominator;
}

/** The density a TIFF directory states: both resolutions in an absolute unit. `block` starts at the TIFF header, as offsets in it count from there. */
function directoryDensity(block: Buffer, directory: number, little: boolean): PrintDensity | null {
  if (directory + TIFF_COUNT_BYTES > block.length) return null;
  const entries = Math.min(readUInt16(block, directory, little), TIFF_MAX_ENTRIES);
  let x: number | null = null;
  let y: number | null = null;
  let unit = TIFF_UNIT_INCH;
  for (let index = 0; index < entries; index += 1) {
    const entry = directory + TIFF_COUNT_BYTES + index * TIFF_ENTRY_BYTES;
    if (entry + TIFF_ENTRY_BYTES > block.length) break;
    const tag = readUInt16(block, entry, little);
    const type = readUInt16(block, entry + 2, little);
    if (tag === TIFF_TAG_RESOLUTION_UNIT && type === TIFF_TYPE_SHORT) unit = readUInt16(block, entry + TIFF_VALUE_OFFSET, little);
    if (type !== TIFF_TYPE_RATIONAL) continue;
    if (tag === TIFF_TAG_X_RESOLUTION) x = rationalAt(block, readUInt32(block, entry + TIFF_VALUE_OFFSET, little), little);
    if (tag === TIFF_TAG_Y_RESOLUTION) y = rationalAt(block, readUInt32(block, entry + TIFF_VALUE_OFFSET, little), little);
  }
  if (x === null || y === null) return null;
  if (unit === TIFF_UNIT_INCH) return validDensity(x, y);
  return unit === TIFF_UNIT_CM ? validDensity(x * CM_PER_INCH, y * CM_PER_INCH) : null;
}

const isTiff = (bytes: Buffer): boolean => ['II', 'MM'].includes(bytes.toString('latin1', 0, 2)) && readUInt16(bytes, 2, bytes[0] === 0x49) === TIFF_MAGIC;

/** The density of the first directory of a TIFF-structured block (an Exif block starts at the same header). */
export function tiffBlockDensity(block: Buffer): PrintDensity | null {
  if (block.length < TIFF_HEADER_BYTES || !isTiff(block)) return null;
  const little = block[0] === 0x49;
  return directoryDensity(block, readUInt32(block, 4, little), little);
}

function tiffPageDensity(tiff: Buffer, page: number): PrintDensity | null {
  const layout = tiffDirectoryOffsets(tiff);
  const directory = layout?.offsets[page];
  return layout === null || directory === undefined ? null : directoryDensity(tiff, directory, layout.little);
}

function pngDensity(png: Buffer): PrintDensity | null {
  let at = PNG_SIGNATURE.length;
  for (let chunk = 0; chunk < PNG_MAX_CHUNKS && at + PNG_CHUNK_HEADER_BYTES <= png.length; chunk += 1) {
    const length = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + PNG_CHUNK_HEADER_BYTES);
    if (type === 'IDAT' || type === 'IEND') return null;
    if (type === 'pHYs') {
      const body = at + PNG_CHUNK_HEADER_BYTES;
      if (length !== PNG_PHYS_BYTES || body + PNG_PHYS_BYTES > png.length || png[body + 8] !== PNG_UNIT_METRE) return null;
      return validDensity(png.readUInt32BE(body) * INCH_PER_METRE, png.readUInt32BE(body + 4) * INCH_PER_METRE);
    }
    at += PNG_CHUNK_HEADER_BYTES + length + PNG_CHUNK_CRC_BYTES;
  }
  return null;
}

/** The density of the APP0 payload of a JFIF segment (units 1 or 2), or null for an aspect ratio only. */
export function jfifDensity(body: Buffer): PrintDensity | null {
  if (body.length < JFIF_BODY_BYTES || !body.subarray(0, JFIF_ID.length).equals(JFIF_ID)) return null;
  const x = body.readUInt16BE(JFIF_X_DENSITY_AT);
  const y = body.readUInt16BE(JFIF_Y_DENSITY_AT);
  const units = body[JFIF_UNITS_AT];
  if (units === JFIF_UNIT_INCH) return validDensity(x, y);
  return units === JFIF_UNIT_CM ? validDensity(x * CM_PER_INCH, y * CM_PER_INCH) : null;
}

/** JFIF first, the Exif resolution when JFIF states none. */
function jpegDensity(jpeg: Buffer): PrintDensity | null {
  let jfif: PrintDensity | null = null;
  let exif: PrintDensity | null = null;
  let at = JPEG_SIGNATURE.length;
  while (at + JPEG_SEGMENT_HEADER_BYTES <= jpeg.length && jpeg[at] === 0xff) {
    const marker = jpeg[at + 1];
    const length = jpeg.readUInt16BE(at + 2);
    if (marker === JPEG_SOS || marker === JPEG_EOI || length < JPEG_LENGTH_BYTES) break;
    const body = jpeg.subarray(at + JPEG_SEGMENT_HEADER_BYTES, at + JPEG_LENGTH_BYTES + length);
    if (marker === JPEG_APP0 && jfif === null) jfif = jfifDensity(body);
    if (marker === JPEG_APP1 && exif === null && body.subarray(0, EXIF_ID.length).equals(EXIF_ID)) exif = tiffBlockDensity(body.subarray(EXIF_ID.length));
    at += JPEG_LENGTH_BYTES + length;
  }
  return jfif ?? exif;
}

/** The Exif buffer of the image library: the TIFF block itself (WebP) or behind the `Exif` identifier (HEIF, AVIF). */
function exifBufferDensity(exif: Buffer): PrintDensity | null {
  return tiffBlockDensity(exif.subarray(0, EXIF_ID.length).equals(EXIF_ID) ? exif.subarray(EXIF_ID.length) : exif);
}

/** The density `source` states for page `page` (0-based) as stored, or null: the header is read, nothing is decoded. `exif` is the image library's Exif buffer for a container read through it. */
export function storedDensity(source: Buffer, page: number, exif?: Buffer): PrintDensity | null {
  if (source.length >= TIFF_HEADER_BYTES && isTiff(source)) return tiffPageDensity(source, page);
  if (source.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return pngDensity(source);
  if (source.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) return jpegDensity(source);
  return exif === undefined ? null : exifBufferDensity(exif);
}

/** The density with its axes exchanged when the Exif orientation turns the picture a quarter turn: the picture is measured as it is shown. */
export function uprightDensity(density: PrintDensity, orientation: number | undefined): PrintDensity {
  const turned = orientation !== undefined && orientation >= FIRST_QUARTER_TURN_ORIENTATION && orientation <= LAST_ORIENTATION;
  return turned ? { x: density.y, y: density.x } : density;
}

/**
 * The density of the page `input.page` (0-based, 0 without one) of `source`, for the picture as it is shown (the Exif orientation applied),
 * or one pixel to the point when the source states none.
 */
export async function pictureDensity(source: Buffer, input: SharpOptions = {}): Promise<PrintDensity> {
  const header = await openLimitedSharp(source, input).metadata();
  const stored = storedDensity(source, input.page ?? 0, header.exif);
  return uprightDensity(stored ?? DEFAULT_PRINT_DENSITY, header.orientation);
}

/** The density of the frame or page a selection reads, or one pixel to the point for a source that was not read through a selection (a decoded bitmap, a RAW sensor). */
export async function selectionDensity(selection: Pick<FrameSelection, 'source' | 'input'> | undefined): Promise<PrintDensity> {
  return selection === undefined ? DEFAULT_PRINT_DENSITY : pictureDensity(selection.source, selection.input);
}

/** The page a picture of `width` x `height` pixels is at its stored density, in points. */
export function pageSizePoints(width: number, height: number, density: PrintDensity): PageSize {
  return { width: (width * POINTS_PER_INCH) / density.x, height: (height * POINTS_PER_INCH) / density.y };
}

/** `size` scaled evenly so that no side is over what the common PDF readers accept (a smaller page is left as it is). */
export function withinPdfPageLimit(size: PageSize): PageSize {
  const shrink = Math.min(1, PDF_MAX_PAGE_POINTS / Math.max(size.width, size.height));
  return { width: size.width * shrink, height: size.height * shrink };
}
