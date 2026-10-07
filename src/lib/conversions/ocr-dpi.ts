/**
 * The resolution a scan declares, read from the image header without a decoder so that the browser
 * tier (which has none) and the server read it the same way. A searchable PDF is as large as the
 * scanned page was: pixels x 72 / dpi points.
 *
 * Read: PNG `pHYs` (ISO/IEC 15948 section 11.3.5.3, pixels per metre), JPEG JFIF density (JFIF
 * 1.02: units 1 is dots per inch, 2 is dots per centimetre) and the XResolution of a JPEG's Exif
 * block (Exif 2.32 section 4.6.4: ResolutionUnit 2 is inch, 3 is centimetre). Anything else, and any
 * value outside OCR_DPI_RANGE, counts as undeclared.
 */

/** Resolution assumed for an image that declares none; recorded wherever it is used. */
export const OCR_DEFAULT_DPI = 300;
/**
 * Declared resolutions outside this range are not believed. The lower bound is above 25.4 dpi
 * (1 pixel per millimetre), the density libvips writes into an image whose maker set none, which
 * is a placeholder and not a scan.
 */
export const OCR_DPI_RANGE = { min: 50, max: 4800 } as const;

const INCHES_PER_METRE = 39.3701;
/** Resolutions are kept to a tenth of a dpi. */
const DPI_ROUNDING_STEPS_PER_UNIT = 10;
const CENTIMETRES_PER_INCH = 2.54;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_CHUNK_HEADER_BYTES = 8;
const PNG_CHUNK_CRC_BYTES = 4;
const PNG_PHYS_BYTES = 9;
const PNG_UNIT_METRE = 1;
/** Chunks looked at before giving up; `pHYs` must precede the first IDAT, so a real file has a handful. */
const PNG_MAX_CHUNKS_SCANNED = 64;
const JPEG_SOI = [0xff, 0xd8];
const JPEG_APP0 = 0xe0;
const JPEG_APP1 = 0xe1;
const EXIF_ID = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
const TIFF_LITTLE_ENDIAN = 0x4949;
const TIFF_BIG_ENDIAN = 0x4d4d;
const TIFF_MAGIC = 42;
const TIFF_HEADER_BYTES = 8;
const TIFF_ENTRY_BYTES = 12;
const TIFF_TAG_X_RESOLUTION = 0x011a;
const TIFF_TAG_RESOLUTION_UNIT = 0x0128;
const TIFF_TYPE_SHORT = 3;
const TIFF_TYPE_RATIONAL = 5;
const TIFF_RATIONAL_BYTES = 8;
const EXIF_UNIT_INCH = 2;
const EXIF_UNIT_CENTIMETRE = 3;
/** Entries of the first image directory looked at; a real one holds a few dozen. */
const TIFF_MAX_ENTRIES = 256;
const JPEG_SOS = 0xda;
const JPEG_JFIF_ID = [0x4a, 0x46, 0x49, 0x46, 0x00];
const JFIF_UNIT_DPI = 1;
const JFIF_UNIT_DPCM = 2;
/** Segments looked at before giving up; JFIF's APP0 must be the first segment after SOI. */
const JPEG_MAX_SEGMENTS_SCANNED = 16;

export interface ImageDpi {
  dpi: number;
  /** True when the image declared no usable resolution and OCR_DEFAULT_DPI was used. */
  assumed: boolean;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[], at = 0): boolean {
  return prefix.every((byte, i) => bytes[at + i] === byte);
}

