import { ConversionFailedError } from '../types';
import { assertInputPixels } from './image-input-limits';

/**
 * Windows and OS/2 bitmap decoder, after the Microsoft BMP file format (BITMAPCOREHEADER, BITMAPINFOHEADER,
 * BITMAPV4HEADER and BITMAPV5HEADER). Everything the header declares is checked against the file before any
 * pixel buffer is allocated, so a small file cannot make the decoder allocate a large canvas. The pixel limit
 * answers HTTP 413 (`InputPixelLimitError`); every other malformed file is a `BmpDecodeError` (HTTP 400).
 */

/** A bitmap that is malformed, truncated, or uses a feature this decoder does not read (HTTP 400). */
export class BmpDecodeError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'BmpDecodeError';
  }
}

export interface DecodedBmp {
  /** Interleaved 8-bit R, G, B, A, row-major, top row first. */
  raw: Buffer;
  width: number;
  height: number;
  channels: 4;
  /** True when the alpha channel carries transparency (a 32-bit alpha, bit-field alpha or an icon mask). */
  hasAlpha: boolean;
  /** Embedded ICC profile of a BITMAPV5HEADER (`PROFILE_EMBEDDED`), when present. */
  icc?: Buffer;
}

export interface DibOptions {
  /** The bitmap is an icon image: the height covers the colour bitmap and a 1-bit AND mask stacked below it. */
  icon?: boolean;
}

const FILE_HEADER_BYTES = 14;
const FILE_SIGNATURE = 'BM';
const PIXEL_OFFSET_FIELD = 10;
const CORE_HEADER_BYTES = 12;
const INFO_HEADER_BYTES = 40;
const V2_HEADER_BYTES = 52;
const V3_HEADER_BYTES = 56;
const V4_HEADER_BYTES = 108;
const V5_HEADER_BYTES = 124;
const KNOWN_HEADER_SIZES: ReadonlySet<number> = new Set([
  CORE_HEADER_BYTES,
  INFO_HEADER_BYTES,
  V2_HEADER_BYTES,
  V3_HEADER_BYTES,
  V4_HEADER_BYTES,
  V5_HEADER_BYTES,
]);

const BI_RGB = 0;
const BI_RLE8 = 1;
const BI_RLE4 = 2;
const BI_BITFIELDS = 3;
const BI_ALPHABITFIELDS = 6;

/** Bit depths the format defines; the OS/2 core header has no 16- or 32-bit form. */
const BIT_DEPTHS: ReadonlySet<number> = new Set([1, 4, 8, 16, 24, 32]);
const CORE_BIT_DEPTHS: ReadonlySet<number> = new Set([1, 4, 8, 24]);

const BYTE_MAX = 255;
const PALETTE_MAX_ENTRIES = 256;
const PALETTE_ENTRY_BYTES = 4;
const CORE_PALETTE_ENTRY_BYTES = 3;
const RGBA_CHANNELS = 4;
const DEFAULT_MASKS_555 = { r: 0x7c00, g: 0x03e0, b: 0x001f, a: 0 };
const DEFAULT_MASKS_888 = { r: 0x00ff0000, g: 0x0000ff00, b: 0x000000ff, a: 0xff000000 };
/** Colour space types of BITMAPV4/V5HEADER (`bV5CSType`): LCS_sRGB and PROFILE_EMBEDDED, as ASCII tags. */
const CS_TYPE_EMBEDDED_PROFILE = 0x4d424544;
/** Largest ICC profile read from a bitmap. */
export const BMP_ICC_MAX_BYTES = 16 * 1024 * 1024;
/**
 * Most pixels one byte of a run-length stream may account for. An encoded run covers up to 255 pixels per 2
 * bytes and a delta jumps over any number, so a stream that describes more than this per byte is a decompression
 * bomb or a sparse picture too small to be worth the canvas; either is refused before the canvas is allocated.
 */
export const BMP_RLE_MAX_PIXELS_PER_BYTE = 1024;
const RLE_ESCAPE = 0;
const RLE_END_OF_LINE = 0;
const RLE_END_OF_BITMAP = 1;
const RLE_DELTA = 2;
const BITS_PER_BYTE = 8;
const MASK_ROW_ALIGN_BITS = 32;
const ROW_ALIGN_BYTES = 4;
const NIBBLE_BITS = 4;
const NIBBLE_MASK = 0x0f;
const WORD_BYTES = 2;

