import { crc32 } from './crc32';
import { withUprightOrientation } from './image-orientation';
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
  ['xcf', { coder: 'xcf', label: 'XCF', scenes: 'flatten' }],
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
const OPENJPEG_FORMATS: ReadonlySet<string> = new Set(['jp2', 'j2k']);
const HEIF_FORMATS: ReadonlySet<string> = new Set(['heic', 'heif']);
const TIFF_FORMATS: ReadonlySet<string> = new Set(['tif', 'tiff']);
const OLD_STYLE_JPEG_TIFF: MagickSource = { coder: 'tiff', label: 'TIFF', scenes: 'all' };

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
export async function decodeExternalImage(input: Buffer, format: string | undefined, signal?: AbortSignal): Promise<ExternalDecoded | null> {
  if (format === undefined) return null;
  if (OPENJPEG_FORMATS.has(format)) return { buffer: await decodeWithOpenJpeg(input, signal), format: 'png' };
  const magick = MAGICK_BY_FORMAT.get(format);
  if (magick !== undefined) {
    const decoded = await decodeWithMagick(input, magick, signal);
    return HEIF_FORMATS.has(format) ? { ...decoded, buffer: withUprightExifOrientation(decoded.buffer) } : decoded;
  }
  if (TIFF_FORMATS.has(format) && usesOldStyleJpeg(input)) return decodeWithMagick(input, OLD_STYLE_JPEG_TIFF, signal);
  return null;
}
