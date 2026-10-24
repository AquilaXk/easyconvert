import { segmentHeaderAt } from './pdf-jbig2-guard';

/**
 * What the WebAssembly picture decoders of pdf.js would allocate for a picture, read from its headers before any decoder runs.
 *
 * pdf.js 6.3.289 decodes JPEG 2000 with OpenJPEG (pdf.js.openjpeg, OpenJPEG 8314119b) and JBIG2 and CCITT fax with PDFium's
 * codecs (pdf.js.jbig2, PDFium bb1f9f71). The estimates below follow what those sources allocate; each constant names its
 * source. They are upper estimates of the large allocations, not of every byte: the memory maximum of the modules
 * (pdf-wasm-memory.ts) is the bound, and these let a picture that would reach it be left out before it is decoded.
 */

const BYTES_PER_SAMPLE = 4;

// ---------------------------------------------------------------------------------------------
// JPEG 2000
// ---------------------------------------------------------------------------------------------

const MARKER_SIZ = 0xff51;
const SIZ_PAIR = Buffer.from([0xff, 0x51]);
const SIZ_DIMENSIONS_OFFSET = 4;
const SIZ_COMPONENTS_OFFSET = 36;
const SIZ_FIXED_BYTES = 38;
const SIZ_COMPONENT_BYTES = 3;
const MARKER_SOC = 0xff4f;
const MARKER_COD = 0xff52;
const MARKER_COC = 0xff53;
const MARKER_SOT = 0xff90;
const MARKER_EOC = 0xffd9;
const MARKER_PREFIX = 0xff;
const MARKER_LENGTH_BYTES = 2;
/** Csiz above this needs two bytes for a component index in COC (ISO 15444-1 A.6.2). */
const ONE_BYTE_COMPONENT_LIMIT = 257;
const CODE_BLOCK_EXPONENT_OFFSET = 2;
const DEFAULT_PRECINCT_EXPONENT = 15;
const PRECINCT_EXPONENT_MASK = 0x0f;
const PRECINCT_EXPONENT_SHIFT = 4;
const STYLE_HAS_PRECINCTS = 0x01;
/** SPcod and SPcoc before the precinct sizes: levels, code-block width and height, code-block style, transform. */
const CODING_STYLE_BYTES = 5;
/** Scod and SGcod (progression order, layers, multiple component transform) before SPcod. */
const COD_STYLE_OFFSET = 5;

const JP2_SIGNATURE = Buffer.from('0000000c6a5020200d0a870a', 'hex');
const BOX_HEADER_BYTES = 8;
const BOX_EXTENDED_LENGTH = 1;
const BOX_TO_END = 0;
const BOX_EXTENDED_HEADER_BYTES = 16;
const CODESTREAM_BOX = 'jp2c';
/** Components OpenJPEG accepts in SIZ (`opj_j2k_read_SIZ`, j2k.c 2141 of OpenJPEG 8314119b: Csiz below 16385). */
const OPENJPEG_MAX_COMPONENTS = 16_384;
/** XRsiz and YRsiz are one byte each (ISO 15444-1 A.5.1). */
const MAX_SUBSAMPLING = 255;
/** Resolution levels OpenJPEG accepts in COD and COC (`opj_j2k_read_SPCod_SPCoc`, j2k.c 10972: numresolutions, one more than the levels, at most OPJ_J2K_MAXRLVLS = 33 of j2k.h 154). */
const OPENJPEG_MAX_LEVELS = 32;

/**
 * pdf.js reduces a JPEG 2000 picture before decoding it (`ImageResizer.getReducePowerForJPX`, pdf.worker.mjs 9217-9219 with
 * `getReducePower` 9199-9216). Its limits come from `MIN_IMAGE_DIM` (9161) and from probing an OffscreenCanvas; Node has none,
 * so `_areGoodDims` is false, `MAX_DIM` stays at 2048 and `MAX_AREA` at 2048 squared.
 */
const PDFJS_MAX_DIM = 2048;
const PDFJS_MAX_AREA = PDFJS_MAX_DIM * PDFJS_MAX_DIM;
/** `getReducePowerForJPX` passes `2 ** 30 / (componentsCount * 4)` as the largest area: a GiB of 32-bit samples. */
const PDFJS_JPX_SAMPLE_BYTES = 2 ** 30;