interface ChannelMasks {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface BmpHeader {
  headerBytes: number;
  isCore: boolean;
  width: number;
  /** Rows of the colour bitmap (half the stored height for icons). */
  rows: number;
  topDown: boolean;
  bitCount: number;
  compression: number;
  sizeImage: number;
  clrUsed: number;
  masks: ChannelMasks | null;
  maskBytes: number;
  iccOffset: number;
  iccSize: number;
  hasEmbeddedProfile: boolean;
}

function fail(message: string): never {
  throw new BmpDecodeError(`Invalid BMP: ${message}`);
}

function readHeader(buf: Buffer, base: number, options: DibOptions): BmpHeader {
  if (buf.length < base + 4) fail(`the file ends inside the header (${buf.length} bytes).`);
  const headerBytes = buf.readUInt32LE(base);
  if (!KNOWN_HEADER_SIZES.has(headerBytes)) fail(`the DIB header size ${headerBytes} is not one of 12, 40, 52, 56, 108 or 124.`);
  if (base + headerBytes > buf.length) fail(`the ${headerBytes}-byte header runs past the end of the ${buf.length}-byte file.`);

  const isCore = headerBytes === CORE_HEADER_BYTES;
  let width: number;
  let storedHeight: number;
  let bitCount: number;
  let compression = BI_RGB;
  let sizeImage = 0;
  let clrUsed = 0;
  if (isCore) {
    width = buf.readUInt16LE(base + 4);
    storedHeight = buf.readUInt16LE(base + 6);
    bitCount = buf.readUInt16LE(base + 10);
    if (buf.readUInt16LE(base + 8) !== 1) fail('the plane count is not 1.');
  } else {
    width = buf.readInt32LE(base + 4);
    storedHeight = buf.readInt32LE(base + 8);
    bitCount = buf.readUInt16LE(base + 14);
    compression = buf.readUInt32LE(base + 16);
    sizeImage = buf.readUInt32LE(base + 20);
    clrUsed = buf.readUInt32LE(base + 32);
    if (buf.readUInt16LE(base + 12) !== 1) fail('the plane count is not 1.');
  }

  if (width <= 0 || storedHeight === 0) fail(`the dimensions ${width}x${storedHeight} are not positive.`);
  const depths = isCore ? CORE_BIT_DEPTHS : BIT_DEPTHS;
  if (!depths.has(bitCount)) fail(`${bitCount} bits per pixel is not a BMP bit depth.`);
  const known = [BI_RGB, BI_RLE8, BI_RLE4, BI_BITFIELDS, BI_ALPHABITFIELDS];
  if (!known.includes(compression)) fail(`compression type ${compression} is not supported.`);
  if (compression === BI_RLE8 && bitCount !== 8) fail('RLE8 compression needs 8 bits per pixel.');
  if (compression === BI_RLE4 && bitCount !== 4) fail('RLE4 compression needs 4 bits per pixel.');
  const isBitfields = compression === BI_BITFIELDS || compression === BI_ALPHABITFIELDS;
  if (isBitfields && bitCount !== 16 && bitCount !== 32) fail('bit-field masks need 16 or 32 bits per pixel.');
  const isRle = compression === BI_RLE8 || compression === BI_RLE4;
  const topDown = storedHeight < 0;
  if (topDown && isRle) fail('a top-down bitmap cannot be run-length encoded.');

  let rows = Math.abs(storedHeight);
  if (options.icon) {
    if (topDown || rows % 2 !== 0) fail(`an icon image stores a colour bitmap and a mask, so its height ${storedHeight} must be positive and even.`);
    rows /= 2;
  }

  // Bit-field masks: after the 40-byte header as separate DWORDs, inside the larger headers.
  let masks: ChannelMasks | null = null;
  let maskBytes = 0;
  if (isBitfields) {
    const maskAt = base + INFO_HEADER_BYTES;
    const wanted = compression === BI_ALPHABITFIELDS ? 4 : 3;
    if (headerBytes === INFO_HEADER_BYTES) {
      maskBytes = wanted * 4;
      if (maskAt + maskBytes > buf.length) fail('the bit-field masks run past the end of the file.');
    }
    const hasAlphaMask = headerBytes >= V3_HEADER_BYTES || (headerBytes === INFO_HEADER_BYTES && wanted === 4);
    const alpha = hasAlphaMask ? buf.readUInt32LE(maskAt + 12) : 0;
    masks = { r: buf.readUInt32LE(maskAt), g: buf.readUInt32LE(maskAt + 4), b: buf.readUInt32LE(maskAt + 8), a: alpha };
    for (const [name, mask] of [['red', masks.r], ['green', masks.g], ['blue', masks.b]] as const) {
      if (mask === 0) fail(`the ${name} bit-field mask is empty.`);
    }
    const limit = bitCount === 16 ? 0xffff : 0xffffffff;
    for (const mask of [masks.r, masks.g, masks.b, masks.a]) {
      if (mask > limit) fail(`a bit-field mask 0x${mask.toString(16)} is wider than ${bitCount} bits.`);
    }
  } else if (bitCount === 16) {
    masks = DEFAULT_MASKS_555;
  } else if (bitCount === 32) {
    masks = DEFAULT_MASKS_888;
  }

  let iccOffset = 0;
  let iccSize = 0;
  let hasEmbeddedProfile = false;
  if (headerBytes === V5_HEADER_BYTES && buf.readUInt32LE(base + 56) === CS_TYPE_EMBEDDED_PROFILE) {
    hasEmbeddedProfile = true;
    iccOffset = buf.readUInt32LE(base + 112);
    iccSize = buf.readUInt32LE(base + 116);
  }

  return { headerBytes, isCore, width, rows, topDown, bitCount, compression, sizeImage, clrUsed, masks, maskBytes, iccOffset, iccSize, hasEmbeddedProfile };
}

/** Reads the colour table that follows the header (and bit-field masks); returns RGB triples as 0xRRGGBB. */
function readPalette(buf: Buffer, base: number, header: BmpHeader): Uint32Array | null {
  if (header.bitCount > BITS_PER_BYTE) return null;
  const capacity = 1 << header.bitCount;
  const entries = header.isCore || header.clrUsed === 0 ? capacity : header.clrUsed;
  if (entries > capacity || entries > PALETTE_MAX_ENTRIES) {
    fail(`the colour table declares ${entries} entries, more than the ${capacity} that ${header.bitCount} bits can index.`);
  }
  const entryBytes = header.isCore ? CORE_PALETTE_ENTRY_BYTES : PALETTE_ENTRY_BYTES;
  const at = base + header.headerBytes + header.maskBytes;
  if (at + entries * entryBytes > buf.length) {
    fail(`the ${entries}-entry colour table at byte ${at} runs past the end of the ${buf.length}-byte file.`);
  }
  const palette = new Uint32Array(entries);
  for (let i = 0; i < entries; i += 1) {
    const p = at + i * entryBytes;
    palette[i] = (buf[p + 2] << 16) | (buf[p + 1] << 8) | buf[p];
  }
  return palette;
}

function rowStride(bitCount: number, width: number): number {
  return Math.floor((bitCount * width + (MASK_ROW_ALIGN_BITS - 1)) / MASK_ROW_ALIGN_BITS) * ROW_ALIGN_BYTES;
}

/** Shift and bit width of a mask; the sample is `(pixel & mask) >>> shift`. */
function maskLayout(mask: number): { shift: number; bits: number } {
  if (mask === 0) return { shift: 0, bits: 0 };
  let shift = 0;
  while (((mask >>> shift) & 1) === 0) shift += 1;
  let bits = 0;
  while (shift + bits < MASK_ROW_ALIGN_BITS && ((mask >>> (shift + bits)) & 1) === 1) bits += 1;
  return { shift, bits };
}

/**
 * Widens a `bits`-wide sample to 8 bits by repeating its bit pattern (5-bit 0b10110 becomes 0b10110101), the
 * conversion every common decoder uses so that all-ones stays 255; wider samples keep their top 8 bits.
 */
function scaleTo8(value: number, bits: number): number {
  if (bits >= BITS_PER_BYTE) return value >>> (bits - BITS_PER_BYTE);
  let widened = 0;
  for (let position = BITS_PER_BYTE; position > 0; position -= bits) {
    const take = Math.min(bits, position);
    widened |= (value >>> (bits - take)) << (position - take);
  }
  return widened;
}

function channelTable(mask: number): { shift: number; bits: number; table: Uint8Array | null } {
  const { shift, bits } = maskLayout(mask);
  if (bits === 0 || bits > 16) return { shift, bits, table: null };
  const table = new Uint8Array(1 << bits);
  for (let v = 0; v < table.length; v += 1) table[v] = scaleTo8(v, bits);
  return { shift, bits, table };
}

function extract(pixel: number, mask: number, ch: { shift: number; bits: number; table: Uint8Array | null }): number {
  const value = ((pixel & mask) >>> ch.shift) >>> 0;
  return ch.table ? ch.table[value] : scaleTo8(value, ch.bits);
}

/** log2 of the pixels per byte of each indexed depth. */
const PIXELS_PER_BYTE_SHIFT: Readonly<Record<number, number>> = { 1: 3, 4: 1, 8: 0 };

function indexedRowsToRgba(
  buf: Buffer,
  at: number,
  header: BmpHeader,
  palette: Uint32Array,
  out: Buffer
): void {
  const { width, rows, bitCount, topDown } = header;
  const stride = rowStride(bitCount, width);
  const perByte = BITS_PER_BYTE / bitCount;
  const indexMask = (1 << bitCount) - 1;
  for (let stored = 0; stored < rows; stored += 1) {
    const y = topDown ? stored : rows - 1 - stored;
    const row = at + stored * stride;
    let o = y * width * RGBA_CHANNELS;
    for (let x = 0; x < width; x += 1) {
      const byte = buf[row + (x >>> PIXELS_PER_BYTE_SHIFT[bitCount])];
      const slot = x & (perByte - 1);
      const index = (byte >>> (BITS_PER_BYTE - bitCount * (slot + 1))) & indexMask;
      if (index >= palette.length) fail(`pixel (${x}, ${y}) uses colour index ${index}, but the colour table has ${palette.length} entries.`);
      const rgb = palette[index];
      out[o] = (rgb >>> 16) & BYTE_MAX;
      out[o + 1] = (rgb >>> 8) & BYTE_MAX;
      out[o + 2] = rgb & BYTE_MAX;
      out[o + 3] = BYTE_MAX;
      o += RGBA_CHANNELS;
    }
  }
}

function trueColourRowsToRgba(buf: Buffer, at: number, header: BmpHeader, out: Buffer): boolean {
  const { width, rows, bitCount, topDown, masks } = header;
  const stride = rowStride(bitCount, width);
  let anyAlpha = false;
  if (bitCount === 24) {
    for (let stored = 0; stored < rows; stored += 1) {
      const y = topDown ? stored : rows - 1 - stored;
      let p = at + stored * stride;
      let o = y * width * RGBA_CHANNELS;
      for (let x = 0; x < width; x += 1) {
        out[o] = buf[p + 2];
        out[o + 1] = buf[p + 1];
        out[o + 2] = buf[p];
        out[o + 3] = BYTE_MAX;
        p += 3;
        o += RGBA_CHANNELS;
      }
    }
    return false;
  }
  const m = masks as ChannelMasks;
  const red = channelTable(m.r);
  const green = channelTable(m.g);
  const blue = channelTable(m.b);
  const alpha = channelTable(m.a);
  const hasAlphaMask = m.a !== 0;
  const bytes = bitCount / BITS_PER_BYTE;
  for (let stored = 0; stored < rows; stored += 1) {
    const y = topDown ? stored : rows - 1 - stored;
    let p = at + stored * stride;
    let o = y * width * RGBA_CHANNELS;
    for (let x = 0; x < width; x += 1) {
      const pixel = bytes === 2 ? buf.readUInt16LE(p) : buf.readUInt32LE(p);
      out[o] = extract(pixel, m.r, red);
      out[o + 1] = extract(pixel, m.g, green);
      out[o + 2] = extract(pixel, m.b, blue);
      const a = hasAlphaMask ? extract(pixel, m.a, alpha) : BYTE_MAX;
      out[o + 3] = a;
      if (hasAlphaMask && a !== 0) anyAlpha = true;
      p += bytes;
      o += RGBA_CHANNELS;
    }
  }
  if (hasAlphaMask && !anyAlpha && header.compression === BI_RGB) {
    // A 32-bit BI_RGB bitmap does not define its fourth byte as alpha; all zero means the byte is unused.
    for (let o = 3; o < out.length; o += RGBA_CHANNELS) out[o] = BYTE_MAX;
    return false;
  }
  return hasAlphaMask;
}

/**
 * Expands a BI_RLE8 or BI_RLE4 stream into colour indices (rows stored bottom-up). Encoded runs repeat one
 * index, absolute runs copy literals padded to a 16-bit boundary, and escapes end a line or the bitmap or move
 * the cursor. Pixels the stream never writes keep index 0. Reading never passes `end`, and a run or move that
 * leaves the bitmap is an error rather than a clipped write.
 */
function expandRle(buf: Buffer, start: number, end: number, header: BmpHeader): Uint8Array {
  const { width, rows } = header;
  const isRle4 = header.compression === BI_RLE4;
  // Encoders pad each row's runs to the 4-byte row alignment; those pixels lie outside the picture and are dropped.
  const paddedWidth = (rowStride(header.bitCount, width) * BITS_PER_BYTE) / header.bitCount;
  const indices = new Uint8Array(width * rows);
  let x = 0;
  let row = 0; // stored row, 0 is the bottom row of a bottom-up bitmap
  let p = start;
  const put = (index: number): void => {
    if (x >= paddedWidth || row >= rows) fail('a run-length run leaves the bitmap.');
    if (x < width) indices[(rows - 1 - row) * width + x] = index;
    x += 1;
  };
  while (p + 1 < end) {
    const count = buf[p];
    const value = buf[p + 1];
    p += WORD_BYTES;
    if (count !== RLE_ESCAPE) {
      for (let i = 0; i < count; i += 1) {
        if (isRle4) put(i % 2 === 0 ? value >>> NIBBLE_BITS : value & NIBBLE_MASK);
        else put(value);
      }
      continue;
    }
    if (value === RLE_END_OF_LINE) {
      x = 0;
      row += 1;
      continue;
    }
    if (value === RLE_END_OF_BITMAP) return indices;
    if (value === RLE_DELTA) {
      if (p + 1 >= end) fail('the run-length stream ends inside a delta escape.');
      x += buf[p];
      row += buf[p + 1];
      p += WORD_BYTES;
      if (x > paddedWidth || row > rows) fail('a run-length delta moves the cursor outside the bitmap.');
      continue;
    }
    // Absolute mode: `value` literal pixels, then padding to a word boundary.
    const literalBytes = isRle4 ? Math.ceil(value / 2) : value;
    if (p + literalBytes > end) fail('the run-length stream ends inside an absolute run.');
    for (let i = 0; i < value; i += 1) {
      if (isRle4) {
        const byte = buf[p + (i >>> 1)];
        put(i % 2 === 0 ? byte >>> NIBBLE_BITS : byte & NIBBLE_MASK);
      } else {
        put(buf[p + i]);
      }
    }
    p += literalBytes + (literalBytes % WORD_BYTES);
  }
  return indices;
}

function rleToRgba(indices: Uint8Array, header: BmpHeader, palette: Uint32Array, out: Buffer): void {
  const pixels = header.width * header.rows;
  for (let i = 0; i < pixels; i += 1) {
    const index = indices[i];
    if (index >= palette.length) fail(`a pixel uses colour index ${index}, but the colour table has ${palette.length} entries.`);
    const rgb = palette[index];
    const o = i * RGBA_CHANNELS;
    out[o] = (rgb >>> 16) & BYTE_MAX;
    out[o + 1] = (rgb >>> 8) & BYTE_MAX;
    out[o + 2] = rgb & BYTE_MAX;
    out[o + 3] = BYTE_MAX;
  }
}

/** Applies the 1-bit AND mask of an icon (1 is transparent), rows stored bottom-up. */
function applyIconMask(buf: Buffer, at: number, width: number, rows: number, out: Buffer): void {
  const stride = rowStride(1, width);
  for (let stored = 0; stored < rows; stored += 1) {
    const y = rows - 1 - stored;
    const row = at + stored * stride;
    for (let x = 0; x < width; x += 1) {
      const bit = (buf[row + (x >>> 3)] >>> (7 - (x & 7))) & 1;
      if (bit === 1) out[(y * width + x) * RGBA_CHANNELS + 3] = 0;
    }
  }
}

function readEmbeddedProfile(buf: Buffer, base: number, header: BmpHeader): Buffer | undefined {
  if (!header.hasEmbeddedProfile) return undefined;
  if (header.iccSize === 0) return undefined;
  if (header.iccSize > BMP_ICC_MAX_BYTES) fail(`the embedded ICC profile is ${header.iccSize} bytes, over the ${BMP_ICC_MAX_BYTES} byte limit.`);
  // The profile offset is counted from the start of the BITMAPV5HEADER.
  const at = base + header.iccOffset;
  if (header.iccOffset < header.headerBytes || at + header.iccSize > buf.length) {
    fail(`the embedded ICC profile (${header.iccSize} bytes at offset ${header.iccOffset}) lies outside the file.`);
  }
  return Buffer.from(buf.subarray(at, at + header.iccSize));
}

function decodeBitmap(buf: Buffer, base: number, pixelOffset: number | null, options: DibOptions): DecodedBmp {
  const header = readHeader(buf, base, options);
  const palette = readPalette(buf, base, header);
  const { width, rows, bitCount } = header;
  // Dimensions come from the header alone, so the pixel limit is answered (413) before the file is judged.
  assertInputPixels(width, rows);

  const dataStart = pixelOffset ?? base + header.headerBytes + header.maskBytes + (palette ? palette.length * (header.isCore ? CORE_PALETTE_ENTRY_BYTES : PALETTE_ENTRY_BYTES) : 0);
  if (dataStart > buf.length || dataStart < base + header.headerBytes) {
    fail(`the pixel data offset ${dataStart} is outside the ${buf.length}-byte file.`);
  }
  const available = buf.length - dataStart;
  if (header.sizeImage > available) {
    fail(`the header declares ${header.sizeImage} bytes of pixel data but only ${available} follow offset ${dataStart}.`);
  }

  const out = (): Buffer => Buffer.alloc(width * rows * RGBA_CHANNELS);
  const icc = readEmbeddedProfile(buf, base, header);
  const isRle = header.compression === BI_RLE8 || header.compression === BI_RLE4;
  let raw: Buffer;
  let hasAlpha = false;
  if (isRle) {
    const streamBytes = header.sizeImage > 0 ? header.sizeImage : available;
    if (width * rows > BMP_RLE_MAX_PIXELS_PER_BYTE * streamBytes) {
      fail(`a ${streamBytes}-byte run-length stream cannot describe ${width}x${rows} pixels.`);
    }
    if (!palette) fail('run-length data needs a colour table.');
    const indices = expandRle(buf, dataStart, dataStart + streamBytes, header);
    raw = out();
    rleToRgba(indices, header, palette, raw);
  } else {
    const stride = rowStride(bitCount, width);
    const need = stride * rows;
    if (need > available) {
      fail(
        `the header declares ${width}x${rows} pixels at ${bitCount} bits (${need} bytes of pixel data from offset ${dataStart}), but the file ends at byte ${buf.length}.`
      );
    }
    raw = out();
    if (palette) indexedRowsToRgba(buf, dataStart, header, palette, raw);
    else hasAlpha = trueColourRowsToRgba(buf, dataStart, header, raw);
    if (options.icon) {
      const maskAt = dataStart + need;
      const maskNeed = rowStride(1, width) * rows;
      if (maskAt + maskNeed <= buf.length) {
        // A 32-bit icon with real alpha ignores its mask; every other icon takes its transparency from it.
        if (!hasAlpha) {
          applyIconMask(buf, maskAt, width, rows, raw);
          hasAlpha = true;
        }
      } else if (bitCount !== 32) {
        fail(`the icon mask (${maskNeed} bytes) runs past the end of the file.`);
      }
    }
  }
  return { raw, width, height: rows, channels: RGBA_CHANNELS, hasAlpha, icc };
}

/** Decodes a BMP file (`BM` file header, then the DIB header, colour table and pixels) to 8-bit RGBA. */
export function decodeBmp(buf: Buffer): DecodedBmp {
  if (buf.length < FILE_HEADER_BYTES + 4 || buf.toString('ascii', 0, 2) !== FILE_SIGNATURE) {
    throw new BmpDecodeError('Invalid BMP file: missing BM header signature.');
  }
  const pixelOffset = buf.readUInt32LE(PIXEL_OFFSET_FIELD);
  return decodeBitmap(buf, FILE_HEADER_BYTES, pixelOffset, {});
}

/** Decodes a headerless DIB (the form inside ICO and CUR files) to 8-bit RGBA. */
export function decodeDib(buf: Buffer, options: DibOptions = {}): DecodedBmp {
  return decodeBitmap(buf, 0, null, options);
}
