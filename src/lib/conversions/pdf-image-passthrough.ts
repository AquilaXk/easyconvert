import zlib from 'node:zlib';
import { CorruptStreamError } from '../types';
import { encodeCcittG4 } from './ccitt-g4';
import { inflateBounded, MAX_STREAM_INFLATE_BYTES } from './bounded-inflate';
import { assertInputPixels } from './image-input-limits';
import type { ColorSpace, IccProfile, PdfImagePlan } from './pdf-image-xobject';

/**
 * Puts the compressed pixels of a PNG into a PDF image XObject without decoding and re-encoding them.
 *
 * A PNG's IDAT data is a zlib stream of scanlines that each start with a filter byte. That is exactly what
 * `/FlateDecode` with `/Predictor 15` reads (ISO 32000-1 7.4.4.4, PNG predictors), so the IDAT chunks are
 * concatenated into one stream and the page costs a copy instead of an inflate and a deflate. A one-bit
 * grayscale page is also tried as CCITT Group 4 (ITU-T T.6) and kept when that is shorter. The pixels are
 * never changed. PNG: ISO/IEC 15948 (W3C PNG 1.2), chunk layout in clause 5, filters in clause 9.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHUNK_LENGTH_BYTES = 4;
const CHUNK_TYPE_BYTES = 4;
const CHUNK_CRC_BYTES = 4;
const CHUNK_HEADER_BYTES = CHUNK_LENGTH_BYTES + CHUNK_TYPE_BYTES;
/** Largest chunk length a PNG may declare (2^31 - 1, PNG clause 5.2). */
const MAX_CHUNK_LENGTH = 0x7fffffff;
const IHDR_LENGTH = 13;
const BITS_PER_BYTE = 8;
const PALETTE_ENTRY_BYTES = 3;
const MAX_PALETTE_ENTRIES = 256;
/** The only compression and filter methods PNG defines. */
const PNG_METHOD_DEFLATE = 0;
const PNG_FILTER_ADAPTIVE = 0;
const PNG_INTERLACE_NONE = 0;
const PNG_INTERLACE_ADAM7 = 1;
const FILTER_SUB = 1;
const FILTER_UP = 2;
const FILTER_AVERAGE = 3;
const FILTER_PAETH = 4;
const PNG_MAX_FILTER_TYPE = FILTER_PAETH;
const BYTE_MASK = 0xff;
const HIGH_BIT = 0x80;
const BIT_INDEX_MASK = 7;
const BYTE_SHIFT = 3;
/** Most bytes of an uncompressed ICC profile accepted from an iCCP chunk. */
const MAX_ICC_PROFILE_BYTES = 4 * 1024 * 1024;
/** Fixed header of an ICC profile: total size at 0 and the colour space signature at 16 (ICC.1 clause 7.2). */
const ICC_HEADER_BYTES = 128;
const ICC_SIZE_OFFSET = 0;
const ICC_COLOR_SPACE_OFFSET = 16;
const ICC_COLOR_SPACE_BYTES = 4;
const GRAY_WHITE_SAMPLE = 0xff;
/** Longest iCCP profile name (PNG clause 11.3.3.3) plus its terminator. */
const ICC_NAME_MAX_BYTES = 79 + 1;

/** PNG colour types (clause 11.2.2). */
const COLOR_GRAY = 0;
const COLOR_RGB = 2;
const COLOR_PALETTE = 3;
const COLOR_GRAY_ALPHA = 4;
const COLOR_RGBA = 6;

/** Colour type to the bit depths PNG allows with it, and to its channel count. */
const ALLOWED_DEPTHS: ReadonlyMap<number, ReadonlySet<number>> = new Map([
  [COLOR_GRAY, new Set([1, 2, 4, 8, 16])],
  [COLOR_RGB, new Set([8, 16])],
  [COLOR_PALETTE, new Set([1, 2, 4, 8])],
  [COLOR_GRAY_ALPHA, new Set([8, 16])],
  [COLOR_RGBA, new Set([8, 16])],
]);
const CHANNELS = new Map<number, number>([
  [COLOR_GRAY, 1],
  [COLOR_RGB, 3],
  [COLOR_PALETTE, 1],
  [COLOR_GRAY_ALPHA, 2],
  [COLOR_RGBA, 4],
]);

interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
}

interface PngChunks {
  header: PngHeader;
  palette?: Buffer;
  icc?: Buffer;
  hasTransparency: boolean;
  data: Buffer[];
}

function malformed(detail: string): CorruptStreamError {
  return new CorruptStreamError(`The PNG image is malformed: ${detail}`);
}

/** Splits a PNG into its chunks, checking the signature, every length and CRC, and the chunk order. */
function readChunks(png: Uint8Array): PngChunks {
  const buffer = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw malformed('the PNG signature is missing');
  }
  let header: PngHeader | undefined;
  let palette: Buffer | undefined;
  let icc: Buffer | undefined;
  let hasTransparency = false;
  const data: Buffer[] = [];
  let sawEnd = false;
  let dataEnded = false;
  let pos = PNG_SIGNATURE.length;

  while (pos < buffer.length && !sawEnd) {
    if (pos + CHUNK_HEADER_BYTES + CHUNK_CRC_BYTES > buffer.length) throw malformed('the file ends inside a chunk header');
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString('latin1', pos + CHUNK_LENGTH_BYTES, pos + CHUNK_HEADER_BYTES);
    if (length > MAX_CHUNK_LENGTH) throw malformed(`${type} chunk declares ${length} bytes, over the PNG limit`);
    const bodyAt = pos + CHUNK_HEADER_BYTES;
    const crcAt = bodyAt + length;
    if (crcAt + CHUNK_CRC_BYTES > buffer.length) throw malformed(`${type} chunk of ${length} bytes runs past the end of the file`);
    if (zlib.crc32(buffer.subarray(pos + CHUNK_LENGTH_BYTES, crcAt)) !== buffer.readUInt32BE(crcAt)) {
      throw malformed(`CRC mismatch in ${type} chunk`);
    }
    const body = buffer.subarray(bodyAt, crcAt);
    if (header === undefined && type !== 'IHDR') throw malformed('the first chunk is not IHDR');

    switch (type) {
      case 'IHDR':
        if (header !== undefined || length !== IHDR_LENGTH) throw malformed('IHDR is repeated or not 13 bytes');
        header = readHeader(body);
        break;
      case 'PLTE':
        if (palette !== undefined || data.length > 0) throw malformed('PLTE is repeated or after the image data');
        palette = body;
        break;
      case 'iCCP':
        if (icc !== undefined || data.length > 0) throw malformed('iCCP is repeated or after the image data');
        icc = body;
        break;
      case 'tRNS':
        hasTransparency = true;
        break;
      case 'IDAT':
        if (dataEnded) throw malformed('IDAT chunks are not contiguous');
        data.push(body);
        break;
      case 'IEND':
        sawEnd = true;
        break;
      default:
        break;
    }
    if (data.length > 0 && type !== 'IDAT') dataEnded = true;
    pos = crcAt + CHUNK_CRC_BYTES;
  }

  if (header === undefined) throw malformed('IHDR is missing');
  if (data.length === 0) throw malformed('the image has no IDAT data');
  if (!sawEnd) throw malformed('the file ends before IEND');
  return { header, palette, icc, hasTransparency, data };
}

function readHeader(body: Buffer): PngHeader {
  const width = body.readUInt32BE(0);
  const height = body.readUInt32BE(CHUNK_LENGTH_BYTES);
  const bitDepth = body[8];
  const colorType = body[9];
  const compression = body[10];
  const filter = body[11];
  const interlace = body[12];
  if (width < 1 || height < 1 || width > MAX_CHUNK_LENGTH || height > MAX_CHUNK_LENGTH) {
    throw malformed(`the canvas is ${width}x${height}`);
  }
  if (!ALLOWED_DEPTHS.get(colorType)?.has(bitDepth)) {
    throw malformed(`colour type ${colorType} cannot have bit depth ${bitDepth}`);
  }
  if (compression !== PNG_METHOD_DEFLATE || filter !== PNG_FILTER_ADAPTIVE) {
    throw malformed(`compression method ${compression} and filter method ${filter} are not defined`);
  }
  if (interlace !== PNG_INTERLACE_NONE && interlace !== PNG_INTERLACE_ADAM7) {
    throw malformed(`interlace method ${interlace} is not defined`);
  }
  return { width, height, bitDepth, colorType, interlace };
}

