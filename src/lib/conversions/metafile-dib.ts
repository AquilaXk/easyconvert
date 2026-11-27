import { CadGeometryUnavailableError } from '../types';

/**
 * The device-independent bitmap (BITMAPINFOHEADER, colour table, bits) of a region picture, for the bitmap records of EMF and WMF.
 * A region with at most 256 colours is written with the least depth that holds them (1, 4 or 8 bits a pixel and a colour table of
 * exactly its colours), any other region as 24 bits, all uncompressed (BI_RGB). Nothing is quantized: a reader draws the same pixels
 * from every layout.
 *
 * The layouts are those of the Windows bitmap formats (MS-EMF 2.2.2, MS-WMF 2.2.2.3). The office suite's own writers keep the palette
 * of a bitmap that has one (`vcl/source/bitmap/dibtools.cxx` `ImplWriteDIBBody`, depth 1, 8 or 24, lines 1383 to 1387) and write any
 * other as 24 bits, and the reference's writer writes every bitmap as 32 bits (`emf-print.cpp` line 1714). Run-length coding (BI_RLE8,
 * which the office suite adds to an 8-bit bitmap in EMF, line 1391) is not written: the reference's reader draws a bitmap only when it is
 * BI_RGB (`emf-inout.cpp` lines 474 to 487) and showed a placeholder for BI_RLE8 in EMF and WMF when measured. BI_PNG and BI_JPEG are
 * not written either: the specifications leave them to printer drivers and the office suite does not read them (`dibtools.cxx` line 773).
 */

/** Most colours a region may hold to be written with a colour table (the 8-bit depth). */
export const MAX_PALETTE_COLOURS = 256;

const BYTES_PER_PIXEL = 3;
const INFO_HEADER_BYTES = 40;
const COLOUR_ENTRY_BYTES = 4;
const ROW_ALIGNMENT = 4;
const BI_RGB = 0;
/** One bit of the 10-bit hash of a colour, over 1,024 slots for at most 256 colours. */
const HASH_SHIFT = 22;
const HASH_SLOTS = 1 << (32 - HASH_SHIFT);
const HASH_MULTIPLIER = 0x9e3779b1;

/** What a region holds: top-down RGB rows (3 bytes a pixel), `width` by `height` pixels. */
export interface DibSource {
  width: number;
  height: number;
  rgb: Buffer;
}

/** A bitmap as the records hold it: `dib` is the info header and the colour table (`infoBytes` of them), then the bits (`bitsBytes`). */
export interface EncodedDib {
  dib: Buffer;
  infoBytes: number;
  bitsBytes: number;
}

const alignRow = (bits: number): number => Math.ceil(bits / (ROW_ALIGNMENT * 8)) * ROW_ALIGNMENT;

/** The bytes of the 24-bit bitmap of a region, which is the most any picture of that size takes in a record. */
export function rgb24DibBytes(bitmap: Pick<DibSource, 'width' | 'height'>): number {
  return INFO_HEADER_BYTES + alignRow(bitmap.width * BYTES_PER_PIXEL * 8) * bitmap.height;
}

function assertSize(bitmap: DibSource): void {
  if (!(bitmap.width > 0 && bitmap.height > 0) || bitmap.rgb.length !== bitmap.width * bitmap.height * BYTES_PER_PIXEL) {
    throw new CadGeometryUnavailableError(`A page region of ${bitmap.width} by ${bitmap.height} pixels holds ${bitmap.rgb.length} bytes of colour.`);
  }
}

interface IndexedPicture {
  /** The index of each pixel's colour in `palette`, top row first. */
  indices: Uint8Array;
  /** The colours as 0x00RRGGBB, in the order they first appear. */
  palette: Uint32Array;
  colours: number;
}

/** Gives each colour of the picture the next index when it first appears, in one pass; `undefined` as soon as a 257th colour is met. */
function indexColours(rgb: Buffer, pixels: number): IndexedPicture | undefined {
  const indices = new Uint8Array(pixels);
  const palette = new Uint32Array(MAX_PALETTE_COLOURS);
  /** The index plus one of the colour in a slot, 0 for an empty slot. */
  const slots = new Uint16Array(HASH_SLOTS);
  let colours = 0;
  let previous = -1;
  let previousIndex = 0;
  for (let pixel = 0, at = 0; pixel < pixels; pixel++, at += BYTES_PER_PIXEL) {
    const colour = (rgb[at] << 16) | (rgb[at + 1] << 8) | rgb[at + 2];
    if (colour !== previous) {
      let slot = Math.imul(colour, HASH_MULTIPLIER) >>> HASH_SHIFT;
      for (;;) {
        const held = slots[slot];
        if (held === 0) {
          if (colours === MAX_PALETTE_COLOURS) return undefined;
          palette[colours] = colour;
          slots[slot] = ++colours;
          previousIndex = colours - 1;
          break;
        }
        if (palette[held - 1] === colour) {
          previousIndex = held - 1;
          break;
        }
        slot = (slot + 1) & (HASH_SLOTS - 1);
      }
      previous = colour;
    }
    indices[pixel] = previousIndex;
  }
  return { indices, palette, colours };
}