function readUint32(bytes: Uint8Array, at: number): number {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

function inRange(dpi: number): boolean {
  return Number.isFinite(dpi) && dpi >= OCR_DPI_RANGE.min && dpi <= OCR_DPI_RANGE.max;
}

function pngDpi(bytes: Uint8Array): number | null {
  let at = PNG_SIGNATURE.length;
  for (let chunk = 0; chunk < PNG_MAX_CHUNKS_SCANNED; chunk++) {
    if (at + PNG_CHUNK_HEADER_BYTES > bytes.length) return null;
    const length = readUint32(bytes, at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (type === 'IDAT' || type === 'IEND') return null;
    if (type === 'pHYs') {
      const body = at + PNG_CHUNK_HEADER_BYTES;
      if (length !== PNG_PHYS_BYTES || body + PNG_PHYS_BYTES > bytes.length) return null;
      if (bytes[body + 8] !== PNG_UNIT_METRE) return null;
      return readUint32(bytes, body) / INCHES_PER_METRE;
    }
    at += PNG_CHUNK_HEADER_BYTES + length + PNG_CHUNK_CRC_BYTES;
  }
  return null;
}

/** XResolution of the first image directory of a TIFF block, in dots per inch, or null. */
function exifDpi(bytes: Uint8Array, tiff: number, end: number): number | null {
  if (tiff + TIFF_HEADER_BYTES > end) return null;
  const order = (bytes[tiff] << 8) | bytes[tiff + 1];
  if (order !== TIFF_LITTLE_ENDIAN && order !== TIFF_BIG_ENDIAN) return null;
  const little = order === TIFF_LITTLE_ENDIAN;
  const u16 = (at: number): number => (little ? bytes[at] | (bytes[at + 1] << 8) : (bytes[at] << 8) | bytes[at + 1]);
  const u32 = (at: number): number =>
    (little
      ? bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)
      : (bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
  if (u16(tiff + 2) !== TIFF_MAGIC) return null;
  const directory = tiff + u32(tiff + 4);
  if (directory + 2 > end) return null;
  const count = Math.min(u16(directory), TIFF_MAX_ENTRIES);
  let resolution: number | null = null;
  let unit = EXIF_UNIT_INCH;
  for (let i = 0; i < count; i++) {
    const entry = directory + 2 + i * TIFF_ENTRY_BYTES;
    if (entry + TIFF_ENTRY_BYTES > end) return null;
    const tag = u16(entry);
    const type = u16(entry + 2);
    if (tag === TIFF_TAG_X_RESOLUTION && type === TIFF_TYPE_RATIONAL) {
      const value = tiff + u32(entry + 8);
      if (value + TIFF_RATIONAL_BYTES > end) return null;
      const denominator = u32(value + 4);
      resolution = denominator === 0 ? null : u32(value) / denominator;
    } else if (tag === TIFF_TAG_RESOLUTION_UNIT && type === TIFF_TYPE_SHORT) {
      unit = u16(entry + 8);
    }
  }
  if (resolution === null) return null;
  if (unit === EXIF_UNIT_INCH) return resolution;
  return unit === EXIF_UNIT_CENTIMETRE ? resolution * CENTIMETRES_PER_INCH : null;
}

function jpegDpi(bytes: Uint8Array): number | null {
  let exif: number | null = null;
  let at = JPEG_SOI.length;
  for (let segment = 0; segment < JPEG_MAX_SEGMENTS_SCANNED; segment++) {
    if (at + 4 > bytes.length || bytes[at] !== 0xff) break;
    const marker = bytes[at + 1];
    if (marker === JPEG_SOS) break;
    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    if (marker === JPEG_APP0 && startsWith(bytes, JPEG_JFIF_ID, at + 4)) {
      const body = at + 4 + JPEG_JFIF_ID.length;
      if (body + 7 > bytes.length) return null;
      const units = bytes[body + 2];
      const density = (bytes[body + 3] << 8) | bytes[body + 4];
      if (units === JFIF_UNIT_DPI) return density;
      if (units === JFIF_UNIT_DPCM) return density * CENTIMETRES_PER_INCH;
    } else if (marker === JPEG_APP1 && exif === null && startsWith(bytes, EXIF_ID, at + 4)) {
      const tiff = at + 4 + EXIF_ID.length;
      exif = exifDpi(bytes, tiff, Math.min(bytes.length, at + 2 + length));
    }
    at += 2 + length;
  }
  return exif;
}

/** The resolution the image declares, or null when it declares none that is believable. */
export function readDeclaredDpi(bytes: Uint8Array): number | null {
  let dpi: number | null = null;
  if (startsWith(bytes, PNG_SIGNATURE)) dpi = pngDpi(bytes);
  else if (startsWith(bytes, JPEG_SOI)) dpi = jpegDpi(bytes);
  if (dpi === null) return null;
  // A density stored in pixels per metre is a rounded figure (300 dpi is 11811 per metre): undo the rounding.
  const rounded = Math.round(dpi * DPI_ROUNDING_STEPS_PER_UNIT) / DPI_ROUNDING_STEPS_PER_UNIT;
  return inRange(rounded) ? rounded : null;
}

/** The resolution to size the page with: the declared one, or OCR_DEFAULT_DPI with `assumed` set. */
export function resolveImageDpi(bytes: Uint8Array): ImageDpi {
  const declared = readDeclaredDpi(bytes);
  return declared === null ? { dpi: OCR_DEFAULT_DPI, assumed: true } : { dpi: declared, assumed: false };
}