/** The ICC profile of an iCCP chunk when it describes the colours the PNG uses; null when it cannot be used. */
function readIccProfile(chunk: Buffer, header: PngHeader): IccProfile | null {
  const nameEnd = chunk.indexOf(0);
  if (nameEnd < 1 || nameEnd >= ICC_NAME_MAX_BYTES || chunk[nameEnd + 1] !== PNG_METHOD_DEFLATE) {
    throw malformed('the iCCP chunk has no profile name or compression method');
  }
  const compressed = chunk.subarray(nameEnd + 2);
  const profile = inflateBounded(compressed, { label: 'PNG iCCP profile', format: 'zlib', maxOutputLength: MAX_ICC_PROFILE_BYTES });
  if (profile.length < ICC_HEADER_BYTES || profile.readUInt32BE(ICC_SIZE_OFFSET) !== profile.length) {
    throw malformed('the iCCP profile does not match the size in its header');
  }
  const space = profile.toString('latin1', ICC_COLOR_SPACE_OFFSET, ICC_COLOR_SPACE_OFFSET + ICC_COLOR_SPACE_BYTES);
  const grayImage = header.colorType === COLOR_GRAY;
  if (grayImage && space === 'GRAY') return { compressed, components: 1 };
  if (!grayImage && space === 'RGB ') return { compressed, components: 3 };
  // A profile for other colours than the pixels use (PNG 11.3.3.3: decoders ignore it); the page keeps its device colours.
  return null;
}

/** Undoes PNG scanline filter `filter` (clause 9.2) in place for one-byte pixels. `prior` is the previous row, unfiltered. */
function unfilterRow(filter: number, row: Uint8Array, prior: Uint8Array): void {
  const length = row.length;
  if (filter === FILTER_SUB) {
    for (let i = 1; i < length; i++) row[i] = (row[i] + row[i - 1]) & BYTE_MASK;
  } else if (filter === FILTER_UP) {
    for (let i = 0; i < length; i++) row[i] = (row[i] + prior[i]) & BYTE_MASK;
  } else if (filter === FILTER_AVERAGE) {
    for (let i = 0; i < length; i++) row[i] = (row[i] + (((i > 0 ? row[i - 1] : 0) + prior[i]) >> 1)) & BYTE_MASK;
  } else if (filter === FILTER_PAETH) {
    for (let i = 0; i < length; i++) {
      const left = i > 0 ? row[i - 1] : 0;
      const up = prior[i];
      const upLeft = i > 0 ? prior[i - 1] : 0;
      const estimate = left + up - upLeft;
      const toLeft = Math.abs(estimate - left);
      const toUp = Math.abs(estimate - up);
      const toUpLeft = Math.abs(estimate - upLeft);
      let predictor = upLeft;
      if (toLeft <= toUp && toLeft <= toUpLeft) predictor = left;
      else if (toUp <= toUpLeft) predictor = up;
      row[i] = (row[i] + predictor) & BYTE_MASK;
    }
  }
}

/**
 * The page as packed one-bit rows (a clear bit is a black pixel) when every pixel is black or white, null when
 * the page has other values. Handles one-bit gray directly and eight-bit gray by packing, one byte per pixel
 * (the pixel before and above are one byte away, so the filters need no pixel-size handling).
 */
