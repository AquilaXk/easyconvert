import { ConversionFailedError } from '../../types';
import { assertEncodedImageWithinLimit, assertInputPixels } from '../image-input-limits';

/**
 * The pixels an image part of an XPS package makes the renderer decode, read from its header and not decoded.
 *
 * The kind of image is told as GhostXPS tells it (GhostPDL xps/xpsimage.c `xps_decode_image`, lines 144 to 176): fewer than
 * 8 bytes is no image, 0xFF 0xD8 is a JPEG, the 8-byte PNG signature a PNG, `II` with 0xBC a JPEG XR (HD Photo, `.wdp`), `MM`
 * or `II` a TIFF, and anything else is "unknown image file format", which the renderer fails on. A part of another kind (an ICC
 * profile named through a colour) costs no pixels.
 *
 * JPEG, PNG and TIFF are read by the image library, under the input pixel limit of every still image (image-input-limits.ts).
 * It does not read JPEG XR, so that header is read here the way GhostXPS's JPEG XR library reads it (GhostPDL jpegxr/cr_parse.c
 * `jxr_read_image_container`, `read_ifd`, `jxrc_image_offset`; jpegxr/r_parse.c `r_image_header`). The renderer takes the size from
 * the bitstream header (xps/xpsjxr.c, `jxr_get_IMAGE_WIDTH` is `width1 + 1`, jpegxr/flags.c line 80), not from the container, so
 * the bitstream header is what is read.
 */

export type XpsImageFormat = 'jpeg' | 'png' | 'tiff' | 'jpegxr';

const MIN_IMAGE_BYTES = 8;
const PNG_SIGNATURE = Buffer.from('\x89PNG\r\n\x1a\n', 'latin1');
const JPEG_SIGNATURE = [0xff, 0xd8];
const TIFF_BIG_ENDIAN = 'MM';
const TIFF_LITTLE_ENDIAN = 'II';
const JPEG_XR_THIRD_BYTE = 0xbc;

/** The kind of image in `bytes` by the first bytes, or undefined when GhostXPS would answer "unknown image file format". */
export function xpsImageFormat(bytes: Buffer): XpsImageFormat | undefined {
  if (bytes.length < MIN_IMAGE_BYTES) return undefined;
  if (bytes[0] === JPEG_SIGNATURE[0] && bytes[1] === JPEG_SIGNATURE[1]) return 'jpeg';
  if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return 'png';
  const order = bytes.toString('latin1', 0, 2);
  if (order === TIFF_LITTLE_ENDIAN && bytes[2] === JPEG_XR_THIRD_BYTE) return 'jpegxr';
  if (order === TIFF_BIG_ENDIAN || order === TIFF_LITTLE_ENDIAN) return 'tiff';
  return undefined;
}

const CONTAINER_VERSION_MAX = 1;
const IFD_OFFSET_AT = 4;
const IFD_ENTRY_BYTES = 12;
const IFD_COUNT_BYTES = 2;
/** The directory ends with the offset of the next one, which the reference reads together with the entries. */
const NEXT_DIRECTORY_BYTES = 4;
const TAG_IMAGE_OFFSET = 0xbcc0;
const TYPE_BYTE = 1;
const TYPE_USHORT = 3;
const TYPE_ULONG = 4;
/**
 * The most directories one container may chain. The reference reader follows the chain until an offset of 0 and grows its table
 * by one for each (GhostPDL jpegxr/cr_parse.c `jxr_read_image_container`, lines 185 to 199); a file holds one directory for each
 * image, and an image with its alpha plane is two.
 */
const MAX_DIRECTORIES = 64;
/**
 * The reference reads an array of a tag that does not fit in the entry from the offset the entry holds, whose element size is
 * that of its type (`read_ifd`, lines 1470 to 1650): bytes (types 1, 2, 6, 7), shorts (3, 8), longs (4, 9, 11), and always
 * from an offset the 8-byte values (5, 10, 12). An array of up to this many bytes sits in the entry itself.
 */
const INLINE_VALUE_BYTES = 4;
const ARRAY_ELEMENT_BYTES = new Map<number, number>([
  [1, 1],
  [2, 1],
  [6, 1],
  [7, 1],
  [3, 2],
  [8, 2],
  [4, 4],
  [9, 4],
  [11, 4],
  [5, 8],
  [10, 8],
  [12, 8],
]);
const SHORT_TYPES = new Set([TYPE_USHORT, 8]);
const ALWAYS_OUT_OF_LINE_TYPES = new Set([5, 10, 12]);
/** The reference counts a short array with a 16-bit counter (`uint16_t cdx`, line 1576), so a count past this is a loop that never ends. */
const MAX_SHORT_ARRAY_COUNT = 0xffff;
const STREAM_SIGNATURE = Buffer.from('WMPHOTO\0', 'latin1');
/** After the signature: a byte of version, a byte of flags, the byte of flags that holds the short header flag, and a byte of colour format and bit depth. */
const STREAM_FLAG_BYTES = 4;
const SHORT_HEADER_FLAG_AT = 2;
const SHORT_HEADER_FLAG = 0x80;

function unreadable(reason: string): ConversionFailedError {
  return new ConversionFailedError(`Invalid image: the JPEG XR header could not be read (${reason}).`);
}