/**
 * Bytes OpenJPEG keeps per code-block and per precinct while it decodes a tile (tcd.c 1160-1171 and 1092-1110): an
 * `opj_tcd_cblk_dec_t` is 64 bytes on wasm32 (tcd.h 120-145), and each precinct holds two tag trees (inclusion and
 * zero-bitplane, tgt.c) with about 4/3 of a 16-byte node per code-block; a precinct is 40 bytes and each tree 20 (tcd.h 148-160,
 * tgt.h 57-73).
 */
const CODE_BLOCK_BYTES = 64 + Math.ceil((2 * 16 * 4) / 3);
const PRECINCT_BYTES = 40 + 2 * 20;
/**
 * OpenJPEG allocates the coding parameters of every tile when it reads SIZ (j2k.c 2413 and 2475-2483): an `opj_tcp_t` of
 * about 5.6 KiB (its `rates` and `distoratio` tables of 100 floats and 32 progression changes of 148 bytes, j2k.h 248-317)
 * and an `opj_tccp_t` of 1,080 bytes for each component (97 step sizes and 33 precinct sizes, j2k.h 182-207).
 */
const TILE_PARAMETER_BYTES = 5_648;
const TILE_COMPONENT_PARAMETER_BYTES = 1_080;

/** The size pdf.js reads from a JPEG 2000 stream, and the number of components. */
export interface JpxProperties {
  width: number;
  height: number;
  components: number;
}

/**
 * The size and components pdf.js takes from the first `FF 51` pair anywhere in the stream (`JpxImage.parseImageProperties`,
 * pdf.worker.mjs 16648-16670), which need not be the size marker of the codestream; null when there is no such pair or the
 * stream ends inside it, and pdf.js then has no size to reduce by.
 */
export function pdfjsJpxProperties(data: Buffer): JpxProperties | null {
  const at = data.indexOf(SIZ_PAIR);
  if (at < 0 || at + MARKER_LENGTH_BYTES + SIZ_FIXED_BYTES > data.length) return null;
  const fields = at + MARKER_LENGTH_BYTES + SIZ_DIMENSIONS_OFFSET;
  return {
    width: data.readUInt32BE(fields) - data.readUInt32BE(fields + 8),
    height: data.readUInt32BE(fields + 4) - data.readUInt32BE(fields + 12),
    components: data.readUInt16BE(at + MARKER_LENGTH_BYTES + SIZ_COMPONENTS_OFFSET),
  };
}

/** The resolution levels pdf.js asks OpenJPEG to drop for a picture of these properties, as `getReducePowerForJPX` gives them in Node. */
export function pdfjsJpxReducePower({ width, height, components }: JpxProperties): number {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) return 0;
  const maxArea = PDFJS_JPX_SAMPLE_BYTES / (components * BYTES_PER_SAMPLE);
  const area = width * height;
  if (width <= PDFJS_MAX_DIM && height <= PDFJS_MAX_DIM) return area > maxArea ? Math.ceil(Math.log2(area / maxArea)) : 0;
  const factor = Math.max(width / PDFJS_MAX_DIM, height / PDFJS_MAX_DIM, Math.sqrt(area / Math.min(maxArea, PDFJS_MAX_AREA)));
  return Math.max(0, Math.ceil(Math.log2(factor)));
}

interface CodingStyle {
  levels: number;
  codeBlockWidth: number;
  codeBlockHeight: number;
  /** Precinct exponents per resolution, low nibble width and high nibble height, or null for the default of 2^15. */
  precincts: number[] | null;
}

/** The main header of the codestream OpenJPEG decodes: the image and tile grid of SIZ and the coding style of each component. */
export interface JpxCodestream {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  tileWidth: number;
  tileHeight: number;
  tiles: number;
  components: Array<{ dx: number; dy: number; style: CodingStyle }>;
}

