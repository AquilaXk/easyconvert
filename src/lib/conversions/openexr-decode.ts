import { inflateSync } from 'node:zlib';
import { OpenExrDecodeError } from './openexr-decode-error';
import { decodePizBlock } from './openexr-decode-piz';

export { OpenExrDecodeError } from './openexr-decode-error';
export type { OpenExrErrorKind } from './openexr-decode-error';

/**
 * OpenEXR 2.0 decoder for single-part scanline and tiled images, written from the OpenEXR file
 * layout specification ("Technical Introduction to OpenEXR"): magic and version field, typed
 * attribute header, chunk offset table, then one chunk per scanline block or tile.
 *
 * Supported compressions: NONE, RLE, ZIPS, ZIP, PXR24 and PIZ. B44, B44A, DWAA, DWAB and the
 * HTJ2K codecs, deep data, multipart files, sub-sampled channels and luminance/chroma images are
 * rejected with an OpenExrDecodeError. Malformed or truncated input never yields partial pixels.
 */

/** Upper bound on dataWindow pixels; the decoder holds 12 bytes of float RGB per pixel. */
export const MAX_OPENEXR_PIXELS = 36_000_000;
/** Upper bound on the uncompressed bytes of one scanline block or tile. */
export const MAX_OPENEXR_BLOCK_BYTES = 256 * 1024 * 1024;

const MAGIC = [0x76, 0x2f, 0x31, 0x01] as const;
const MAGIC_BYTES = MAGIC.length;
const VERSION_FIELD_BYTES = 4;
const PREAMBLE_BYTES = MAGIC_BYTES + VERSION_FIELD_BYTES;
const SUPPORTED_VERSION = 2;
const VERSION_MASK = 0xff;
const FLAG_TILED = 0x200;
const FLAG_LONG_NAMES = 0x400;
const FLAG_NON_IMAGE = 0x800;
const FLAG_MULTIPART = 0x1000;
const KNOWN_FLAGS = FLAG_TILED | FLAG_LONG_NAMES | FLAG_NON_IMAGE | FLAG_MULTIPART;
const MAX_ATTRIBUTE_NAME_BYTES = 255;

const BYTES_PER_INT32 = 4;
const BYTES_PER_OFFSET = 8;
const BOX2I_BYTES = 16;
const TILEDESC_BYTES = 9;
const CHLIST_ENTRY_FIXED_BYTES = 16;
const SCANLINE_CHUNK_HEADER_BYTES = 2 * BYTES_PER_INT32;
const TILE_CHUNK_HEADER_BYTES = 5 * BYTES_PER_INT32;

const PIXEL_TYPE_UINT = 0;
const PIXEL_TYPE_HALF = 1;
const PIXEL_TYPE_FLOAT = 2;
const BYTES_PER_HALF = 2;
const BYTES_PER_FLOAT = 4;
const PXR24_BYTES_PER_FLOAT = 3;

const COMPRESSION_NONE = 0;
const COMPRESSION_RLE = 1;
const COMPRESSION_ZIPS = 2;
const COMPRESSION_ZIP = 3;
const COMPRESSION_PIZ = 4;
const COMPRESSION_PXR24 = 5;
const COMPRESSION_B44 = 6;
const COMPRESSION_B44A = 7;
const COMPRESSION_DWAA = 8;
const COMPRESSION_DWAB = 9;
const COMPRESSION_HT256 = 10;
const COMPRESSION_HT = 11;

const UNSUPPORTED_COMPRESSION_NAMES: ReadonlyMap<number, string> = new Map([
  [COMPRESSION_B44, 'B44'],
  [COMPRESSION_B44A, 'B44A'],
  [COMPRESSION_DWAA, 'DWAA'],
  [COMPRESSION_DWAB, 'DWAB'],
  [COMPRESSION_HT256, 'HTJ2K256'],
  [COMPRESSION_HT, 'HTJ2K'],
]);

/** Scanlines per chunk for the supported scanline compressions. */
const SCANLINES_PER_CHUNK: ReadonlyMap<number, number> = new Map([
  [COMPRESSION_NONE, 1],
  [COMPRESSION_RLE, 1],
  [COMPRESSION_ZIPS, 1],
  [COMPRESSION_ZIP, 16],
  [COMPRESSION_PXR24, 16],
  [COMPRESSION_PIZ, 32],
]);

