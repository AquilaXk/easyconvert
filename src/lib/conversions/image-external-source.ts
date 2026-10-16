import { crc32 } from './crc32';
import { withUprightOrientation } from './image-orientation';
import { ConversionFailedError, type ConversionOptions, type ConversionResult } from '../types';
import { convertImage } from './image';
import { decodeWithMagick, type MagickSource } from './image-magick-cli';
import { decodeWithOpenJpeg } from './image-openjpeg-cli';

/**
 * Which still-image sources the image library cannot read itself, and which command-line decoder reads each. The
 * answer is a lossless PNG (a TIFF when the file holds several pages), which the image pipeline then converts as it
 * converts any other picture. A source the library reads is not listed: it never leaves the library.
 */

export interface ExternalDecoded {
  buffer: Buffer;
  /** The format of `buffer`, as the registry names it. */
  format: 'png' | 'tiff';
}

const MAGICK_BY_FORMAT: ReadonlyMap<string, MagickSource> = new Map<string, MagickSource>([
  ['psd', { coder: 'psd', label: 'PSD', scenes: 'first' }],
  ['tga', { coder: 'tga', label: 'TGA', scenes: 'first' }],
  ['pcx', { coder: 'pcx', label: 'PCX', scenes: 'first' }],
  ['dds', { coder: 'dds', label: 'DDS', scenes: 'first' }],
  ['pbm', { coder: 'pnm', label: 'PBM', scenes: 'first' }],
  ['pgm', { coder: 'pnm', label: 'PGM', scenes: 'first' }],
  ['ppm', { coder: 'pnm', label: 'PPM', scenes: 'first' }],
  ['pnm', { coder: 'pnm', label: 'PNM', scenes: 'first' }],
  ['heic', { coder: 'heic', label: 'HEIC', scenes: 'first' }],
  ['heif', { coder: 'heic', label: 'HEIF', scenes: 'first' }],
]);
const XCF_SOURCE: MagickSource = { coder: 'xcf', label: 'XCF', scenes: 'flatten' };
const OPENJPEG_FORMATS: ReadonlySet<string> = new Set(['jp2', 'j2k']);
const HEIF_FORMATS: ReadonlySet<string> = new Set(['heic', 'heif']);
const TIFF_FORMATS: ReadonlySet<string> = new Set(['tif', 'tiff']);
const OLD_STYLE_JPEG_TIFF: MagickSource = { coder: 'tiff', label: 'TIFF', scenes: 'all', tolerateWarnings: true };

/** TIFF 6.0 (Adobe, 1992) header and directory layout, and the compression tag with its old-style JPEG value. */
const TIFF_MAGIC = 42;
const TIFF_HEADER_BYTES = 8;
const IFD_COUNT_BYTES = 2;
const IFD_ENTRY_BYTES = 12;
const IFD_NEXT_BYTES = 4;
const IFD_ENTRY_VALUE_OFFSET = 8;
const TAG_COMPRESSION = 259;
const COMPRESSION_OLD_STYLE_JPEG = 6;
/** Directories read: far more than any real document has, so a loop of next-directory offsets ends. */
const MAX_DIRECTORIES = 4096;

/**
 * True when a directory of the TIFF declares old-style JPEG compression (Compression = 6, TIFF 6.0 section 22), which
 * libvips' libtiff is built without. Only classic TIFF is read; any other bytes answer false.
 */
export function usesOldStyleJpeg(tiff: Buffer): boolean {
  if (tiff.length < TIFF_HEADER_BYTES) return false;
  const order = tiff.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return false;
  const little = order === 'II';
  const u16 = (at: number): number => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = (at: number): number => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  if (u16(2) !== TIFF_MAGIC) return false;
  let directory = u32(4);
  for (let seen = 0; seen < MAX_DIRECTORIES && directory !== 0 && directory + IFD_COUNT_BYTES <= tiff.length; seen += 1) {
    const count = u16(directory);
    const entries = directory + IFD_COUNT_BYTES;
    const end = entries + count * IFD_ENTRY_BYTES;
    if (end + IFD_NEXT_BYTES > tiff.length) return false;
    for (let entry = entries; entry < end; entry += IFD_ENTRY_BYTES) {
      if (u16(entry) === TAG_COMPRESSION && u16(entry + IFD_ENTRY_VALUE_OFFSET) === COMPRESSION_OLD_STYLE_JPEG) return true;
    }
    directory = u32(end);
  }
  return false;
}

