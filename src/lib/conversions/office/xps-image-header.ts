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
const STREAM_SIGNATURE = Buffer.from('WMPHOTO\0', 'latin1');
/** After the signature: a byte of version, a byte of flags, the byte of flags that holds the short header flag, and a byte of colour format and bit depth. */
const STREAM_FLAG_BYTES = 4;
const SHORT_HEADER_FLAG_AT = 2;
const SHORT_HEADER_FLAG = 0x80;

function unreadable(reason: string): ConversionFailedError {
  return new ConversionFailedError(`Invalid image: the JPEG XR header could not be read (${reason}).`);
}

/** The offset of the codestream of the first image of the container: tag 0xBCC0 of its first directory, of a count of 1 and the type byte, short or long. */
function codestreamOffset(bytes: Buffer): number {
  if (bytes[3] > CONTAINER_VERSION_MAX) throw unreadable('unknown container version');
  const directory = bytes.readUInt32LE(IFD_OFFSET_AT);
  if (directory % 2 !== 0 || directory + IFD_COUNT_BYTES > bytes.length) throw unreadable('the directory is not inside the file');
  const entries = bytes.readUInt16LE(directory);
  if (directory + IFD_COUNT_BYTES + entries * IFD_ENTRY_BYTES + NEXT_DIRECTORY_BYTES > bytes.length) throw unreadable('the directory runs past the end of the file');
  for (let index = 0; index < entries; index += 1) {
    const at = directory + IFD_COUNT_BYTES + index * IFD_ENTRY_BYTES;
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