const LEVEL_MODE_ONE = 0;
const LEVEL_MODE_MIPMAP = 1;
const LEVEL_MODE_RIPMAP = 2;
const LEVEL_MODE_MASK = 0x0f;
const ROUNDING_MODE_SHIFT = 4;
const ROUNDING_MODE_UP = 1;
const TILE_MODE_VALID_BITS = 0x1f;

const RLE_REPEAT_BASE = 1;
const PREDICTOR_BIAS = 128;
const BYTE_MODULUS_MASK = 0xff;
const WORD_MASK = 0xffff;
const HALF_VALUES = 1 << 16;
const BYTE_SHIFT_8 = 8;
const BYTE_SHIFT_16 = 16;
const BYTE_SHIFT_24 = 24;

const LUMA_CHROMA_LETTERS: ReadonlySet<string> = new Set(['RY', 'BY']);
const RGB_LETTERS = ['R', 'G', 'B'] as const;
/** Channel base names that carry colour; every other channel (A, Z, ids, ...) is skipped but still laid out. */
const COLOR_LETTERS: ReadonlySet<string> = new Set(['R', 'G', 'B', 'Y', 'RY', 'BY']);

interface ExrChannel {
  name: string;
  pixelType: number;
  bytesPerSample: number;
  xSampling: number;
  ySampling: number;
}

interface TileLayout {
  xSize: number;
  ySize: number;
  levelMode: number;
  roundUp: boolean;
}

interface ColorMapping {
  /** Channel indices feeding R, G and B (the same index three times for a single luminance channel). */
  indices: [number, number, number];
}

export interface DecodedOpenExr {
  width: number;
  height: number;
  /** Interleaved linear R,G,B float samples (width * height * 3). */
  rgb: Float32Array;
  isHalf: boolean;
  attrs: Record<string, { type: string; val: Buffer }>;
}

function malformed(message: string): never {
  throw new OpenExrDecodeError(`Invalid OpenEXR: ${message}`, 'malformed');
}

function truncated(message: string): never {
  throw new OpenExrDecodeError(`Truncated OpenEXR: ${message}`, 'truncated');
}

function unsupported(message: string): never {
  throw new OpenExrDecodeError(`Unsupported OpenEXR: ${message}`, 'unsupported');
}

function tooLarge(message: string): never {
  throw new OpenExrDecodeError(`OpenEXR too large: ${message}`, 'too-large');
}

let halfToFloatTable: Float32Array | undefined;

/** IEEE 754 binary16 to binary32 for every bit pattern, built once. */
function getHalfTable(): Float32Array {
  if (halfToFloatTable) return halfToFloatTable;
  const table = new Float32Array(HALF_VALUES);
  const HALF_MANTISSA_BITS = 10;
  const HALF_EXPONENT_MASK = 0x1f;
  const HALF_EXPONENT_BIAS = 15;
  const HALF_MANTISSA_SCALE = 1 << HALF_MANTISSA_BITS;
  const SIGN_BIT = 0x8000;
  for (let bits = 0; bits < HALF_VALUES; bits++) {
    const sign = (bits & SIGN_BIT) !== 0 ? -1 : 1;
    const exponent = (bits >> HALF_MANTISSA_BITS) & HALF_EXPONENT_MASK;
    const mantissa = bits & (HALF_MANTISSA_SCALE - 1);
    if (exponent === 0) {
      table[bits] = sign * 2 ** (1 - HALF_EXPONENT_BIAS) * (mantissa / HALF_MANTISSA_SCALE);
    } else if (exponent === HALF_EXPONENT_MASK) {
      table[bits] = mantissa === 0 ? sign * Infinity : Number.NaN;
    } else {
      table[bits] = sign * 2 ** (exponent - HALF_EXPONENT_BIAS) * (1 + mantissa / HALF_MANTISSA_SCALE);
    }
  }
  halfToFloatTable = table;
  return table;
}