/** Refuses an entry whose array the reference would read from outside the file, or never finish reading. */
function assertEntryReadable(bytes: Buffer, at: number): void {
  const type = bytes.readUInt16LE(at + 2);
  const count = bytes.readUInt32LE(at + 4);
  const elementBytes = ARRAY_ELEMENT_BYTES.get(type);
  if (elementBytes === undefined) return;
  if (SHORT_TYPES.has(type) && count > MAX_SHORT_ARRAY_COUNT) throw unreadable(`a tag holds more than ${MAX_SHORT_ARRAY_COUNT} values`);
  if (count * elementBytes <= INLINE_VALUE_BYTES && !ALWAYS_OUT_OF_LINE_TYPES.has(type)) return;
  const offset = bytes.readUInt32LE(at + 8);
  if (offset % 2 !== 0) throw unreadable('a tag array is at an odd offset');
  if (offset + count * elementBytes > bytes.length) throw unreadable('a tag array runs past the end of the file');
}

/** The entries of the directory at `directory`, each as the offset of its 12 bytes, and the offset of the next directory (0 at the end of the chain). */
function readDirectory(bytes: Buffer, directory: number): { entries: number[]; next: number } {
  if (directory % 2 !== 0 || directory + IFD_COUNT_BYTES > bytes.length) throw unreadable('the directory is not inside the file');
  const count = bytes.readUInt16LE(directory);
  const next = directory + IFD_COUNT_BYTES + count * IFD_ENTRY_BYTES;
  if (next + NEXT_DIRECTORY_BYTES > bytes.length) throw unreadable('the directory runs past the end of the file');
  return {
    entries: Array.from({ length: count }, (_unused, index) => directory + IFD_COUNT_BYTES + index * IFD_ENTRY_BYTES),
    next: bytes.readUInt32LE(next),
  };
}

/**
 * The offset of the codestream of the first image of the container: tag 0xBCC0 of its first directory, of a count of 1 and the
 * type byte, short or long. The renderer reads every directory of the chain and the arrays they hold, so those are checked
 * too (a loop of directories, a chain without end, an array that never finishes reading or lies outside the file are refused).
 */
function codestreamOffset(bytes: Buffer): number {
  if (bytes[3] > CONTAINER_VERSION_MAX) throw unreadable('unknown container version');
  const first = bytes.readUInt32LE(IFD_OFFSET_AT);
  if (first === 0) throw unreadable('the container has no directory');
  const seen = new Set<number>();
  let imageOffset: number | undefined;
  for (let directory = first; directory !== 0;) {
    if (seen.has(directory)) throw unreadable('the directories loop');
    if (seen.size === MAX_DIRECTORIES) throw unreadable(`the container chains more than ${MAX_DIRECTORIES} directories`);
    seen.add(directory);
    const { entries, next } = readDirectory(bytes, directory);
    for (const at of entries) assertEntryReadable(bytes, at);
    if (directory === first) imageOffset = imageOffsetOf(bytes, entries);
    directory = next;
  }
  return imageOffset as number;
}

/** The value of tag 0xBCC0 among the entries of the first directory. */
function imageOffsetOf(bytes: Buffer, entries: readonly number[]): number {
  for (const at of entries) {
    if (bytes.readUInt16LE(at) !== TAG_IMAGE_OFFSET) continue;
    const type = bytes.readUInt16LE(at + 2);
    if (bytes.readUInt32LE(at + 4) !== 1) throw unreadable('the image offset has a count other than 1');
    if (type === TYPE_ULONG) return bytes.readUInt32LE(at + 8);
    if (type === TYPE_USHORT) return bytes.readUInt16LE(at + 8);
    if (type === TYPE_BYTE) return bytes[at + 8];
    throw unreadable('the image offset has an unknown type');
  }
  throw unreadable('the container names no image');
}

/** The width and height the bitstream header of a JPEG XR file states (each is the stored value plus one), without decoding it. */
export function jpegXrSize(bytes: Buffer): { width: number; height: number } {
  const start = codestreamOffset(bytes);
  const flagsAt = start + STREAM_SIGNATURE.length;
  const sizeAt = flagsAt + STREAM_FLAG_BYTES;
  if (sizeAt + 8 > bytes.length) throw unreadable('the file ends inside the codestream header');
  if (!bytes.subarray(start, flagsAt).equals(STREAM_SIGNATURE)) throw unreadable('the codestream does not start with its signature');
  if ((bytes[flagsAt + SHORT_HEADER_FLAG_AT] & SHORT_HEADER_FLAG) !== 0) return { width: bytes.readUInt16BE(sizeAt) + 1, height: bytes.readUInt16BE(sizeAt + 2) + 1 };
  return { width: bytes.readUInt32BE(sizeAt) + 1, height: bytes.readUInt32BE(sizeAt + 4) + 1 };
}

/**
 * The pixels the renderer decodes for the image part `bytes` each time a brush draws it: its width times its height, from the
 * header. A part that is no image costs none. An image whose declared size is over the input pixel limit, or whose header cannot
 * be read, is refused (`InputPixelLimitError`, `ConversionFailedError`): the renderer would fail on it or allocate for it.
 */
export async function xpsImagePixels(bytes: Buffer): Promise<number> {
  const format = xpsImageFormat(bytes);
  if (format === undefined) return 0;
  if (format === 'jpegxr') {
    const { width, height } = jpegXrSize(bytes);
    assertInputPixels(width, height);
    return width * height;
  }
  const { width, height } = await assertEncodedImageWithinLimit(bytes);
  return (width as number) * (height as number);
}