/** Offset of the codestream: the content of the `jp2c` box of a JP2 file (jp2.c reads the boxes in order), or 0 for a bare codestream. */
function codestreamStart(data: Buffer): number | null {
  if (data.length >= 2 && data.readUInt16BE(0) === MARKER_SOC) return 0;
  if (!data.subarray(0, JP2_SIGNATURE.length).equals(JP2_SIGNATURE)) return null;
  let at = 0;
  while (at + BOX_HEADER_BYTES <= data.length) {
    const declared = data.readUInt32BE(at);
    const type = data.toString('latin1', at + 4, at + BOX_HEADER_BYTES);
    let header = BOX_HEADER_BYTES;
    let length = declared;
    if (declared === BOX_EXTENDED_LENGTH) {
      if (at + BOX_EXTENDED_HEADER_BYTES > data.length) return null;
      header = BOX_EXTENDED_HEADER_BYTES;
      length = Number(data.readBigUInt64BE(at + BOX_HEADER_BYTES));
    } else if (declared === BOX_TO_END) {
      length = data.length - at;
    }
    if (type === CODESTREAM_BOX) return at + header;
    if (length < header) return null;
    at += length;
  }
  return null;
}

function codingStyle(data: Buffer, at: number, end: number, hasPrecincts: boolean): CodingStyle | null {
  if (at + CODING_STYLE_BYTES > end) return null;
  const levels = data[at];
  const precincts = hasPrecincts ? [...data.subarray(at + CODING_STYLE_BYTES, Math.min(end, at + CODING_STYLE_BYTES + levels + 1))] : null;
  return { levels, codeBlockWidth: data[at + 1] + CODE_BLOCK_EXPONENT_OFFSET, codeBlockHeight: data[at + 2] + CODE_BLOCK_EXPONENT_OFFSET, precincts };
}

/**
 * The codestream OpenJPEG would decode from `data` (ISO 15444-1 A.5.1 SIZ, A.6.1 COD, A.6.2 COC), or null when it has none or its
 * main header is one OpenJPEG refuses: more components or levels than it accepts, or a marker that runs past the data.
 */
export function jpxCodestream(data: Buffer): JpxCodestream | null {
  const start = codestreamStart(data);
  if (start === null || start + 4 > data.length || data.readUInt16BE(start) !== MARKER_SOC || data.readUInt16BE(start + 2) !== MARKER_SIZ) return null;
  const siz = start + 4;
  if (siz + SIZ_FIXED_BYTES > data.length) return null;
  const field = (index: number): number => data.readUInt32BE(siz + SIZ_DIMENSIONS_OFFSET + index * 4);
  const count = data.readUInt16BE(siz + SIZ_COMPONENTS_OFFSET);
  if (count === 0 || count > OPENJPEG_MAX_COMPONENTS || siz + SIZ_FIXED_BYTES + count * SIZ_COMPONENT_BYTES > data.length) return null;
  const [x1, y1, x0, y0, tileWidth, tileHeight, tileX0, tileY0] = [0, 1, 2, 3, 4, 5, 6, 7].map(field);
  if (tileWidth === 0 || tileHeight === 0 || x1 <= x0 || y1 <= y0) return null;
  const defaults: CodingStyle[] = [];
  const own = new Map<number, CodingStyle>();
  let at = siz + data.readUInt16BE(siz);
  while (at + 4 <= data.length) {
    const marker = data.readUInt16BE(at);
    if (marker === MARKER_SOT || marker === MARKER_EOC || data[at] !== MARKER_PREFIX) break;
    const end = at + MARKER_LENGTH_BYTES + data.readUInt16BE(at + MARKER_LENGTH_BYTES);
    const body = at + 4;
    if (end > data.length) return null;
    if (marker === MARKER_COD) {
      const style = codingStyle(data, body + COD_STYLE_OFFSET, end, (data[body] & STYLE_HAS_PRECINCTS) !== 0);
      if (style) defaults[0] = style;
    } else if (marker === MARKER_COC) {
      const componentBytes = count >= ONE_BYTE_COMPONENT_LIMIT ? 2 : 1;
      if (body + componentBytes + 1 > end) return null;
      const component = componentBytes === 2 ? data.readUInt16BE(body) : data[body];
      const style = codingStyle(data, body + componentBytes + 1, end, (data[body + componentBytes] & STYLE_HAS_PRECINCTS) !== 0);
      if (style) own.set(component, style);
    }
    at = end;
  }
  if ([...defaults, ...own.values()].some(({ levels }) => levels > OPENJPEG_MAX_LEVELS)) return null;
  const fallback: CodingStyle = defaults[0] ?? { levels: 5, codeBlockWidth: 6, codeBlockHeight: 6, precincts: null };
  const components = Array.from({ length: count }, (_, index) => {
    const parameters = siz + SIZ_FIXED_BYTES + index * SIZ_COMPONENT_BYTES;
    return { dx: Math.max(1, data[parameters + 1]), dy: Math.max(1, data[parameters + 2]), style: own.get(index) ?? fallback };
  });
  const tiles = Math.ceil((x1 - tileX0) / tileWidth) * Math.ceil((y1 - tileY0) / tileHeight);
  return { x0, y0, x1, y1, tileWidth, tileHeight, tiles, components };
}