// --- Header ---------------------------------------------------------------------------------

interface ParsedHeader {
  attrs: Record<string, { type: string; val: Buffer }>;
  flags: number;
  /** Offset of the first byte after the header terminator (the offset table). */
  end: number;
}

function readCString(buf: Buffer, pos: number, what: string): { text: string; next: number } {
  const end = buf.indexOf(0, pos);
  if (end === -1) truncated(`${what} is not terminated`);
  if (end === pos) malformed(`${what} is empty`);
  if (end - pos > MAX_ATTRIBUTE_NAME_BYTES) malformed(`${what} is longer than ${MAX_ATTRIBUTE_NAME_BYTES} bytes`);
  return { text: buf.toString('latin1', pos, end), next: end + 1 };
}

function parseHeader(buf: Buffer): ParsedHeader {
  if (buf.length < PREAMBLE_BYTES) truncated('file is shorter than the magic and version fields');
  for (let i = 0; i < MAGIC_BYTES; i++) {
    if (buf[i] !== MAGIC[i]) throw new OpenExrDecodeError('Invalid OpenEXR magic header bytes', 'malformed');
  }
  const versionField = buf.readUInt32LE(MAGIC_BYTES);
  const version = versionField & VERSION_MASK;
  if (version !== SUPPORTED_VERSION) unsupported(`format version ${version}`);
  const flags = versionField & ~VERSION_MASK;
  if ((flags & ~KNOWN_FLAGS) !== 0) unsupported(`unknown version flags 0x${flags.toString(16)}`);
  if ((flags & FLAG_MULTIPART) !== 0) unsupported('multipart files');
  if ((flags & FLAG_NON_IMAGE) !== 0) unsupported('deep data');

  const attrs: Record<string, { type: string; val: Buffer }> = Object.create(null);
  let pos = PREAMBLE_BYTES;
  for (;;) {
    if (pos >= buf.length) truncated('header ends before its terminator');
    if (buf[pos] === 0) {
      pos++;
      break;
    }
    const name = readCString(buf, pos, 'attribute name');
    const type = readCString(buf, name.next, 'attribute type');
    if (type.next + BYTES_PER_INT32 > buf.length) truncated('attribute size is cut off');
    const size = buf.readUInt32LE(type.next);
    const valueStart = type.next + BYTES_PER_INT32;
    if (valueStart + size > buf.length) truncated(`attribute "${name.text}" value is cut off`);
    if (name.text in attrs) malformed(`duplicate attribute "${name.text}"`);
    attrs[name.text] = { type: type.text, val: buf.subarray(valueStart, valueStart + size) };
    pos = valueStart + size;
  }
  return { attrs, flags, end: pos };
}

function parseChannels(attr: { type: string; val: Buffer } | undefined): ExrChannel[] {
  if (!attr || attr.type !== 'chlist') malformed('missing channels attribute');
  const list = attr.val;
  const channels: ExrChannel[] = [];
  const seen = new Set<string>();
  let pos = 0;
  for (;;) {
    if (pos >= list.length) truncated('channel list is not terminated');
    if (list[pos] === 0) break;
    const name = readCString(list, pos, 'channel name');
    pos = name.next;
    if (pos + CHLIST_ENTRY_FIXED_BYTES > list.length) truncated('channel entry is cut off');
    const pixelType = list.readInt32LE(pos);
    const xSampling = list.readInt32LE(pos + 8);
    const ySampling = list.readInt32LE(pos + 12);
    pos += CHLIST_ENTRY_FIXED_BYTES;
    let bytesPerSample = BYTES_PER_FLOAT;
    if (pixelType === PIXEL_TYPE_HALF) {
      bytesPerSample = BYTES_PER_HALF;
    } else if (pixelType !== PIXEL_TYPE_UINT && pixelType !== PIXEL_TYPE_FLOAT) {
      malformed(`channel "${name.text}" has unknown pixel type ${pixelType}`);
    }
    if (xSampling < 1 || ySampling < 1) malformed(`channel "${name.text}" has invalid sampling`);
    if (seen.has(name.text)) malformed(`duplicate channel "${name.text}"`);
    seen.add(name.text);
    channels.push({ name: name.text, pixelType, bytesPerSample, xSampling, ySampling });
  }
  if (channels.length === 0) malformed('channel list is empty');
  return channels;
}

