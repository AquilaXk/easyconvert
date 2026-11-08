import zlib from 'node:zlib';
import { withUprightOrientation } from './image-orientation';

/**
 * The EXIF block of a picture `djxl` decoded. The decoder writes it into the PNG as a `zTXt` text chunk named `Raw profile type exif`
 * (the form ImageMagick reads), which the image library ignores, so the block would not reach a JPEG, WebP or TIFF written from the
 * picture. Here it is copied into the `eXIf` chunk that the library does read (PNG 1.5.x, "eXIf Exchangeable Image File (Exif)
 * Profile"), with its Orientation set to 1: the decoder has turned the pixels already (ISO/IEC 18181-1 applies the orientation
 * of the codestream header), and older releases of libjxl leave the tag of the Exif box in the block, which a viewer would turn a second time.
 * A picture that does not carry such a chunk, or whose chunk is not a well-formed profile, is returned as it is.
 */

const PNG_SIGNATURE_BYTES = 8;
const CHUNK_HEADER_BYTES = 8;
const CHUNK_CRC_BYTES = 4;
const CHUNK_OVERHEAD_BYTES = CHUNK_HEADER_BYTES + CHUNK_CRC_BYTES;
const RAW_EXIF_KEYWORD = 'Raw profile type exif';
const ZLIB_METHOD = 0;
/** The inflated text of a profile: the hexadecimal form of an EXIF block, which JPEG limits to 64 KiB; JPEG XL boxes can be larger, a megabyte is far more than any camera writes. */
const MAX_PROFILE_TEXT_BYTES = 2 * 1024 * 1024;
const EXIF_PREFIX = 'Exif\0\0';
/** The offset field in front of the TIFF header in the payload of the Exif box. */
const TIFF_OFFSET_FIELD_BYTES = 4;
const TIFF_HEADER_BYTES = 8;
const TIFF_MAGIC = 42;
const MIN_EXIF_BYTES = TIFF_HEADER_BYTES;
/** `\n<name>\n<length in decimal, padded>\n<hexadecimal bytes in lines>\n`. */
const RAW_PROFILE = /^\nexif\n\s*(\d+)\n([0-9a-fA-F\s]*)$/;
const HEX_DIGITS_PER_BYTE = 2;

/** Whether a TIFF header (byte order mark `II` or `MM`, then 42) starts at `at`. */
function hasTiffHeaderAt(bytes: Buffer, at: number): boolean {
  if (at + TIFF_HEADER_BYTES > bytes.length) return false;
  const order = bytes.toString('latin1', at, at + 2);
  if (order !== 'II' && order !== 'MM') return false;
  return (order === 'II' ? bytes.readUInt16LE(at + 2) : bytes.readUInt16BE(at + 2)) === TIFF_MAGIC;
}

/** The TIFF block inside the profile's bytes: after the `Exif\0\0` prefix, after the offset field of the Exif box, or the bytes themselves; null when none is there. */
function tiffBlockOf(bytes: Buffer): Buffer | null {
  if (bytes.toString('latin1', 0, EXIF_PREFIX.length) === EXIF_PREFIX) return hasTiffHeaderAt(bytes, EXIF_PREFIX.length) ? bytes.subarray(EXIF_PREFIX.length) : null;
  if (hasTiffHeaderAt(bytes, 0)) return bytes;
  if (bytes.length < TIFF_OFFSET_FIELD_BYTES) return null;
  const start = TIFF_OFFSET_FIELD_BYTES + bytes.readUInt32BE(0);
  return hasTiffHeaderAt(bytes, start) ? bytes.subarray(start) : null;
}

/** The EXIF block that a `Raw profile type exif` chunk holds, or null when its data is not a well-formed profile. */
function exifOfRawProfile(chunk: Buffer): Buffer | null {
  const keywordEnd = chunk.indexOf(0);
  if (keywordEnd < 0 || chunk.toString('latin1', 0, keywordEnd) !== RAW_EXIF_KEYWORD || chunk[keywordEnd + 1] !== ZLIB_METHOD) return null;
  let text: string;
  try {
    text = zlib.inflateSync(chunk.subarray(keywordEnd + 2), { maxOutputLength: MAX_PROFILE_TEXT_BYTES }).toString('latin1');
  } catch {
    return null;
  }
  const profile = RAW_PROFILE.exec(text);
  if (profile === null) return null;
  const hex = profile[2].replace(/\s+/g, '');
  const bytes = Buffer.from(hex, 'hex');
  if (hex.length !== bytes.length * HEX_DIGITS_PER_BYTE || bytes.length !== Number(profile[1]) || bytes.length < MIN_EXIF_BYTES) return null;
  return tiffBlockOf(bytes);
}

function exifChunk(exif: Buffer): Buffer {
  const chunk = Buffer.alloc(CHUNK_OVERHEAD_BYTES + exif.length);
  chunk.writeUInt32BE(exif.length, 0);
  chunk.write('eXIf', 4, 'latin1');
  exif.copy(chunk, CHUNK_HEADER_BYTES);
  chunk.writeUInt32BE(zlib.crc32(chunk.subarray(4, CHUNK_HEADER_BYTES + exif.length)), CHUNK_HEADER_BYTES + exif.length);
  return chunk;
}

/** `png` with the EXIF block of its `Raw profile type exif` chunk also stored as an `eXIf` chunk before the first `IDAT`; see the module comment. */
export function withExifChunk(png: Buffer): Buffer {
  let exif: Buffer | null = null;
  let firstData = -1;
  let offset = PNG_SIGNATURE_BYTES;
  while (offset + CHUNK_OVERHEAD_BYTES <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + CHUNK_HEADER_BYTES);
    const dataEnd = offset + CHUNK_HEADER_BYTES + length;
    if (dataEnd + CHUNK_CRC_BYTES > png.length) return png;
    if (type === 'eXIf') return png;
    if (type === 'IDAT' && firstData < 0) firstData = offset;
    if (type === 'zTXt' && exif === null) exif = exifOfRawProfile(png.subarray(offset + CHUNK_HEADER_BYTES, dataEnd));
    if (type === 'IEND') break;
    offset = dataEnd + CHUNK_CRC_BYTES;
  }
  if (exif === null || firstData < 0) return png;
  return Buffer.concat([png.subarray(0, firstData), exifChunk(withUprightOrientation(exif)), png.subarray(firstData)]);
}