function ceilShift(value: number, levels: number): number {
  return Math.ceil(value / 2 ** levels);
}

/** Code-block and precinct structures of one component of a tile of `width` x `height` samples, at every resolution (tcd.c 870-1230). */
function tileStructureBytes(width: number, height: number, style: CodingStyle): number {
  let bytes = 0;
  for (let resolution = 0; resolution <= style.levels; resolution++) {
    const scale = style.levels - resolution;
    const resolutionWidth = ceilShift(width, scale);
    const resolutionHeight = ceilShift(height, scale);
    const packed = style.precincts?.[resolution];
    const precinctWidth = packed === undefined ? DEFAULT_PRECINCT_EXPONENT : packed & PRECINCT_EXPONENT_MASK;
    const precinctHeight = packed === undefined ? DEFAULT_PRECINCT_EXPONENT : packed >> PRECINCT_EXPONENT_SHIFT;
    const inBand = resolution === 0 ? 0 : 1;
    const bands = resolution === 0 ? 1 : 3;
    const blockWidth = Math.max(0, Math.min(style.codeBlockWidth, precinctWidth - inBand));
    const blockHeight = Math.max(0, Math.min(style.codeBlockHeight, precinctHeight - inBand));
    const bandWidth = ceilShift(resolutionWidth, inBand);
    const bandHeight = ceilShift(resolutionHeight, inBand);
    bytes += bands * ceilShift(bandWidth, blockWidth) * ceilShift(bandHeight, blockHeight) * CODE_BLOCK_BYTES;
    bytes += bands * ceilShift(resolutionWidth, precinctWidth) * ceilShift(resolutionHeight, precinctHeight) * PRECINCT_BYTES;
  }
  return bytes;
}

/**
 * Bytes OpenJPEG allocates to decode `codestream` with `reducePower` levels dropped (pdf.js.openjpeg decoder.c 147-345): the
 * 32-bit samples of every component at the reduced size, a tile buffer as large when the image has several tiles (one tile is
 * decoded into the image), a copy of every component at full size when one is subsampled (`upsample_component`, 92-145), the
 * structures of the largest tile, and the coding parameters of every tile.
 */
export function jpxDecoderBytes(codestream: JpxCodestream, reducePower: number): number {
  const { x0, y0, x1, y1, tileWidth, tileHeight, tiles, components } = codestream;
  const width = x1 - x0;
  const height = y1 - y0;
  const tileSampleWidth = Math.min(tileWidth, width);
  const tileSampleHeight = Math.min(tileHeight, height);
  let samples = 0;
  let structures = 0;
  // Components share a coding style and a subsampling far more often than not, and up to 16,384 of them are allowed.
  const structureBytes = new Map<CodingStyle, Map<number, number>>();
  for (const { dx, dy, style } of components) {
    const componentWidth = Math.ceil(x1 / dx) - Math.ceil(x0 / dx);
    const componentHeight = Math.ceil(y1 / dy) - Math.ceil(y0 / dy);
    samples += ceilShift(componentWidth, reducePower) * ceilShift(componentHeight, reducePower) * BYTES_PER_SAMPLE;
    const bySubsampling = structureBytes.get(style) ?? new Map<number, number>();
    structureBytes.set(style, bySubsampling);
    const subsampling = dx * (MAX_SUBSAMPLING + 1) + dy;
    const bytes = bySubsampling.get(subsampling) ?? tileStructureBytes(Math.ceil(tileSampleWidth / dx), Math.ceil(tileSampleHeight / dy), style);
    bySubsampling.set(subsampling, bytes);
    structures += bytes;
  }
  const reducedFull = ceilShift(width, reducePower) * ceilShift(height, reducePower) * BYTES_PER_SAMPLE * components.length;
  const tileBuffer = tiles > 1 ? (reducedFull * tileSampleWidth * tileSampleHeight) / (width * height) : 0;
  const subsampled = components.some(({ dx, dy }) => dx !== 1 || dy !== 1) ? reducedFull : 0;
  const parameters = tiles * (TILE_PARAMETER_BYTES + components.length * TILE_COMPONENT_PARAMETER_BYTES);
  return samples + tileBuffer + subsampled + structures + parameters;
}