/** Picks the channels that make up the RGB output: a root or named layer with R,G,B, or a lone Y. */
function selectColorChannels(channels: readonly ExrChannel[]): ColorMapping {
  const layers = new Map<string, Map<string, number>>();
  channels.forEach((channel, index) => {
    const dot = channel.name.lastIndexOf('.');
    const layer = dot < 0 ? '' : channel.name.slice(0, dot);
    const letter = channel.name.slice(dot + 1).toUpperCase();
    if (!COLOR_LETTERS.has(letter)) return;
    let letters = layers.get(layer);
    if (!letters) {
      letters = new Map();
      layers.set(layer, letters);
    }
    if (letters.has(letter)) malformed(`channels "${channel.name}" and a case variant both name ${letter}`);
    letters.set(letter, index);
  });

  const order = [...layers.keys()].sort((a, b) => Number(a !== '') - Number(b !== ''));
  for (const layer of order) {
    const letters = layers.get(layer) as Map<string, number>;
    const present = RGB_LETTERS.filter((letter) => letters.has(letter));
    if (present.length === RGB_LETTERS.length) {
      return { indices: [letters.get('R') as number, letters.get('G') as number, letters.get('B') as number] };
    }
    if (present.length > 0) {
      malformed(`layer "${layer}" has ${present.join(',')} but not all of R, G and B`);
    }
    if (letters.has('Y')) {
      for (const letter of LUMA_CHROMA_LETTERS) {
        if (letters.has(letter)) unsupported('luminance/chroma (Y, RY, BY) images');
      }
      const y = letters.get('Y') as number;
      return { indices: [y, y, y] };
    }
  }
  return malformed('no R,G,B or Y colour channels');
}

function parseBox2i(attr: { type: string; val: Buffer } | undefined): { xMin: number; yMin: number; xMax: number; yMax: number } {
  if (!attr || attr.type !== 'box2i' || attr.val.length !== BOX2I_BYTES) malformed('missing or corrupt dataWindow attribute');
  const box = { xMin: attr.val.readInt32LE(0), yMin: attr.val.readInt32LE(4), xMax: attr.val.readInt32LE(8), yMax: attr.val.readInt32LE(12) };
  if (box.xMax < box.xMin || box.yMax < box.yMin) malformed('dataWindow is empty or inverted');
  return box;
}

function parseCompression(attr: { type: string; val: Buffer } | undefined): number {
  if (!attr || attr.type !== 'compression' || attr.val.length !== 1) malformed('missing or corrupt compression attribute');
  const code = attr.val[0];
  const name = UNSUPPORTED_COMPRESSION_NAMES.get(code);
  if (name) unsupported(`${name} compression`);
  if (!SCANLINES_PER_CHUNK.has(code)) malformed(`unknown compression code ${code}`);
  return code;
}

function parseTiles(attr: { type: string; val: Buffer } | undefined): TileLayout {
  if (!attr || attr.type !== 'tiledesc' || attr.val.length !== TILEDESC_BYTES) malformed('tiled image without a valid tiles attribute');
  const xSize = attr.val.readUInt32LE(0);
  const ySize = attr.val.readUInt32LE(BYTES_PER_INT32);
  const mode = attr.val[2 * BYTES_PER_INT32];
  const levelMode = mode & LEVEL_MODE_MASK;
  if (xSize < 1 || ySize < 1) malformed('tile size must be positive');
  if ((mode & ~TILE_MODE_VALID_BITS) !== 0 || levelMode > LEVEL_MODE_RIPMAP) malformed(`invalid tile level mode 0x${mode.toString(16)}`);
  return { xSize, ySize, levelMode, roundUp: ((mode >> ROUNDING_MODE_SHIFT) & 1) === ROUNDING_MODE_UP };
}

// --- Multi-resolution tile table geometry ---------------------------------------------------

function floorLog2(value: number): number {
  return Math.floor(Math.log2(value));
}

function ceilLog2(value: number): number {
  return Math.ceil(Math.log2(value));
}

