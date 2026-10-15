import { ConversionFailedError } from '../types';

/**
 * EXIF orientation (CIPA DC-008 / TIFF 6.0 tag 0x0112) for frames that libvips cannot orient in bulk:
 * pixel remapping of 8-bit RGBA frames, and rewriting the tag in a kept EXIF block.
 */

export const EXIF_ORIENTATION_NORMAL = 1;
const MIRROR_HORIZONTAL = 2;
const ROTATE_HALF_TURN = 3;
const MIRROR_VERTICAL = 4;
const TRANSPOSE = 5;
const ROTATE_CLOCKWISE = 6;
const TRANSVERSE = 7;

const RGBA_BYTES_PER_PIXEL = 4;
const MIN_ORIENTATION = 1;
const MAX_ORIENTATION = 8;
/** Orientations 5 to 8 turn the picture a quarter turn, so width and height swap. */
const FIRST_QUARTER_TURN_ORIENTATION = TRANSPOSE;

const TAG_ORIENTATION = 0x0112;
const TYPE_SHORT = 3;
const TIFF_MAGIC = 42;
const TIFF_HEADER_BYTES = 8;
const IFD_COUNT_BYTES = 2;
const IFD_ENTRY_BYTES = 12;
const IFD_ENTRY_VALUE_OFFSET = 8;
const IFD_ENTRY_TYPE_OFFSET = 2;
const EXIF_PREFIX = 'Exif\0\0';

export interface OrientableFrame {
  data: Buffer;
  width: number;
  height: number;
}

/**
 * Remaps the pixels of an RGBA frame so a viewer applying nothing sees what EXIF `orientation` (1 to 8)
 * asks for. Returns the input untouched for orientation 1.
 */
export function orientRgbaFrame(frame: OrientableFrame, orientation: number): OrientableFrame {
  if (!Number.isInteger(orientation) || orientation < MIN_ORIENTATION || orientation > MAX_ORIENTATION) {
    throw new ConversionFailedError(`Unsupported EXIF orientation ${String(orientation)}: expected 1 to 8`);
  }
  if (orientation === EXIF_ORIENTATION_NORMAL) return frame;
  const { width, height } = frame;
  const swaps = orientation >= FIRST_QUARTER_TURN_ORIENTATION;
  const outWidth = swaps ? height : width;
  const outHeight = swaps ? width : height;
  const source = new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.length);
  const out = Buffer.alloc(outWidth * outHeight * RGBA_BYTES_PER_PIXEL);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [ox, oy] = mapPixel(orientation, x, y, width, height);
      const from = (y * width + x) * RGBA_BYTES_PER_PIXEL;
      const to = (oy * outWidth + ox) * RGBA_BYTES_PER_PIXEL;
      out[to] = source[from];
      out[to + 1] = source[from + 1];
      out[to + 2] = source[from + 2];
      out[to + 3] = source[from + 3];
    }
  }
  return { data: out, width: outWidth, height: outHeight };
}

/** Destination of source pixel (x, y) of a width x height frame for EXIF orientation 2 to 8. */
function mapPixel(orientation: number, x: number, y: number, width: number, height: number): [number, number] {
  switch (orientation) {
    case MIRROR_HORIZONTAL:
      return [width - 1 - x, y];
    case ROTATE_HALF_TURN:
      return [width - 1 - x, height - 1 - y];
    case MIRROR_VERTICAL:
      return [x, height - 1 - y];
    case TRANSPOSE:
      return [y, x];
    case ROTATE_CLOCKWISE:
      return [height - 1 - y, x];
    case TRANSVERSE:
      return [height - 1 - y, width - 1 - x];
    default: // 8: rotate counter-clockwise
      return [y, width - 1 - x];
  }
}

/**
 * Copy of an EXIF block (with or without the `Exif\0\0` prefix) whose Orientation is set to 1, so metadata kept
 * on an output whose pixels are already upright never asks a viewer to rotate them again. A block without an
 * Orientation entry, or one that cannot be parsed, is returned unchanged.
 */
export function withUprightOrientation(exif: Buffer): Buffer {
  const copy = Buffer.from(exif);
  const tiffStart = copy.toString('latin1', 0, EXIF_PREFIX.length) === EXIF_PREFIX ? EXIF_PREFIX.length : 0;
  if (copy.length < tiffStart + TIFF_HEADER_BYTES) return copy;
  const order = copy.toString('latin1', tiffStart, tiffStart + 2);
  if (order !== 'II' && order !== 'MM') return copy;
  const little = order === 'II';
  const u16 = (at: number) => (little ? copy.readUInt16LE(at) : copy.readUInt16BE(at));
  const u32 = (at: number) => (little ? copy.readUInt32LE(at) : copy.readUInt32BE(at));
  if (u16(tiffStart + 2) !== TIFF_MAGIC) return copy;
  const ifd = tiffStart + u32(tiffStart + 4);
  if (ifd + IFD_COUNT_BYTES > copy.length) return copy;
  const count = u16(ifd);
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + IFD_COUNT_BYTES + index * IFD_ENTRY_BYTES;
    if (entry + IFD_ENTRY_BYTES > copy.length) return copy;
    if (u16(entry) === TAG_ORIENTATION && u16(entry + IFD_ENTRY_TYPE_OFFSET) === TYPE_SHORT) {
      if (little) copy.writeUInt16LE(EXIF_ORIENTATION_NORMAL, entry + IFD_ENTRY_VALUE_OFFSET);
      else copy.writeUInt16BE(EXIF_ORIENTATION_NORMAL, entry + IFD_ENTRY_VALUE_OFFSET);
      return copy;
    }
  }
  return copy;
}