/** Samples OpenJPEG decodes for `codestream` with `reducePower` levels dropped: every component at the reduced size. */
export function jpxDecodedSamples(codestream: JpxCodestream, reducePower: number): number {
  const width = codestream.x1 - codestream.x0;
  const height = codestream.y1 - codestream.y0;
  return ceilShift(width, reducePower) * ceilShift(height, reducePower) * codestream.components.length;
}

// ---------------------------------------------------------------------------------------------
// JBIG2
// ---------------------------------------------------------------------------------------------

const SEGMENT_SYMBOL_DICTIONARY = 0;
const SEGMENT_PATTERN_DICTIONARY = 16;
/** End of page and end of file: PDFium stops reading the segments there (jbig2_context.cpp, `ProcessingParseSegmentData`). */
const LAST_SEGMENTS = new Set([49, 51]);
const UNKNOWN_DATA_LENGTH = 0xffffffff;
/** Region segments (T.88 7.3): text 4/6/7, halftone 20/22/23, generic 36/38/39, refinement 40/42/43; the first of each is intermediate. */
const TEXT_REGIONS = new Set([4, 6, 7]);
const HALFTONE_REGIONS = new Set([20, 22, 23]);
const REGIONS = new Set([...TEXT_REGIONS, ...HALFTONE_REGIONS, 36, 38, 39, 40, 42, 43]);
/** PDFium keeps the bitmap of an intermediate region for the segments that refer to it (jbig2_context.cpp 862, 985, 1089, 1167). */
const INTERMEDIATE_REGIONS = new Set([4, 20, 36, 40]);
const REGION_INFO_BYTES = 17;
const HALFTONE_GRID_OFFSET = REGION_INFO_BYTES + 1;
const PATTERN_DICTIONARY_BYTES = 7;
const SYMBOL_FLAGS_BYTES = 2;
const SYMBOL_HUFFMAN = 0x0001;
const SYMBOL_REFINEMENT_AGGREGATE = 0x0002;
const SYMBOL_TEMPLATE_SHIFT = 10;
const SYMBOL_TEMPLATE_MASK = 0x3;
const SYMBOL_REFINEMENT_TEMPLATE = 0x1000;
const GENERIC_TEMPLATE_0_AT_BYTES = 8;
const GENERIC_OTHER_AT_BYTES = 2;
const REFINEMENT_AT_BYTES = 4;
/** A symbol is a `CJBig2_Image` (data vector, width, height, stride) held through a pointer; its bitmap is coded, so only this much is known. */
const SYMBOL_BYTES = 48;

/** Bytes of a PDFium JBIG2 bitmap: rows padded to 32 bits (`CJBig2_Image`, jbig2_image.cpp 70-84). */
function bitmapBytes(width: number, height: number): number {
  return Math.ceil(width / 32) * 4 * height;
}