function levelCount(size: number, roundUp: boolean): number {
  return (roundUp ? ceilLog2(size) : floorLog2(size)) + 1;
}

function levelSize(size: number, level: number, roundUp: boolean): number {
  const divisor = 2 ** level;
  let result = Math.floor(size / divisor);
  if (roundUp && result * divisor < size) result += 1;
  return Math.max(result, 1);
}

/** Number of tile chunks across every level, i.e. the length of the offset table. */
function totalTileCount(width: number, height: number, tiles: TileLayout): number {
  const tileCount = (w: number, h: number) => Math.ceil(w / tiles.xSize) * Math.ceil(h / tiles.ySize);
  if (tiles.levelMode === LEVEL_MODE_ONE) return tileCount(width, height);
  if (tiles.levelMode === LEVEL_MODE_MIPMAP) {
    const levels = levelCount(Math.max(width, height), tiles.roundUp);
    let total = 0;
    for (let level = 0; level < levels; level++) {
      total += tileCount(levelSize(width, level, tiles.roundUp), levelSize(height, level, tiles.roundUp));
    }
    return total;
  }
  const xLevels = levelCount(width, tiles.roundUp);
  const yLevels = levelCount(height, tiles.roundUp);
  let total = 0;
  for (let ly = 0; ly < yLevels; ly++) {
    for (let lx = 0; lx < xLevels; lx++) {
      total += tileCount(levelSize(width, lx, tiles.roundUp), levelSize(height, ly, tiles.roundUp));
    }
  }
  return total;
}

// --- Block codecs ---------------------------------------------------------------------------

function inflateBlock(data: Buffer, expectedBytes: number, codec: string): Buffer {
  let out: Buffer;
  try {
    out = inflateSync(data, { maxOutputLength: Math.max(expectedBytes, 1) });
  } catch {
    return malformed(`${codec} block is not a valid zlib stream of ${expectedBytes} bytes`);
  }
  if (out.length !== expectedBytes) malformed(`${codec} block inflates to ${out.length} bytes, expected ${expectedBytes}`);
  return out;
}

/** Undoes the ZIP/RLE byte predictor and the even/odd byte split. */
function reconstructPredicted(packed: Buffer): Buffer {
  const length = packed.length;
  for (let i = 1; i < length; i++) {
    packed[i] = (packed[i - 1] + packed[i] - PREDICTOR_BIAS) & BYTE_MODULUS_MASK;
  }
  const out = Buffer.allocUnsafe(length);
  const secondHalf = Math.ceil(length / 2);
  for (let i = 0, first = 0, second = secondHalf; i < length; i += 2) {
    out[i] = packed[first++];
    if (i + 1 < length) out[i + 1] = packed[second++];
  }
  return out;
}

function rleDecode(data: Buffer, expectedBytes: number): Buffer {
  const out = Buffer.allocUnsafe(expectedBytes);
  let read = 0;
  let write = 0;
  while (read < data.length) {
    const control = (data[read++] << BYTE_SHIFT_24) >> BYTE_SHIFT_24;
    if (control < 0) {
      const count = -control;
      if (read + count > data.length) truncated('RLE literal run is cut off');
      if (write + count > expectedBytes) malformed('RLE block decodes to more data than expected');
      data.copy(out, write, read, read + count);
      read += count;
      write += count;
    } else {
      const count = control + RLE_REPEAT_BASE;
      if (read >= data.length) truncated('RLE repeat run is cut off');
      if (write + count > expectedBytes) malformed('RLE block decodes to more data than expected');
      out.fill(data[read++], write, write + count);
      write += count;
    }
  }
  if (write !== expectedBytes) malformed(`RLE block decodes to ${write} bytes, expected ${expectedBytes}`);
  return out;
}