function writeInfoHeader(dib: Buffer, source: DibSource, bitCount: number, compression: number, sizeImage: number, colours: number): void {
  dib.writeUInt32LE(INFO_HEADER_BYTES, 0);
  dib.writeInt32LE(source.width, 4);
  dib.writeInt32LE(source.height, 8); // positive: rows run from the bottom up
  dib.writeUInt16LE(1, 12); // planes
  dib.writeUInt16LE(bitCount, 14);
  dib.writeUInt32LE(compression, 16);
  dib.writeUInt32LE(sizeImage, 20);
  dib.writeUInt32LE(colours, 32); // biClrUsed
}

function writePalette(dib: Buffer, picture: IndexedPicture): void {
  // A colour as 0x00RRGGBB in little-endian order is the blue, green, red, 0 of an entry of the colour table.
  for (let i = 0; i < picture.colours; i++) dib.writeUInt32LE(picture.palette[i], INFO_HEADER_BYTES + i * COLOUR_ENTRY_BYTES);
}

/** The indices as rows of `bitCount` bits (1, 4 or 8) from the bottom up, each padded to 4 bytes, the leftmost pixel in the high bits. */
function packRows(dib: Buffer, from: number, indices: Uint8Array, width: number, height: number, bitCount: number): void {
  const stride = alignRow(width * bitCount);
  const perByte = 8 / bitCount;
  for (let y = 0; y < height; y++) {
    let to = from + (height - 1 - y) * stride;
    const row = y * width;
    for (let x = 0; x < width; x += perByte) {
      let packed = 0;
      for (let k = 0; k < perByte; k++) packed = (packed << bitCount) | (x + k < width ? indices[row + x + k] : 0);
      dib[to++] = packed;
    }
  }
}

/** The least depth of a bitmap with a colour table that holds `colours` entries. */
function bitCountFor(colours: number): 1 | 4 | 8 {
  if (colours <= 2) return 1;
  return colours <= 16 ? 4 : 8;
}

function encodeIndexed(source: DibSource, picture: IndexedPicture): EncodedDib {
  const { width, height } = source;
  const bitCount = bitCountFor(picture.colours);
  const infoBytes = INFO_HEADER_BYTES + picture.colours * COLOUR_ENTRY_BYTES;
  const bitsBytes = alignRow(width * bitCount) * height;
  const dib = Buffer.alloc(infoBytes + bitsBytes);
  writeInfoHeader(dib, source, bitCount, BI_RGB, bitsBytes, picture.colours);
  writePalette(dib, picture);
  packRows(dib, infoBytes, picture.indices, width, height, bitCount);
  return { dib, infoBytes, bitsBytes };
}

function encodeRgb24(source: DibSource): EncodedDib {
  const { width, height, rgb } = source;
  const stride = alignRow(width * BYTES_PER_PIXEL * 8);
  const dib = Buffer.alloc(rgb24DibBytes(source));
  writeInfoHeader(dib, source, BYTES_PER_PIXEL * 8, BI_RGB, stride * height, 0);
  for (let y = 0; y < height; y++) {
    let to = INFO_HEADER_BYTES + (height - 1 - y) * stride;
    for (let from = y * width * BYTES_PER_PIXEL, end = from + width * BYTES_PER_PIXEL; from < end; from += BYTES_PER_PIXEL) {
      dib[to++] = rgb[from + 2];
      dib[to++] = rgb[from + 1];
      dib[to++] = rgb[from];
    }
  }
  return { dib, infoBytes: INFO_HEADER_BYTES, bitsBytes: stride * height };
}

/** The bitmap of a region in the shortest of the layouts above that holds its pixels exactly. */
export function encodeDib(source: DibSource): EncodedDib {
  assertSize(source);
  const picture = indexColours(source.rgb, source.width * source.height);
  return picture ? encodeIndexed(source, picture) : encodeRgb24(source);
}