/** Symbols a symbol dictionary exports and adds (T.88 7.4.2.1), each at least a `CJBig2_Image`. */
function symbolDictionaryBytes(data: Buffer, at: number, end: number): number {
  if (at + SYMBOL_FLAGS_BYTES > end) return 0;
  const flags = data.readUInt16BE(at);
  let counts = at + SYMBOL_FLAGS_BYTES;
  if ((flags & SYMBOL_HUFFMAN) === 0) counts += ((flags >> SYMBOL_TEMPLATE_SHIFT) & SYMBOL_TEMPLATE_MASK) === 0 ? GENERIC_TEMPLATE_0_AT_BYTES : GENERIC_OTHER_AT_BYTES;
  if ((flags & SYMBOL_REFINEMENT_AGGREGATE) !== 0 && (flags & SYMBOL_REFINEMENT_TEMPLATE) === 0) counts += REFINEMENT_AT_BYTES;
  if (counts + 8 > end) return 0;
  return (data.readUInt32BE(counts) + data.readUInt32BE(counts + 4)) * SYMBOL_BYTES;
}

/** What a run of JBIG2 segments allocates: bitmaps kept to the end, the largest one held at a time, and the levels of gray seen. */
interface Jbig2Allocation {
  kept: number;
  largest: number;
  grayLevels: number;
  pixels: number;
}

/**
 * Segments one walk reads at most. Neither PDFium nor pdf.js bounds the count (a segment ends where its data length says, and
 * the loop of `CJBig2_Context::ProcessingParseSegmentData` runs to the end of the data); this bound is ours. A walk that
 * reaches it is a lower bound of what the decoder would allocate: the decoder's own memory maximum (pdf-wasm-memory.ts) is what
 * stops the rest. The 131 JBIG2 streams of the 1,269 cached real-world PDFs hold at most 12 segments.
 */
const MAX_JBIG2_SEGMENTS = 65_536;
const FILE_HEADER_MAGIC = Buffer.from('974a42320d0a1a0a', 'hex');
const FILE_HEADER_MIN_BYTES = 9;
const FILE_HEADER_FLAGS_OFFSET = 8;
const FILE_HEADER_UNKNOWN_PAGES = 0x02;
const FILE_HEADER_WITH_PAGE_COUNT_BYTES = 13;
const FILE_HEADER_WITHOUT_PAGE_COUNT_BYTES = 9;

/**
 * `bytes` without the file header of a standalone JBIG2 file (T.88 annex D.4), which pdf.js removes from the data and the globals
 * before it hands them to the decoder (`Jbig2Stream.stripFileHeader`, pdf.worker.mjs 16009-16016). Only the segments follow it in
 * the stream the decoder reads, so a walk of the file's own bytes would read the header as segments.
 */
function stripFileHeader(bytes: Buffer): Buffer {
  if (bytes.length < FILE_HEADER_MIN_BYTES || !bytes.subarray(0, FILE_HEADER_MAGIC.length).equals(FILE_HEADER_MAGIC)) return bytes;
  const headerBytes = (bytes[FILE_HEADER_FLAGS_OFFSET] & FILE_HEADER_UNKNOWN_PAGES) === 0 ? FILE_HEADER_WITH_PAGE_COUNT_BYTES : FILE_HEADER_WITHOUT_PAGE_COUNT_BYTES;
  return bytes.subarray(headerBytes);
}

function emptyAllocation(): Jbig2Allocation {
  return { kept: 0, largest: 0, grayLevels: 1, pixels: 0 };
}