/** PXR24: deflated byte planes of per-row 24-bit-truncated floats, 16-bit halves and 32-bit ints, delta coded. */
function pxr24Decode(data: Buffer, channels: readonly ExrChannel[], width: number, rows: number, expectedBytes: number): Buffer {
  let packedBytes = 0;
  for (const channel of channels) {
    const stored = channel.pixelType === PIXEL_TYPE_FLOAT ? PXR24_BYTES_PER_FLOAT : channel.bytesPerSample;
    packedBytes += stored * width * rows;
  }
  const packed = inflateBlock(data, packedBytes, 'PXR24');
  const out = Buffer.allocUnsafe(expectedBytes);
  let read = 0;
  let write = 0;
  for (let y = 0; y < rows; y++) {
    for (const channel of channels) {
      let pixel = 0;
      if (channel.pixelType === PIXEL_TYPE_HALF) {
        const second = read + width;
        for (let x = 0; x < width; x++) {
          pixel = (pixel + ((packed[read + x] << BYTE_SHIFT_8) | packed[second + x])) & WORD_MASK;
          out.writeUInt16LE(pixel, write);
          write += BYTES_PER_HALF;
        }
        read = second + width;
      } else if (channel.pixelType === PIXEL_TYPE_FLOAT) {
        const second = read + width;
        const third = second + width;
        for (let x = 0; x < width; x++) {
          const diff = ((packed[read + x] << BYTE_SHIFT_24) | (packed[second + x] << BYTE_SHIFT_16) | (packed[third + x] << BYTE_SHIFT_8)) >>> 0;
          pixel = (pixel + diff) >>> 0;
          out.writeUInt32LE(pixel, write);
          write += BYTES_PER_FLOAT;
        }
        read = third + width;
      } else {
        const second = read + width;
        const third = second + width;
        const fourth = third + width;
        for (let x = 0; x < width; x++) {
          const diff =
            ((packed[read + x] << BYTE_SHIFT_24) | (packed[second + x] << BYTE_SHIFT_16) | (packed[third + x] << BYTE_SHIFT_8) | packed[fourth + x]) >>> 0;
          pixel = (pixel + diff) >>> 0;
          out.writeUInt32LE(pixel, write);
          write += BYTES_PER_FLOAT;
        }
        read = fourth + width;
      }
    }
  }
  return out;
}

/**
 * Returns the uncompressed block (rows of channel-major samples). A chunk whose stored size equals
 * the uncompressed size is raw regardless of the compression attribute, as the specification states.
 */
function decodeBlock(compression: number, chunk: Buffer, channels: readonly ExrChannel[], width: number, rows: number, expectedBytes: number): Buffer {
  if (chunk.length === expectedBytes) return chunk;
  if (chunk.length > expectedBytes) malformed(`chunk of ${chunk.length} bytes exceeds its ${expectedBytes} uncompressed bytes`);
  switch (compression) {
    case COMPRESSION_NONE:
      return truncated(`uncompressed chunk holds ${chunk.length} of ${expectedBytes} bytes`);
    case COMPRESSION_RLE:
      return reconstructPredicted(rleDecode(chunk, expectedBytes));
    case COMPRESSION_ZIPS:
    case COMPRESSION_ZIP:
      return reconstructPredicted(inflateBlock(chunk, expectedBytes, 'ZIP'));
    case COMPRESSION_PXR24:
      return pxr24Decode(chunk, channels, width, rows, expectedBytes);
    case COMPRESSION_PIZ: {
      const out = decodePizBlock(
        chunk,
        width,
        rows,
        channels.map((channel) => channel.bytesPerSample / BYTES_PER_HALF)
      );
      if (out.length !== expectedBytes) malformed(`PIZ block decodes to ${out.length} bytes, expected ${expectedBytes}`);
      return out;
    }
    default:
      return unsupported(`compression code ${compression}`);
  }
}

// --- Chunk table and pixel scatter ----------------------------------------------------------

interface ChunkRead {
  /** Integer header fields following the chunk offset (y, or tileX/tileY/levelX/levelY). */
  fields: number[];
  data: Buffer;
}