function bitonalRaster(rows: Buffer, header: PngHeader, rowBytes: number): Uint8Array | null {
  const { width, height, bitDepth } = header;
  const packedRowBytes = Math.ceil(width / BITS_PER_BYTE);
  const packed = new Uint8Array(packedRowBytes * height);
  let prior: Uint8Array = new Uint8Array(rowBytes);
  const stride = rowBytes + 1;
  for (let y = 0; y < height; y++) {
    const row = rows.subarray(y * stride + 1, (y + 1) * stride);
    unfilterRow(rows[y * stride], row, prior);
    if (bitDepth === 1) {
      packed.set(row, y * packedRowBytes);
    } else {
      for (let x = 0; x < width; x++) {
        if (row[x] === GRAY_WHITE_SAMPLE) {
          packed[y * packedRowBytes + (x >> BYTE_SHIFT)] |= HIGH_BIT >> (x & BIT_INDEX_MASK);
        } else if (row[x] !== 0) {
          return null;
        }
      }
    }
    prior = row;
  }
  return packed;
}

/**
 * Plans the PDF image for `png`, or returns null when the page has to take the decoding path: interlaced
 * images, images with alpha or a transparency chunk (they need a separate soft mask, which means decoding),
 * and rasters too large to check in one piece. A malformed PNG throws a CorruptStreamError (400) and an
 * oversized canvas an InputPixelLimitError (413).
 */
/** True when `bytes` start with the PNG signature. */
export function hasPngSignature(bytes: Uint8Array): boolean {
  return bytes.length >= PNG_SIGNATURE.length && Buffer.from(bytes.subarray(0, PNG_SIGNATURE.length)).equals(PNG_SIGNATURE);
}

export function planPngPassthrough(png: Uint8Array): PdfImagePlan | null {
  const { header, palette, icc, hasTransparency, data } = readChunks(png);
  assertInputPixels(header.width, header.height);
  if (header.interlace !== PNG_INTERLACE_NONE || hasTransparency) return null;
  if (header.colorType === COLOR_GRAY_ALPHA || header.colorType === COLOR_RGBA) return null;

  const channels = CHANNELS.get(header.colorType) ?? 1;
  const rowBytes = Math.ceil((header.width * channels * header.bitDepth) / BITS_PER_BYTE);
  const expected = (rowBytes + 1) * header.height;
  if (expected > MAX_STREAM_INFLATE_BYTES) return null;

  const stream = data.length === 1 ? data[0] : Buffer.concat(data);
  // The decoder of the PDF reads exactly the rows the header declares, so a stream of any other length is a lie.
  const rows = inflateBounded(stream, { label: 'PNG image data', format: 'zlib', expectedLength: expected });
  for (let y = 0; y < header.height; y++) {
    if (rows[y * (rowBytes + 1)] > PNG_MAX_FILTER_TYPE) throw malformed(`row ${y} has filter type ${rows[y * (rowBytes + 1)]}`);
  }

  let colorSpace: ColorSpace = { kind: header.colorType === COLOR_RGB ? 'rgb' : 'gray' };
  if (header.colorType === COLOR_PALETTE) {
    if (palette === undefined || palette.length === 0 || palette.length % PALETTE_ENTRY_BYTES !== 0) {
      throw malformed('a palette image needs a PLTE chunk of whole entries');
    }
    if (palette.length / PALETTE_ENTRY_BYTES > Math.min(MAX_PALETTE_ENTRIES, 2 ** header.bitDepth)) {
      throw malformed('the PLTE chunk has more entries than the bit depth can index');
    }
    colorSpace = { kind: 'indexed', palette };
  }
  const profile = icc === undefined ? null : readIccProfile(icc, header);

  const base = {
    width: header.width,
    height: header.height,
    bitsPerComponent: header.bitDepth,
    colorSpace,
    ...(profile === null ? {} : { icc: profile }),
  };
  if (header.colorType === COLOR_GRAY && (header.bitDepth === 1 || header.bitDepth === BITS_PER_BYTE)) {
    const raster = bitonalRaster(rows, header, rowBytes);
    const g4 = raster === null ? null : encodeCcittG4({ width: header.width, height: header.height, data: raster }, stream.length - 1);
    if (g4 !== null) {
      return { ...base, encoding: 'ccitt-g4', bitsPerComponent: 1, colors: 1, data: g4 };
    }
  }
  return { ...base, encoding: 'flate-predictor', colors: channels, data: stream };
}