/** Adds what the segments of `data` allocate to `allocation`. */
function walkSegments(data: Buffer, allocation: Jbig2Allocation): void {
  let at = 0;
  let header = segmentHeaderAt(data, at);
  for (let walked = 0; header !== null && walked < MAX_JBIG2_SEGMENTS; walked++, header = segmentHeaderAt(data, at)) {
    const { type, dataStart } = header;
    const end = header.dataLength === UNKNOWN_DATA_LENGTH ? data.length : Math.min(data.length, dataStart + header.dataLength);
    if (REGIONS.has(type) && dataStart + REGION_INFO_BYTES <= end) {
      const width = data.readUInt32BE(dataStart);
      const height = data.readUInt32BE(dataStart + 4);
      let bytes = bitmapBytes(width, height);
      allocation.pixels += width * height;
      if (HALFTONE_REGIONS.has(type) && dataStart + HALFTONE_GRID_OFFSET + 8 <= end) {
        const planes = Math.max(1, Math.ceil(Math.log2(allocation.grayLevels)));
        bytes += (planes + 1) * bitmapBytes(data.readUInt32BE(dataStart + HALFTONE_GRID_OFFSET), data.readUInt32BE(dataStart + HALFTONE_GRID_OFFSET + 4));
      }
      if (INTERMEDIATE_REGIONS.has(type)) allocation.kept += bytes;
      else allocation.largest = Math.max(allocation.largest, bytes);
    } else if (type === SEGMENT_PATTERN_DICTIONARY && dataStart + PATTERN_DICTIONARY_BYTES <= end) {
      const levels = data.readUInt32BE(dataStart + 3) + 1;
      allocation.grayLevels = Math.max(allocation.grayLevels, levels);
      allocation.kept += 2 * bitmapBytes(levels * data[dataStart + 1], data[dataStart + 2]);
    } else if (type === SEGMENT_SYMBOL_DICTIONARY) {
      allocation.kept += symbolDictionaryBytes(data, dataStart, end);
    }
    if (header.dataLength === UNKNOWN_DATA_LENGTH || LAST_SEGMENTS.has(type)) return;
    at = dataStart + header.dataLength;
  }
}

/** A JBIG2Globals stream read once: what its segments allocate, and the bytes the decoder is given. */
export interface Jbig2Globals {
  allocation: Readonly<Jbig2Allocation>;
  bytes: number;
}

/** Reads the segments of a decoded JBIG2Globals stream, for every picture that names it. */
export function readJbig2Globals(stream: Buffer): Jbig2Globals {
  const globals = stripFileHeader(stream);
  const allocation = emptyAllocation();
  walkSegments(globals, allocation);
  return { allocation, bytes: globals.length };
}

/** Bytes of a JBIG2 decode, and the pixels of the regions it decodes. */
export interface Jbig2Cost {
  decoderBytes: number;
  pixels: number;
}

/**
 * What PDFium's decoder allocates for a JBIG2 picture of `width` x `height` (the dictionary's, which pdf.js passes; pdf.js.jbig2
 * decoder.cpp 32-62): the page buffer of 32-bit rows, the bitmap of every region its segments and those of `globals` declare (an
 * immediate region's bitmap is freed once composed, an intermediate one is kept), pattern dictionaries, the minimum of every
 * symbol, and the coded bytes it copies in. A region may be larger than the page; PDFium allocates it all the same.
 */
export function jbig2Cost(stream: Buffer, globals: Jbig2Globals | null, width: number, height: number): Jbig2Cost {
  const data = stripFileHeader(stream);
  const allocation: Jbig2Allocation = globals === null ? emptyAllocation() : { ...globals.allocation };
  walkSegments(data, allocation);
  const coded = data.length + (globals?.bytes ?? 0);
  return { decoderBytes: bitmapBytes(width, height) + allocation.kept + allocation.largest + coded, pixels: allocation.pixels };
}

// ---------------------------------------------------------------------------------------------
// CCITT fax
// ---------------------------------------------------------------------------------------------

/** pdf.js's default /Columns (`CCITTFaxStream`, pdf.worker.mjs 15671), and PDFium's largest width or height (faxmodule.cpp 43). */
const CCITT_DEFAULT_COLUMNS = 1728;
const CCITT_MAX_DIMENSION = 65535;

/**
 * Pixels PDFium's fax decoder walks for a picture: pdf.js asks for `height` rows (the dictionary's, pdf.js.jbig2 decoder.cpp
 * 64-88) and each row is decoded at /Columns, whatever the width. PDFium refuses a /Columns or a row count past 65,535
 * (`FaxModule::CreateDecoder`, faxmodule.cpp 681-707), and then nothing is decoded.
 */
export function ccittPixels(columns: number | null, rows: number | null, height: number): number {
  const decodedColumns = columns || CCITT_DEFAULT_COLUMNS;
  const decoderRows = rows || height;
  if (decodedColumns <= 0 || decodedColumns > CCITT_MAX_DIMENSION || decoderRows <= 0 || decoderRows > CCITT_MAX_DIMENSION) return 0;
  return decodedColumns * height;
}