function readChunk(buf: Buffer, offset: number, tableEnd: number, fieldCount: number): ChunkRead {
  const headerBytes = (fieldCount + 1) * BYTES_PER_INT32;
  if (!Number.isSafeInteger(offset) || offset < tableEnd) malformed(`chunk offset ${offset} lies inside the header or offset table`);
  if (offset + headerBytes > buf.length) truncated(`chunk offset ${offset} lies beyond the end of the file`);
  const fields: number[] = [];
  for (let i = 0; i < fieldCount; i++) fields.push(buf.readInt32LE(offset + i * BYTES_PER_INT32));
  const dataSize = buf.readInt32LE(offset + fieldCount * BYTES_PER_INT32);
  if (dataSize < 0) malformed('chunk has a negative data size');
  const dataStart = offset + headerBytes;
  if (dataStart + dataSize > buf.length) truncated(`chunk at ${offset} declares ${dataSize} bytes but the file ends first`);
  return { fields, data: buf.subarray(dataStart, dataStart + dataSize) };
}

function readOffset(buf: Buffer, tableStart: number, index: number): number {
  const value = buf.readBigUInt64LE(tableStart + index * BYTES_PER_OFFSET);
  if (value === BigInt(0)) malformed(`chunk ${index} has no offset (incomplete file)`);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) malformed(`chunk ${index} offset is out of range`);
  return Number(value);
}

interface Scatter {
  rgb: Float32Array;
  imageWidth: number;
  channels: readonly ExrChannel[];
  mapping: ColorMapping;
  channelByteOffsets: number[];
  bytesPerPixel: number;
}

/** Copies the selected colour channels of one uncompressed block into the interleaved RGB output. */
function scatterBlock(block: Buffer, scatter: Scatter, x0: number, y0: number, blockWidth: number, rows: number): void {
  const halves = getHalfTable();
  const lineBytes = blockWidth * scatter.bytesPerPixel;
  for (let line = 0; line < rows; line++) {
    const lineStart = line * lineBytes;
    const outRow = ((y0 + line) * scatter.imageWidth + x0) * 3;
    for (let component = 0; component < 3; component++) {
      const channel = scatter.channels[scatter.mapping.indices[component]];
      let at = lineStart + scatter.channelByteOffsets[scatter.mapping.indices[component]] * blockWidth;
      let out = outRow + component;
      for (let x = 0; x < blockWidth; x++) {
        if (channel.pixelType === PIXEL_TYPE_HALF) {
          scatter.rgb[out] = halves[block.readUInt16LE(at)];
        } else if (channel.pixelType === PIXEL_TYPE_FLOAT) {
          scatter.rgb[out] = block.readFloatLE(at);
        } else {
          scatter.rgb[out] = block.readUInt32LE(at);
        }
        at += channel.bytesPerSample;
        out += 3;
      }
    }
  }
}

/**
 * Decodes an OpenEXR buffer to linear float RGB. Throws OpenExrDecodeError (a ConversionFailedError)
 * for malformed, truncated, oversized or unsupported input; it never returns partial pixels.
 */
export function decodeOpenExr(buf: Buffer): DecodedOpenExr {
  const header = parseHeader(buf);
  const { attrs, flags } = header;

  const imageType = attrs.type;
  if (imageType) {
    const typeName = imageType.val.toString('latin1').replace(/\0+$/, '');
    if (typeName === 'deepscanline' || typeName === 'deeptile') unsupported('deep data');
  }

  const channels = parseChannels(attrs.channels);
  const compression = parseCompression(attrs.compression);
  const window = parseBox2i(attrs.dataWindow);
  const mapping = selectColorChannels(channels);
  for (const channel of channels) {
    if (channel.xSampling !== 1 || channel.ySampling !== 1) {
      unsupported(`channel "${channel.name}" is sub-sampled (${channel.xSampling}x${channel.ySampling})`);
    }
  }

  const width = window.xMax - window.xMin + 1;
  const height = window.yMax - window.yMin + 1;
  if (width * height > MAX_OPENEXR_PIXELS) {
    tooLarge(`${width}x${height} pixels exceeds the ${MAX_OPENEXR_PIXELS} pixel limit`);
  }

  const isTiled = (flags & FLAG_TILED) !== 0;
  const tiles = isTiled ? parseTiles(attrs.tiles) : undefined;

  const channelByteOffsets: number[] = [];
  let bytesPerPixel = 0;
  for (const channel of channels) {
    channelByteOffsets.push(bytesPerPixel);
    bytesPerPixel += channel.bytesPerSample;
  }

  const scatter: Scatter = {
    rgb: new Float32Array(width * height * 3),
    imageWidth: width,
    channels,
    mapping,
    channelByteOffsets,
    bytesPerPixel,
  };

  if (tiles) {
    decodeTiled(buf, header.end, tiles, compression, scatter, width, height);
  } else {
    decodeScanlines(buf, header.end, compression, scatter, window.yMin, width, height);
  }

  const isHalf = mapping.indices.some((index) => channels[index].pixelType === PIXEL_TYPE_HALF);
  return { width, height, rgb: scatter.rgb, isHalf, attrs };
}