/** GIMP XCF file header: `gimp xcf `, a four-character version, a NUL, then the canvas width and height as big-endian 32-bit values. */
const XCF_MAGIC = 'gimp xcf ';
const XCF_VERSION_END = 13;
const XCF_CANVAS_OFFSET = 14;
const XCF_HEADER_BYTES = 22;

/** The canvas the header of a GIMP project states. */
function xcfCanvas(xcf: Buffer): { width: number; height: number } {
  const valid = xcf.length >= XCF_HEADER_BYTES && xcf.toString('latin1', 0, XCF_MAGIC.length) === XCF_MAGIC && xcf[XCF_VERSION_END] === 0;
  const width = valid ? xcf.readUInt32BE(XCF_CANVAS_OFFSET) : 0;
  const height = valid ? xcf.readUInt32BE(XCF_CANVAS_OFFSET + 4) : 0;
  if (width === 0 || height === 0) throw new ConversionFailedError('Invalid image: the XCF header could not be decoded');
  return { width, height };
}

const PNG_SIGNATURE_BYTES = 8;
const PNG_CHUNK_OVERHEAD_BYTES = 12;
const PNG_CRC_OFFSET_FROM_END = 4;
const EXIF_CHUNK_TYPE = 'eXIf';

/**
 * Sets the Orientation of a PNG's `eXIf` chunk to 1. libheif has already applied the image's rotation and mirroring
 * (`irot`, `imir`) to the pixels, and HEIF says the EXIF orientation is not to be applied on top of them (ISO/IEC
 * 23008-12 section 6.5.10), so a decoder that keeps the tag would turn the picture twice.
 */
export function withUprightExifOrientation(png: Buffer): Buffer {
  let offset = PNG_SIGNATURE_BYTES;
  while (offset + PNG_CHUNK_OVERHEAD_BYTES <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + PNG_CRC_OFFSET_FROM_END > png.length) return png;
    if (type === EXIF_CHUNK_TYPE) {
      const out = Buffer.from(png);
      withUprightOrientation(png.subarray(dataStart, dataEnd)).copy(out, dataStart);
      out.writeUInt32BE(crc32(out.subarray(offset + 4, dataEnd)), dataEnd);
      return out;
    }
    offset = dataEnd + PNG_CRC_OFFSET_FROM_END;
  }
  return png;
}

/**
 * Decodes `input` when its format is one the image library cannot read, or null when the library reads it. `format` is
 * the registry id of the source.
 */
export async function decodeExternalImage(input: Buffer, format: string, signal?: AbortSignal): Promise<ExternalDecoded | null> {
  if (OPENJPEG_FORMATS.has(format)) return { buffer: await decodeWithOpenJpeg(input, signal), format: 'png' };
  if (format === 'xcf') return decodeWithMagick(input, { ...XCF_SOURCE, canvas: xcfCanvas(input) }, signal);
  const magick = MAGICK_BY_FORMAT.get(format);
  if (magick !== undefined) {
    const decoded = await decodeWithMagick(input, magick, signal);
    return HEIF_FORMATS.has(format) ? { ...decoded, buffer: withUprightExifOrientation(decoded.buffer) } : decoded;
  }
  if (TIFF_FORMATS.has(format) && usesOldStyleJpeg(input)) return decodeWithMagick(input, OLD_STYLE_JPEG_TIFF, signal);
  return null;
}

/**
 * Converts a still-image source: one the image library cannot read is decoded by its command-line decoder first and
 * converted as the PNG (or TIFF) that comes back; every other source is converted as it is.
 */
export async function convertImageSource(
  input: Buffer,
  targetFormat: string,
  options: ConversionOptions,
  originalFilename: string,
  sourceFormat: string
): Promise<ConversionResult> {
  const external = await decodeExternalImage(input, sourceFormat, options.signal);
  if (external === null) return convertImage(input, targetFormat, options, originalFilename, sourceFormat);
  return convertImage(external.buffer, targetFormat, options, originalFilename, external.format);
}