function checkBlockSize(blockWidth: number, rows: number, bytesPerPixel: number): number {
  const bytes = blockWidth * rows * bytesPerPixel;
  if (bytes > MAX_OPENEXR_BLOCK_BYTES) tooLarge(`a ${blockWidth}x${rows} block needs ${bytes} bytes`);
  return bytes;
}

function decodeScanlines(buf: Buffer, tableStart: number, compression: number, scatter: Scatter, yMin: number, width: number, height: number): void {
  const perChunk = SCANLINES_PER_CHUNK.get(compression) as number;
  const chunkCount = Math.ceil(height / perChunk);
  checkBlockSize(width, Math.min(perChunk, height), scatter.bytesPerPixel);
  const tableEnd = tableStart + chunkCount * BYTES_PER_OFFSET;
  if (tableEnd > buf.length) truncated(`offset table needs ${chunkCount} entries`);

  for (let index = 0; index < chunkCount; index++) {
    const firstLine = index * perChunk;
    const rows = Math.min(perChunk, height - firstLine);
    const chunk = readChunk(buf, readOffset(buf, tableStart, index), tableEnd, 1);
    if (chunk.fields[0] !== yMin + firstLine) {
      malformed(`chunk ${index} starts at line ${chunk.fields[0]}, expected ${yMin + firstLine}`);
    }
    const expectedBytes = width * rows * scatter.bytesPerPixel;
    const block = decodeBlock(compression, chunk.data, scatter.channels, width, rows, expectedBytes);
    scatterBlock(block, scatter, 0, firstLine, width, rows);
  }
}

function decodeTiled(buf: Buffer, tableStart: number, tiles: TileLayout, compression: number, scatter: Scatter, width: number, height: number): void {
  const chunkCount = totalTileCount(width, height, tiles);
  checkBlockSize(Math.min(tiles.xSize, width), Math.min(tiles.ySize, height), scatter.bytesPerPixel);
  const tableEnd = tableStart + chunkCount * BYTES_PER_OFFSET;
  if (tableEnd > buf.length) truncated(`offset table needs ${chunkCount} entries`);

  // Level 0 is the full-resolution image and is stored first in every level mode.
  const tilesX = Math.ceil(width / tiles.xSize);
  const tilesY = Math.ceil(height / tiles.ySize);
  for (let tileY = 0; tileY < tilesY; tileY++) {
    for (let tileX = 0; tileX < tilesX; tileX++) {
      const index = tileY * tilesX + tileX;
      const chunk = readChunk(buf, readOffset(buf, tableStart, index), tableEnd, 4);
      const [chunkTileX, chunkTileY, levelX, levelY] = chunk.fields;
      if (chunkTileX !== tileX || chunkTileY !== tileY || levelX !== 0 || levelY !== 0) {
        malformed(`tile chunk ${index} is (${chunkTileX},${chunkTileY}) level (${levelX},${levelY}), expected (${tileX},${tileY}) level (0,0)`);
      }
      const x0 = tileX * tiles.xSize;
      const y0 = tileY * tiles.ySize;
      const blockWidth = Math.min(tiles.xSize, width - x0);
      const rows = Math.min(tiles.ySize, height - y0);
      const expectedBytes = blockWidth * rows * scatter.bytesPerPixel;
      const block = decodeBlock(compression, chunk.data, scatter.channels, blockWidth, rows, expectedBytes);
      scatterBlock(block, scatter, x0, y0, blockWidth, rows);
    }
  }
}
