/**
 * Sigma X3F (Foveon) camera RAW files.
 *
 * Container (little-endian): a "FOVb" header, sections addressed by a directory whose offset is the
 * last u32 of the file ("SECd": version, count, then offset/length/type entries). Image sections
 * ("SECi") carry a 28-byte header: version, image type (2 preview, 3 or 1 sensor data), format, columns,
 * rows, row size. The CAMF section ("SECc") holds the camera calibration as named matrices.
 *
 * Sensor data comes in four encodings, told apart by the section's image type and format words:
 *  - type 3, format 0x1e ("TRUE", DP1/DP2 generation) and type 1, format 0x1e (Merrill generation):
 *    three full-resolution layers (bottom/red, middle/green, top/blue), each an independent bit plane:
 *
 *      u16 seed[3] (initial predictor per layer), u16 reserved,
 *      Huffman table: (code length, left-aligned code) byte pairs ended by a pair with length 0;
 *        the leaf value of the n-th pair is n, the number of extra bits that follow the code,
 *      u32 planeSize[3], then the planes, each starting on a 16-byte boundary.
 *
 *  - type 1, format 0x23 (Quattro): the same coding, preceded by three (u16 columns, u16 rows) layer
 *    sizes and with one zero word between the Huffman table and the plane sizes; the third layer has the
 *    sensor's full resolution, the first two half the columns and rows;
 *  - type 3, format 0x06 (SD14/SD15): tables of 1024 sample differences and 1024 Huffman code words,
 *    rows of interleaved three-layer samples, and a trailing table of the rows' byte offsets.
 *
 * A sample is the sum of a predictor and a signed difference. The difference is a Huffman-coded bit
 * count n followed by n bits: when the first bit is 0 the difference is the n-bit value minus (2^n - 1),
 * otherwise it is the n-bit value. Predictors follow the 2x2 Bayer-like grid: for columns 0 and 1 of a
 * row they come from the same column of the previous row of the same parity, afterwards from the sample
 * two columns to the left.
 *
 * Colour: black level from the CAMF dark-shield rectangles, white level from the CAMF saturation
 * levels (or the converter depth for Merrill and Quattro), white balance gains and the colour correction
 * matrix of the white balance named in the file header (both from CAMF; SD14/SD15 files list a
 * camera-to-XYZ matrix and a per-white-balance XYZ correction instead), producing linear sRGB, then the
 * sRGB transfer curve.
 */
import { RawDecodeError } from '../types';
import { applyMatrixAndSrgbEncode, exposureScale, MAX_SAMPLE_16, multiply3x3, RGB_CHANNELS, type Matrix3x3 } from './raw-srgb';

const FOVB_MAGIC = 'FOVb';
const SECTION_DIRECTORY_MAGIC = 'SECd';
const SECTION_IMAGE_MAGIC = 'SECi';
const SECTION_CAMF_MAGIC = 'SECc';
const SUPPORTED_MAJOR_VERSIONS: ReadonlySet<number> = new Set([2, 3, 4]);
const VERSION_MAJOR_SHIFT = 16;

const HEADER_VERSION_OFFSET = 4;
const DIRECTORY_POINTER_BYTES = 4;
const DIRECTORY_HEADER_BYTES = 12;
const DIRECTORY_ENTRY_BYTES = 12;
const MAX_DIRECTORY_ENTRIES = 4096;

const IMAGE_HEADER_BYTES = 28;
const IMAGE_TYPE_RAW = 3;
const IMAGE_FORMAT_TRUE = 0x1e;
const IMAGE_OFFSET_TYPE = 8;
const IMAGE_OFFSET_FORMAT = 12;
const IMAGE_OFFSET_COLUMNS = 16;
const IMAGE_OFFSET_ROWS = 20;

const TRUE_PLANES = 3;
const TRUE_SEED_BYTES = 8;
const TRUE_PLANE_ALIGNMENT = 16;
const TRUE_MAX_CODE_BITS = 8;
const TRUE_MAX_TABLE_PAIRS = 256;
const TRUE_MAX_EXTRA_BITS = 16;
/**
 * Pixel caps per layer, from the sensor arrays (margins included) of each generation, each with a few
 * percent of headroom: DP1/DP2 and SD14/SD15 sensors are 2688 x 1792, Merrill sensors 4928 x 3264
 * (16.1 MP) and the Quattro top layer 6272 x 3672 (23.0 MP). Anything larger is rejected before allocation.
 */
const X3F_TRUE_MAX_PIXELS = 5_000_000;
const X3F_HUFFMAN_MAX_PIXELS = 5_000_000;
const X3F_MERRILL_MAX_PIXELS = 17_000_000;
const X3F_QUATTRO_MAX_PIXELS = 24_000_000;
const SAMPLE_MAX = 0xffff;
const BITS_PER_BYTE = 8;
const BIT_WINDOW = 32;

const CAMF_HEADER_BYTES = 28;
const CAMF_TYPE_XOR = 2;
const CAMF_TYPE_BLOCK_HUFFMAN = 4;
const CAMF_TYPE_BYTE_HUFFMAN = 5;
const CAMF_MAX_DECODED_BYTES = 64 * 1024 * 1024;
const CAMF_TABLE_AREA_BYTES = 28;
const CAMF_STREAM_OFFSET = 32;
/** Type 4 packs two 12-bit values into three bytes. */
const BLOCK_BYTES_PER_VALUE = 1.5;
const CAMF_ENTRY_HEADER_BYTES = 20;
const CAMF_ENTRY_MATRIX = 'CMbM';
const CAMF_ENTRY_PROPERTY = 'CMbP';
const CAMF_ENTRY_TEXT = 'CMbT';
const CAMF_MAX_DIMENSIONS = 4;
const CAMF_MAX_NAME_BYTES = 256;

export interface X3fSection {
  offset: number;
  length: number;
  type: string;
}

export interface X3fImageSection extends X3fSection {
  imageType: number;
  format: number;
  columns: number;
  rows: number;
}

/** A named CAMF matrix: values in file order, first dimension varying slowest. */
export interface CamfMatrix {
  dims: number[];
  dimNames: string[];
  values: number[];
}

function fail(detail: string): RawDecodeError {
  return new RawDecodeError(`Sigma X3F file is malformed: ${detail}`);
}

function ascii(file: Buffer, offset: number, length: number): string {
  return file.toString('latin1', offset, offset + length);
}

function requireRange(file: Buffer, offset: number, length: number, what: string): void {
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > file.length) {
    throw fail(`${what} lies outside the file`);
  }
}

/** Whether the buffer starts like an X3F file. */
export function isX3f(file: Buffer): boolean {
  return file.length >= HEADER_VERSION_OFFSET && ascii(file, 0, FOVB_MAGIC.length) === FOVB_MAGIC;
}

/** Reads and bounds-checks the section directory. */
export function readX3fDirectory(file: Buffer): X3fSection[] {
  if (!isX3f(file)) throw new RawDecodeError('The file is not a Sigma X3F container', true);
  if (file.length < HEADER_VERSION_OFFSET + 4 + DIRECTORY_POINTER_BYTES) throw fail('the header is cut short');
  const version = file.readUInt32LE(HEADER_VERSION_OFFSET);
  if (!SUPPORTED_MAJOR_VERSIONS.has(version >>> VERSION_MAJOR_SHIFT)) {
    throw new RawDecodeError(`Sigma X3F version ${version >>> VERSION_MAJOR_SHIFT}.${version & 0xffff} is not supported`, true);
  }
  const directoryOffset = file.readUInt32LE(file.length - DIRECTORY_POINTER_BYTES);
  requireRange(file, directoryOffset, DIRECTORY_HEADER_BYTES, 'the section directory');
  if (ascii(file, directoryOffset, SECTION_DIRECTORY_MAGIC.length) !== SECTION_DIRECTORY_MAGIC) {
    throw fail('the section directory has no "SECd" marker');
  }
  const count = file.readUInt32LE(directoryOffset + 8);
  if (count > MAX_DIRECTORY_ENTRIES) throw fail(`the directory lists ${count} sections`);
  requireRange(file, directoryOffset + DIRECTORY_HEADER_BYTES, count * DIRECTORY_ENTRY_BYTES, 'the section directory');
  const sections: X3fSection[] = [];
  for (let index = 0; index < count; index += 1) {
    const at = directoryOffset + DIRECTORY_HEADER_BYTES + index * DIRECTORY_ENTRY_BYTES;
    const section = { offset: file.readUInt32LE(at), length: file.readUInt32LE(at + 4), type: ascii(file, at + 8, 4) };
    requireRange(file, section.offset, section.length, `the ${section.type} section`);
    sections.push(section);
  }
  return sections;
}

/** Parses the 28-byte header of every image section. */
export function readX3fImageSections(file: Buffer, sections: X3fSection[]): X3fImageSection[] {
  const images: X3fImageSection[] = [];
  for (const section of sections) {
    if (section.type !== 'IMAG' && section.type !== 'IMA2') continue;
    if (section.length < IMAGE_HEADER_BYTES) throw fail(`the ${section.type} section is shorter than its header`);
    if (ascii(file, section.offset, SECTION_IMAGE_MAGIC.length) !== SECTION_IMAGE_MAGIC) {
      throw fail(`the ${section.type} section has no "SECi" marker`);
    }
    images.push({
      ...section,
      imageType: file.readUInt32LE(section.offset + IMAGE_OFFSET_TYPE),
      format: file.readUInt32LE(section.offset + IMAGE_OFFSET_FORMAT),
      columns: file.readUInt32LE(section.offset + IMAGE_OFFSET_COLUMNS),
      rows: file.readUInt32LE(section.offset + IMAGE_OFFSET_ROWS),
    });
  }
  return images;
}

/** Bit reader over a bounded byte range, most significant bit first. Reading past the range throws. */
class BitReader {
  private position: number;
  private bitBuffer = 0;
  private bitCount = 0;
  private readonly end: number;

  constructor(private readonly data: Buffer, start: number, end: number) {
    this.position = start;
    this.end = end;
  }

  /** Returns the next `count` (1..16) bits as an unsigned integer. */
  readBits(count: number): number {
    this.fill(count);
    this.bitCount -= count;
    return (this.bitBuffer >>> this.bitCount) & ((1 << count) - 1);
  }

  /** Looks at the next `count` bits without consuming them; bits past the end read as zero. */
  peekBits(count: number): number {
    while (this.bitCount < count && this.position < this.end) this.load();
    const available = Math.min(this.bitCount, count);
    const value = (this.bitBuffer >>> (this.bitCount - available)) & ((1 << available) - 1);
    return value << (count - available);
  }

  skipBits(count: number): void {
    this.fill(count);
    this.bitCount -= count;
  }

  private fill(count: number): void {
    while (this.bitCount < count) {
      if (this.position >= this.end) throw fail('the compressed sensor data ends early');
      this.load();
    }
  }

  private load(): void {
    this.bitBuffer = ((this.bitBuffer << BITS_PER_BYTE) | this.data[this.position]) >>> 0;
    this.position += 1;
    this.bitCount += BITS_PER_BYTE;
    if (this.bitCount > BIT_WINDOW - BITS_PER_BYTE) throw new Error('bit buffer overflow');
  }
}

interface HuffmanLookup {
  /** Indexed by the next 8 bits: code length in the low byte, leaf value above it; 0 marks an unused pattern. */
  entries: Uint16Array;
}

function buildHuffmanLookup(lengths: number[], codes: number[]): HuffmanLookup {
  const entries = new Uint16Array(1 << TRUE_MAX_CODE_BITS);
  for (let leaf = 0; leaf < lengths.length; leaf += 1) {
    const length = lengths[leaf];
    if (length === 0) continue;
    if (length > TRUE_MAX_CODE_BITS) throw fail(`a Huffman code is ${length} bits long`);
    const shift = TRUE_MAX_CODE_BITS - length;
    const first = (codes[leaf] >> shift) << shift;
    for (let pattern = first; pattern < first + (1 << shift); pattern += 1) {
      if (entries[pattern] !== 0) throw fail('the Huffman table has overlapping codes');
      entries[pattern] = (leaf << TRUE_MAX_CODE_BITS) | length;
    }
  }
  return { entries };
}

/** Reads (length, code) pairs up to the pair with length 0. Returns the lookup and the offset after the terminator. */
function readHuffmanTable(file: Buffer, start: number, end: number): { lookup: HuffmanLookup; next: number } {
  const lengths: number[] = [];
  const codes: number[] = [];
  let at = start;
  for (;;) {
    if (at + 2 > end) throw fail('the Huffman table is not terminated');
    const length = file[at];
    const code = file[at + 1];
    at += 2;
    if (length === 0) break;
    // A table of 256 pairs (every 8-bit pattern its own code) is valid; only a 257th pair is too much.
    if (lengths.length >= TRUE_MAX_TABLE_PAIRS) throw fail('the Huffman table is too long');
    lengths.push(length);
    codes.push(code);
  }
  return { lookup: buildHuffmanLookup(lengths, codes), next: at };
}

/** Decodes one signed difference. */
function readDifference(reader: BitReader, lookup: HuffmanLookup): number {
  const entry = lookup.entries[reader.peekBits(TRUE_MAX_CODE_BITS)];
  if (entry === 0) throw fail('the compressed data holds an unassigned Huffman code');
  reader.skipBits(entry & 0xff);
  const bits = entry >> TRUE_MAX_CODE_BITS;
  if (bits === 0) return 0;
  if (bits > TRUE_MAX_EXTRA_BITS) throw fail(`a difference of ${bits} bits is not valid`);
  const first = reader.readBits(1);
  let value = first;
  if (bits > 1) value = (first << (bits - 1)) | reader.readBits(bits - 1);
  return first === 0 ? value - ((1 << bits) - 1) : value;
}

/** One decoded sensor layer; the older Huffman format stores signed samples relative to the sensor's own black. */
export type LayerPlane = Uint16Array | Int16Array;

export interface FoveonLayers {
  width: number;
  height: number;
  /**
   * Three planes (bottom, middle, top) at their stored resolution: width*height samples each, except the
   * Quattro lower layers, which hold half the columns and rows and are upsampled row by row on reading.
   */
  planes: LayerPlane[];
  /** Columns and rows of each plane. */
  dims: { columns: number; rows: number }[];
}

function checkPlaneSize(width: number, height: number, maxPixels: number): void {
  if (width < 2 || height < 2 || width * height > maxPixels) {
    throw new RawDecodeError(`Decoded RAW image of ${width}x${height} pixels exceeds the ${maxPixels} pixel limit`);
  }
}

interface TrueHeader {
  seeds: number[];
  lookup: HuffmanLookup;
  /** Byte range of each layer's compressed plane. */
  ranges: { start: number; end: number }[];
}

/**
 * Seeds, Huffman table and plane locations of a TRUE-coded section. `seedStart` is where the seeds begin;
 * Quattro sections hold one reserved word (zero) between the table and the plane sizes.
 */
function readTrueHeader(file: Buffer, seedStart: number, sectionEnd: number, reservedWordAfterTable: boolean): TrueHeader {
  if (seedStart + TRUE_SEED_BYTES > sectionEnd) throw fail('the sensor section is shorter than its header');
  const seeds = [file.readUInt16LE(seedStart), file.readUInt16LE(seedStart + 2), file.readUInt16LE(seedStart + 4)];
  const { lookup, next } = readHuffmanTable(file, seedStart + TRUE_SEED_BYTES, sectionEnd);
  let sizesAt = next;
  if (reservedWordAfterTable) {
    if (next + 4 > sectionEnd) throw fail('the plane size table is cut short');
    if (file.readUInt32LE(next) !== 0) throw new RawDecodeError('Sigma X3F Quattro section carries an unknown header word', true);
    sizesAt += 4;
  }
  const sizesEnd = sizesAt + TRUE_PLANES * 4;
  if (sizesEnd > sectionEnd) throw fail('the plane size table is cut short');
  const ranges: { start: number; end: number }[] = [];
  let planeStart = sizesEnd;
  for (let layer = 0; layer < TRUE_PLANES; layer += 1) {
    const size = file.readUInt32LE(sizesAt + layer * 4);
    const end = planeStart + size;
    if (end > sectionEnd) throw fail(`layer ${layer} extends past its section`);
    ranges.push({ start: planeStart, end });
    planeStart += Math.ceil(size / TRUE_PLANE_ALIGNMENT) * TRUE_PLANE_ALIGNMENT;
  }
  return { seeds, lookup, ranges };
}

/** Every sample costs at least one bit, so a smaller plane cannot hold the declared image. */
function checkPlaneCapacity(range: { start: number; end: number }, width: number, height: number, layer: number): void {
  if ((range.end - range.start) * BITS_PER_BYTE < width * height) throw fail(`layer ${layer} is too small for ${width}x${height} samples`);
}

/** Decodes the three full-resolution layers of a TRUE-format sensor section (DP1/DP2 and Merrill generations). */
export function decodeTrueLayers(file: Buffer, image: X3fImageSection, maxPixels: number = X3F_TRUE_MAX_PIXELS): FoveonLayers {
  const { columns: width, rows: height } = image;
  checkPlaneSize(width, height, maxPixels);
  const header = readTrueHeader(file, image.offset + IMAGE_HEADER_BYTES, image.offset + image.length, false);
  const planes: LayerPlane[] = header.ranges.map((range, layer) => {
    checkPlaneCapacity(range, width, height, layer);
    return decodeTruePlane(file, range.start, range.end, width, height, header.seeds[layer], header.lookup);
  });
  return { width, height, planes, dims: fullResolutionDims(width, height) };
}

function fullResolutionDims(columns: number, rows: number): { columns: number; rows: number }[] {
  return [0, 1, 2].map(() => ({ columns, rows }));
}

/** Entries of the difference table and of the code table in a Huffman-coded (SD14/SD15 generation) section. */
const HUFFMAN_TABLE_ENTRIES = 1024;
const HUFFMAN_TABLE_BYTES = HUFFMAN_TABLE_ENTRIES * 2 + HUFFMAN_TABLE_ENTRIES * 4;
/** A code word entry holds the code length in its top 5 bits and the code in the rest. */
const HUFFMAN_LENGTH_SHIFT = 27;
const HUFFMAN_CODE_MASK = (1 << HUFFMAN_LENGTH_SHIFT) - 1;
const HUFFMAN_MAX_CODE_BITS = 26;
/** A binary trie over at most 1024 codes of at most 26 bits cannot need more nodes than this. */
const HUFFMAN_MAX_NODES = HUFFMAN_TABLE_ENTRIES * HUFFMAN_MAX_CODE_BITS + 1;
const HUFFMAN_WORD_BYTES = 4;
/** The section ends with one u32 byte offset (from the start of the data) per row. */
const HUFFMAN_ROW_OFFSET_BYTES = 4;
const HUFFMAN_WORD_BITS = 32;
const HUFFMAN_NO_NODE = -1;
const INT16_MIN = -0x8000;
const INT16_MAX = 0x7fff;

interface HuffmanTrie {
  /** Child node of (node, bit) at index node * 2 + bit, or HUFFMAN_NO_NODE. */
  children: Int32Array;
  /** Index into the difference table for leaf nodes, HUFFMAN_NO_NODE otherwise. */
  leaves: Int32Array;
}

function buildHuffmanTrie(codes: Uint32Array): HuffmanTrie {
  const children = new Int32Array(HUFFMAN_MAX_NODES * 2).fill(HUFFMAN_NO_NODE);
  const leaves = new Int32Array(HUFFMAN_MAX_NODES).fill(HUFFMAN_NO_NODE);
  let nodeCount = 1;
  for (let leaf = 0; leaf < codes.length; leaf += 1) {
    const entry = codes[leaf];
    if (entry === 0) continue;
    const length = entry >>> HUFFMAN_LENGTH_SHIFT;
    if (length > HUFFMAN_MAX_CODE_BITS) throw fail(`a Huffman code is ${length} bits long`);
    const code = entry & HUFFMAN_CODE_MASK;
    let node = 0;
    for (let bit = length - 1; bit >= 0; bit -= 1) {
      if (leaves[node] !== HUFFMAN_NO_NODE) throw fail('the Huffman table has overlapping codes');
      const slot = node * 2 + ((code >>> bit) & 1);
      if (children[slot] === HUFFMAN_NO_NODE) {
        children[slot] = nodeCount;
        nodeCount += 1;
      }
      node = children[slot];
    }
    if (leaves[node] !== HUFFMAN_NO_NODE || children[node * 2] !== HUFFMAN_NO_NODE || children[node * 2 + 1] !== HUFFMAN_NO_NODE) {
      throw fail('the Huffman table has overlapping codes');
    }
    leaves[node] = leaf;
  }
  return { children, leaves };
}

/**
 * Decodes an SD14/SD15-generation section (format 0x06): a 1024-entry table of signed 16-bit sample
 * differences, a 1024-entry table of Huffman code words (length in the top 5 bits), then per row the
 * three layers' codes interleaved per pixel (layer 0, 1, 2), most significant bit first, each row in
 * whole 32-bit words and every row's predictors starting at zero: samples are signed and relative to
 * the first (optically dark) column of their row. The section ends with a table of the rows' byte
 * offsets, which bounds every row's bit reading.
 */
export function decodeHuffmanLayers(file: Buffer, image: X3fImageSection): FoveonLayers {
  const { columns: width, rows: height } = image;
  checkPlaneSize(width, height, X3F_HUFFMAN_MAX_PIXELS);
  const tableStart = image.offset + IMAGE_HEADER_BYTES;
  const sectionEnd = image.offset + image.length;
  const dataStart = tableStart + HUFFMAN_TABLE_BYTES;
  const offsetsStart = sectionEnd - height * HUFFMAN_ROW_OFFSET_BYTES;
  if (offsetsStart < dataStart) throw fail('the sensor section is shorter than its tables');
  // Every sample costs at least one bit, so the rows cannot hold fewer than three bits per pixel.
  if ((offsetsStart - dataStart) * BITS_PER_BYTE < width * height * TRUE_PLANES) throw fail(`the sensor data is too small for ${width}x${height} pixels`);
  const differences = new Int16Array(HUFFMAN_TABLE_ENTRIES);
  const codes = new Uint32Array(HUFFMAN_TABLE_ENTRIES);
  for (let index = 0; index < HUFFMAN_TABLE_ENTRIES; index += 1) {
    differences[index] = file.readInt16LE(tableStart + index * 2);
    codes[index] = file.readUInt32LE(tableStart + HUFFMAN_TABLE_ENTRIES * 2 + index * 4);
  }
  const { children, leaves } = buildHuffmanTrie(codes);

  const planes = [0, 1, 2].map(() => new Int16Array(width * height));
  let rowStart = file.readUInt32LE(offsetsStart);
  for (let row = 0; row < height; row += 1) {
    const rowEnd = row + 1 < height ? file.readUInt32LE(offsetsStart + (row + 1) * HUFFMAN_ROW_OFFSET_BYTES) : offsetsStart - dataStart;
    if (rowStart > rowEnd || rowEnd > offsetsStart - dataStart) throw fail(`row ${row} lies outside the sensor data`);
    if ((rowEnd - rowStart) * BITS_PER_BYTE < width * TRUE_PLANES) throw fail(`row ${row} is too small for ${width} pixels`);
    let position = dataStart + rowStart;
    const limit = dataStart + rowEnd;
    const predictors = [0, 0, 0];
    let word = 0;
    let bit = 0;
    for (let column = 0; column < width; column += 1) {
      for (let layer = 0; layer < TRUE_PLANES; layer += 1) {
        let node = 0;
        while (leaves[node] === HUFFMAN_NO_NODE) {
          if (bit === 0) {
            if (position + HUFFMAN_WORD_BYTES > limit) throw fail('the compressed sensor data ends early');
            word = file.readUInt32BE(position);
            position += HUFFMAN_WORD_BYTES;
            bit = HUFFMAN_WORD_BITS;
          }
          bit -= 1;
          node = children[node * 2 + ((word >>> bit) & 1)];
          if (node === HUFFMAN_NO_NODE) throw fail('the compressed data holds an unassigned Huffman code');
        }
        const value = predictors[layer] + differences[leaves[node]];
        if (value < INT16_MIN || value > INT16_MAX) throw fail('a decoded sample is outside the 16-bit range');
        predictors[layer] = value;
        planes[layer][row * width + column] = value;
      }
    }
    // The row table gives each row's exact extent: a row that ends early or late was decoded from damaged data.
    if (position !== limit) throw fail(`row ${row} does not end where the row table says`);
    rowStart = rowEnd;
  }
  return { width, height, planes, dims: fullResolutionDims(width, height) };
}

const QUATTRO_DIMENSION_BYTES = 12;
const QUATTRO_TOP_LAYER = 2;
/** The two lower layers have half the columns and rows of the sensor image. */
const QUATTRO_LOWER_SCALE = 2;

/**
 * Decodes a Quattro section: three TRUE-coded planes whose sizes are listed in the section. The top
 * layer is the sensor's full resolution; the two lower layers hold a quarter of the samples (half the
 * columns and rows) and stay at that resolution: `LayerRowReader` upsamples them one row at a time.
 */
export function decodeQuattroLayers(file: Buffer, image: X3fImageSection): FoveonLayers {
  const dimsAt = image.offset + IMAGE_HEADER_BYTES;
  if (dimsAt + QUATTRO_DIMENSION_BYTES > image.offset + image.length) throw fail('the sensor section is shorter than its header');
  const dims = [0, 1, 2].map((layer) => ({ columns: file.readUInt16LE(dimsAt + layer * 4), rows: file.readUInt16LE(dimsAt + layer * 4 + 2) }));
  const top = dims[QUATTRO_TOP_LAYER];
  checkPlaneSize(top.columns, top.rows, X3F_QUATTRO_MAX_PIXELS);
  if (top.columns < image.columns || top.rows !== image.rows) throw fail('the top layer does not cover the sensor image');
  for (const lower of dims.slice(0, QUATTRO_TOP_LAYER)) {
    if (lower.columns < 2 || lower.rows < 2 || lower.columns * QUATTRO_LOWER_SCALE < image.columns || lower.columns * QUATTRO_LOWER_SCALE > top.columns || lower.rows * QUATTRO_LOWER_SCALE !== top.rows) {
      throw fail('a lower layer does not match half the top layer');
    }
  }
  const header = readTrueHeader(file, dimsAt + QUATTRO_DIMENSION_BYTES, image.offset + image.length, true);
  const planes = header.ranges.map((range, layer) => {
    checkPlaneCapacity(range, dims[layer].columns, dims[layer].rows, layer);
    return decodeTruePlane(file, range.start, range.end, dims[layer].columns, dims[layer].rows, header.seeds[layer], header.lookup);
  });
  return { width: top.columns, height: top.rows, planes, dims };
}

/** Bilinear 2x upsampling of one lower Quattro layer, one output row at a time into a reused buffer. */
class UpsampledRows {
  private readonly columnLow: Int32Array;
  private readonly columnWeight: Float32Array;
  private readonly out: Uint16Array;

  constructor(private readonly plane: LayerPlane, private readonly width: number, private readonly height: number, outWidth: number) {
    this.out = new Uint16Array(outWidth);
    this.columnLow = new Int32Array(outWidth);
    this.columnWeight = new Float32Array(outWidth);
    for (let x = 0; x < outWidth; x += 1) {
      const position = Math.min(width - 1, Math.max(0, (x + 0.5) / QUATTRO_LOWER_SCALE - 0.5));
      this.columnLow[x] = Math.min(width - 2, Math.floor(position));
      this.columnWeight[x] = position - this.columnLow[x];
    }
  }

  /**
   * Output row `y`, by sample-centre alignment (output sample x lies at (x + 0.5) / 2 - 0.5 of the input
   * grid, clamped to the edges); columns past the doubled width repeat the last column. The returned
   * buffer is overwritten by the next call.
   */
  row(y: number): Uint16Array {
    const { plane, width, height, out, columnLow, columnWeight } = this;
    const position = Math.min(height - 1, Math.max(0, (y + 0.5) / QUATTRO_LOWER_SCALE - 0.5));
    const rowLow = Math.min(height - 2, Math.floor(position));
    const rowWeight = position - rowLow;
    const upper = rowLow * width;
    const lower = upper + width;
    for (let x = 0; x < out.length; x += 1) {
      const left = columnLow[x];
      const weight = columnWeight[x];
      const top = plane[upper + left] + weight * (plane[upper + left + 1] - plane[upper + left]);
      const bottom = plane[lower + left] + weight * (plane[lower + left + 1] - plane[lower + left]);
      out[x] = Math.round(top + rowWeight * (bottom - top));
    }
    return out;
  }
}

/**
 * Reads the layers row by row on the full-resolution grid: full-resolution planes are viewed in place,
 * reduced ones are upsampled on demand, so no full-size copy of a reduced layer is ever held.
 */
class LayerRowReader {
  private readonly upsampled: (UpsampledRows | null)[];

  constructor(private readonly layers: FoveonLayers) {
    this.upsampled = layers.planes.map((plane, layer) => {
      const { columns, rows } = layers.dims[layer];
      if (columns === layers.width && rows === layers.height) return null;
      return new UpsampledRows(plane, columns, rows, layers.width);
    });
  }

  /** Row `y` of `layer`, `width` samples; a reduced layer's row is valid until the next read of that layer. */
  row(layer: number, y: number): LayerPlane {
    const upsampled = this.upsampled[layer];
    if (upsampled) return upsampled.row(y);
    const { width } = this.layers;
    return this.layers.planes[layer].subarray(y * width, (y + 1) * width);
  }
}

function decodeTruePlane(
  file: Buffer,
  start: number,
  end: number,
  width: number,
  height: number,
  seed: number,
  lookup: HuffmanLookup
): Uint16Array {
  const reader = new BitReader(file, start, end);
  const plane = new Uint16Array(width * height);
  // Row-start predictors for the four (row parity, column parity) positions.
  const rowStart = [seed, seed, seed, seed];
  const running = [0, 0];
  for (let row = 0; row < height; row += 1) {
    const rowParity = (row & 1) * 2;
    for (let column = 0; column < width; column += 1) {
      const columnParity = column & 1;
      const difference = readDifference(reader, lookup);
      const previous = column < 2 ? rowStart[rowParity + columnParity] : running[columnParity];
      const value = previous + difference;
      if (value < 0 || value > SAMPLE_MAX) throw fail('a decoded sample is outside the 16-bit range');
      running[columnParity] = value;
      if (column < 2) rowStart[rowParity + columnParity] = value;
      plane[row * width + column] = value;
    }
  }
  return plane;
}

/** Decodes the CAMF payload of a section into bytes. */
export function decodeCamfBytes(file: Buffer, section: X3fSection): Buffer {
  if (section.length < CAMF_HEADER_BYTES) throw fail('the CAMF section is shorter than its header');
  if (ascii(file, section.offset, SECTION_CAMF_MAGIC.length) !== SECTION_CAMF_MAGIC) throw fail('the CAMF section has no "SECc" marker');
  const type = file.readUInt32LE(section.offset + 8);
  const first = file.readUInt32LE(section.offset + 12);
  const second = file.readUInt32LE(section.offset + 16);
  const third = file.readUInt32LE(section.offset + 20);
  const fourth = file.readUInt32LE(section.offset + 24);
  const dataStart = section.offset + CAMF_HEADER_BYTES;
  const dataEnd = section.offset + section.length;
  if (type === CAMF_TYPE_XOR) return decodeCamfXor(file.subarray(dataStart, dataEnd), fourth);
  if (type === CAMF_TYPE_BLOCK_HUFFMAN) return decodeCamfBlocks(file, dataStart, dataEnd, first, second, third, fourth);
  if (type === CAMF_TYPE_BYTE_HUFFMAN) return decodeCamfBytesHuffman(file, dataStart, dataEnd, first, second);
  throw new RawDecodeError(`Sigma X3F CAMF encoding ${type} is not supported`, true);
}

const CAMF_XOR_MULTIPLIER = 1597;
const CAMF_XOR_INCREMENT = 51749;
const CAMF_XOR_MODULUS = 244944;
/** The generator runs in 32-bit unsigned arithmetic: the first step from a large seed wraps. */
const UINT32_RANGE = 0x1_0000_0000;
const CAMF_XOR_SCALE = 301593171;
const CAMF_XOR_SHIFT_DIVISOR = 1 << 24;

function decodeCamfXor(data: Buffer, cryptKey: number): Buffer {
  const out = Buffer.alloc(data.length);
  let key = cryptKey;
  for (let i = 0; i < data.length; i += 1) {
    key = ((key * CAMF_XOR_MULTIPLIER + CAMF_XOR_INCREMENT) % UINT32_RANGE) % CAMF_XOR_MODULUS;
    const scaled = Math.floor((key * CAMF_XOR_SCALE) / CAMF_XOR_SHIFT_DIVISOR);
    const mask = ((((key << 8) - scaled) >> 1) + scaled) >>> 17;
    out[i] = data[i] ^ (mask & 0xff);
  }
  return out;
}

/** Every decoded value costs at least one bit of stream, so the stream bounds the output size. */
function assertCamfSize(decodedSize: number, streamBytes: number, bytesPerValue: number): void {
  if (decodedSize > CAMF_MAX_DECODED_BYTES) throw fail(`the CAMF block claims ${decodedSize} decoded bytes`);
  if (decodedSize > Math.ceil(streamBytes * BITS_PER_BYTE * bytesPerValue)) {
    throw fail(`the CAMF block declares ${decodedSize} decoded bytes, more than its stream can hold`);
  }
}

/** CAMF type 4: 12-bit values packed two per three bytes, coded like the sensor planes in blocks. */
function decodeCamfBlocks(file: Buffer, start: number, end: number, decodedSize: number, bias: number, blockSize: number, blockCount: number): Buffer {
  const { lookup, next } = readHuffmanTable(file, start, Math.min(end, start + CAMF_TABLE_AREA_BYTES));
  if (next > start + CAMF_TABLE_AREA_BYTES) throw fail('the CAMF Huffman table overruns its area');
  const streamStart = start + CAMF_STREAM_OFFSET;
  if (streamStart > end) throw fail('the CAMF stream is cut short');
  assertCamfSize(decodedSize, end - streamStart, BLOCK_BYTES_PER_VALUE);
  // The block grid bounds the loop: an empty or undersized grid would spin without producing output.
  if (blockSize === 0 || blockCount === 0 || blockSize * blockCount * BLOCK_BYTES_PER_VALUE < decodedSize) {
    throw fail(`the CAMF block grid ${blockSize}x${blockCount} cannot hold ${decodedSize} decoded bytes`);
  }
  const reader = new BitReader(file, streamStart, end);
  const out = Buffer.alloc(decodedSize);
  const rowStart = [bias, bias, bias, bias];
  const running = [0, 0];
  let target = 0;
  let oddValue = false;
  for (let row = 0; row < blockCount && target < decodedSize; row += 1) {
    const rowParity = (row & 1) * 2;
    for (let column = 0; column < blockSize && target < decodedSize; column += 1) {
      const columnParity = column & 1;
      const previous = column < 2 ? rowStart[rowParity + columnParity] : running[columnParity];
      const value = previous + readDifference(reader, lookup);
      running[columnParity] = value;
      if (column < 2) rowStart[rowParity + columnParity] = value;
      if (!oddValue) {
        out[target] = (value >> 4) & 0xff;
        target += 1;
        if (target < decodedSize) out[target] = (value << 4) & 0xf0;
      } else {
        out[target] |= (value >> 8) & 0x0f;
        target += 1;
        if (target < decodedSize) {
          out[target] = value & 0xff;
          target += 1;
        }
      }
      oddValue = !oddValue;
    }
  }
  if (target < decodedSize) throw fail('the CAMF block is shorter than its declared size');
  return out;
}

/** CAMF type 5: one running byte, a single difference per output byte. */
function decodeCamfBytesHuffman(file: Buffer, start: number, end: number, decodedSize: number, bias: number): Buffer {
  const { lookup, next } = readHuffmanTable(file, start, Math.min(end, start + CAMF_TABLE_AREA_BYTES));
  if (next > start + CAMF_TABLE_AREA_BYTES) throw fail('the CAMF Huffman table overruns its area');
  const streamStart = start + CAMF_STREAM_OFFSET;
  if (streamStart > end) throw fail('the CAMF stream is cut short');
  assertCamfSize(decodedSize, end - streamStart, 1);
  const reader = new BitReader(file, streamStart, end);
  const out = Buffer.alloc(decodedSize);
  let accumulator = bias;
  for (let i = 0; i < decodedSize; i += 1) {
    accumulator += readDifference(reader, lookup);
    out[i] = accumulator & 0xff;
  }
  return out;
}

const CAMF_MATRIX_ELEMENT_BYTES: Readonly<Record<number, number>> = { 0: 2, 1: 4, 2: 4, 3: 4, 5: 1, 6: 2 };

function readNulString(data: Buffer, offset: number): string {
  if (offset < 0 || offset >= data.length) throw fail('a CAMF name lies outside its entry');
  const limit = Math.min(data.length, offset + CAMF_MAX_NAME_BYTES);
  let end = offset;
  while (end < limit && data[end] !== 0) end += 1;
  if (end === limit) throw fail('a CAMF name is unterminated');
  return data.toString('latin1', offset, end);
}

function readMatrixValue(entry: Buffer, type: number, at: number): number {
  switch (type) {
    case 0:
      return entry.readInt16LE(at);
    case 1:
    case 2:
      return entry.readUInt32LE(at);
    case 3:
      return entry.readFloatLE(at);
    case 5:
      return entry.readUInt8(at);
    default:
      return entry.readUInt16LE(at);
  }
}

/** Parses the decoded CAMF bytes into named matrices (text and property entries are skipped). */
export function parseCamfMatrices(decoded: Buffer): Map<string, CamfMatrix> {
  const matrices = new Map<string, CamfMatrix>();
  let at = 0;
  while (at + CAMF_ENTRY_HEADER_BYTES <= decoded.length) {
    const id = ascii(decoded, at, 4);
    const size = decoded.readUInt32LE(at + 8);
    if ((id !== CAMF_ENTRY_MATRIX && id !== CAMF_ENTRY_PROPERTY && id !== CAMF_ENTRY_TEXT) || size < CAMF_ENTRY_HEADER_BYTES) {
      throw fail('the CAMF block holds an unknown entry');
    }
    if (at + size > decoded.length) throw fail('a CAMF entry extends past the block');
    const entry = decoded.subarray(at, at + size);
    if (id === CAMF_ENTRY_MATRIX) {
      const name = readNulString(entry, entry.readUInt32LE(12));
      matrices.set(name, parseMatrixEntry(entry));
    }
    at += size;
  }
  return matrices;
}

function parseMatrixEntry(entry: Buffer): CamfMatrix {
  const valueOffset = entry.readUInt32LE(16);
  if (valueOffset + 12 > entry.length) throw fail('a CAMF matrix header is cut short');
  const type = entry.readUInt32LE(valueOffset);
  const dimensions = entry.readUInt32LE(valueOffset + 4);
  const dataOffset = entry.readUInt32LE(valueOffset + 8);
  const elementBytes = CAMF_MATRIX_ELEMENT_BYTES[type];
  if (elementBytes === undefined) throw fail(`a CAMF matrix has the unknown element type ${type}`);
  if (dimensions < 1 || dimensions > CAMF_MAX_DIMENSIONS) throw fail(`a CAMF matrix has ${dimensions} dimensions`);
  if (valueOffset + 12 + dimensions * 12 > entry.length) throw fail('a CAMF matrix dimension table is cut short');
  const dims: number[] = [];
  const dimNames: string[] = [];
  let count = 1;
  for (let index = 0; index < dimensions; index += 1) {
    const at = valueOffset + 12 + index * 12;
    const dimension = entry.readUInt32LE(at);
    dims.push(dimension);
    dimNames.push(readNulString(entry, entry.readUInt32LE(at + 4)));
    count *= dimension;
    if (count > entry.length) throw fail('a CAMF matrix is larger than its entry');
  }
  if (dataOffset + count * elementBytes > entry.length) throw fail('a CAMF matrix extends past its entry');
  const values: number[] = [];
  for (let index = 0; index < count; index += 1) values.push(readMatrixValue(entry, type, dataOffset + index * elementBytes));
  return { dims, dimNames, values };
}

// ---------------------------------------------------------------------------------------------
// Colour pipeline
// ---------------------------------------------------------------------------------------------

const HEADER_OFFSET_COLUMNS = 28;
const HEADER_OFFSET_ROWS = 32;
const HEADER_OFFSET_WHITE_BALANCE = 40;
const HEADER_WHITE_BALANCE_BYTES = 32;
const HEADER_EXTENDED_MINOR_VERSION = 1;
/** From version 3 on the header always carries the white balance name; version 4 replaces the fixed fields by a tag table. */
const HEADER_FIXED_FIELDS_MAJOR_VERSION = 3;
const HEADER_TAG_TABLE_MAJOR_VERSION = 4;
/** Version 4 headers hold the finished image size at these offsets. */
const HEADER_V4_OFFSET_COLUMNS = 40;
const HEADER_V4_OFFSET_ROWS = 44;
const DEFAULT_WHITE_BALANCE = 'Auto';
const WHITE_BALANCE_NAME_PATTERN = /^[A-Za-z]{1,24}$/;
const MATRIX_ELEMENTS = 9;
const GAIN_ELEMENTS = 3;
const RECTANGLE_ELEMENTS = 4;
/** Calibration values (gains, matrix entries) outside this magnitude cannot come from a camera. */
const MAX_CALIBRATION_MAGNITUDE = 64;
const STATISTICS_STEP = 4;
/** Largest plausible capture ISO to native ISO ratio (6 stops either way). */
const MAX_ISO_RATIO = 64;
const SPATIAL_GAIN_MAX_ENTRY = 16;

export interface X3fHeaderInfo {
  columns: number;
  rows: number;
  whiteBalance: string;
}

export interface DecodedX3f {
  width: number;
  height: number;
  /** Interleaved gamma-encoded sRGB, 16 bits per sample. */
  rgb16: Uint16Array;
}

/** Output size and white balance recorded in the file header. */
export function readX3fHeaderInfo(file: Buffer): X3fHeaderInfo {
  if (!isX3f(file) || file.length < HEADER_OFFSET_WHITE_BALANCE) throw fail('the header is cut short');
  const version = file.readUInt32LE(HEADER_VERSION_OFFSET);
  const major = version >>> VERSION_MAJOR_SHIFT;
  if (major >= HEADER_TAG_TABLE_MAJOR_VERSION) {
    if (file.length < HEADER_V4_OFFSET_ROWS + 4) throw fail('the header is cut short');
    return { columns: file.readUInt32LE(HEADER_V4_OFFSET_COLUMNS), rows: file.readUInt32LE(HEADER_V4_OFFSET_ROWS), whiteBalance: DEFAULT_WHITE_BALANCE };
  }
  const columns = file.readUInt32LE(HEADER_OFFSET_COLUMNS);
  const rows = file.readUInt32LE(HEADER_OFFSET_ROWS);
  let whiteBalance = DEFAULT_WHITE_BALANCE;
  if (major >= HEADER_FIXED_FIELDS_MAJOR_VERSION || (version & 0xffff) >= HEADER_EXTENDED_MINOR_VERSION) {
    if (file.length < HEADER_OFFSET_WHITE_BALANCE + HEADER_WHITE_BALANCE_BYTES) throw fail('the header is cut short');
    const field = file.subarray(HEADER_OFFSET_WHITE_BALANCE, HEADER_OFFSET_WHITE_BALANCE + HEADER_WHITE_BALANCE_BYTES);
    const end = field.indexOf(0);
    const name = field.toString('latin1', 0, end < 0 ? field.length : end);
    if (!WHITE_BALANCE_NAME_PATTERN.test(name)) throw fail('the white balance name is not valid');
    whiteBalance = name;
  }
  return { columns, rows, whiteBalance };
}

function requireMatrix(matrices: Map<string, CamfMatrix>, name: string, elements: number, maxMagnitude: number): number[] {
  const matrix = matrices.get(name);
  if (!matrix || matrix.values.length !== elements) throw fail(`the calibration entry ${name} is missing or has the wrong size`);
  if (matrix.values.some((value) => !Number.isFinite(value) || Math.abs(value) > maxMagnitude)) {
    throw fail(`the calibration entry ${name} holds an impossible value`);
  }
  return matrix.values;
}

/** Name of the CAMF entry holding `suffix` for the white balance, whatever the camera model prefix is. */
function findWhiteBalanceEntry(matrices: Map<string, CamfMatrix>, whiteBalance: string, suffix: string): string {
  const wanted = `${whiteBalance}${suffix}`;
  for (const name of matrices.keys()) {
    if (name.endsWith(wanted) && /^\w*$/.test(name.slice(0, name.length - wanted.length))) return name;
  }
  throw new RawDecodeError(`Sigma X3F file has no ${suffix} calibration for the "${whiteBalance}" white balance`);
}

interface Rectangle {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function readRectangle(matrices: Map<string, CamfMatrix>, name: string, width: number, height: number): Rectangle | null {
  const matrix = matrices.get(name);
  if (!matrix || matrix.values.length !== RECTANGLE_ELEMENTS) return null;
  const [left, top, right, bottom] = matrix.values;
  const inside = [left, top, right, bottom].every(Number.isInteger) && left >= 0 && top >= 0 && left <= right && top <= bottom && right < width && bottom < height;
  return inside ? { left, top, right, bottom } : null;
}

/** Mean level of each layer inside the optically dark rectangles. */
function darkLevels(layers: FoveonLayers, reader: LayerRowReader, matrices: Map<string, CamfMatrix>): number[] {
  const rectangles = ['DarkShieldTop', 'DarkShieldBottom']
    .map((name) => readRectangle(matrices, name, layers.width, layers.height))
    .filter((rectangle): rectangle is Rectangle => rectangle !== null);
  if (rectangles.length === 0) throw fail('the calibration holds no valid dark-shield area');
  return layers.planes.map((_, layer) => {
    let sum = 0;
    let count = 0;
    for (const { left, top, right, bottom } of rectangles) {
      for (let y = top; y <= bottom; y += 1) {
        const row = reader.row(layer, y);
        for (let x = left; x <= right; x += 1) sum += row[x];
        count += right - left + 1;
      }
    }
    return sum / count;
  });
}

interface SpatialGainGrid {
  rows: number;
  columns: number;
  values: number[];
}

function readSpatialGain(matrices: Map<string, CamfMatrix>, whiteBalance: string): SpatialGainGrid | null {
  const matrix = matrices.get(`SpatialGain_${whiteBalance}`) ?? matrices.get('SpatialGain');
  if (!matrix) return null;
  if (matrix.dims.length !== 3 || matrix.dims[2] !== RGB_CHANNELS || matrix.dims[0] < 2 || matrix.dims[1] < 2) {
    throw fail('the spatial gain table has an unexpected shape');
  }
  if (matrix.values.some((value) => !Number.isFinite(value) || value <= 0 || value > SPATIAL_GAIN_MAX_ENTRY)) {
    throw fail('the spatial gain table holds an impossible value');
  }
  return { rows: matrix.dims[0], columns: matrix.dims[1], values: matrix.values };
}

/** Per-pixel spatial gain: bilinear over the grid, which spans the whole sensor image. */
class SpatialGainSampler {
  private readonly columnIndex: Int32Array;
  private readonly columnFraction: Float32Array;
  private rowOffset = 0;
  private rowNext = 0;
  private rowFraction = 0;

  constructor(private readonly grid: SpatialGainGrid, private readonly width: number, private readonly height: number) {
    this.columnIndex = new Int32Array(width);
    this.columnFraction = new Float32Array(width);
    for (let x = 0; x < width; x += 1) {
      const position = (x / width) * (grid.columns - 1);
      const index = Math.min(grid.columns - 2, Math.floor(position));
      this.columnIndex[x] = index;
      this.columnFraction[x] = position - index;
    }
  }

  setRow(y: number): void {
    const position = (y / this.height) * (this.grid.rows - 1);
    const index = Math.min(this.grid.rows - 2, Math.floor(position));
    this.rowOffset = index * this.grid.columns * RGB_CHANNELS;
    this.rowNext = this.rowOffset + this.grid.columns * RGB_CHANNELS;
    this.rowFraction = position - index;
  }

  gain(x: number, channel: number): number {
    const { values } = this.grid;
    const at = this.columnIndex[x] * RGB_CHANNELS + channel;
    const fraction = this.columnFraction[x];
    const top = values[this.rowOffset + at] + fraction * (values[this.rowOffset + at + RGB_CHANNELS] - values[this.rowOffset + at]);
    const bottom = values[this.rowNext + at] + fraction * (values[this.rowNext + at + RGB_CHANNELS] - values[this.rowNext + at]);
    return top + this.rowFraction * (bottom - top);
  }
}

type SensorVariant = 'true' | 'merrill' | 'quattro' | 'huffman';

/** Sensor data sections: type 3 is the DP1/DP2/SD14 generation, type 1 the Merrill and Quattro generations. */
const IMAGE_TYPE_RAW_V1 = 1;
const IMAGE_FORMAT_HUFFMAN = 0x06;
const IMAGE_FORMAT_QUATTRO = 0x23;

function findSensorSection(images: X3fImageSection[]): { sensor: X3fImageSection; variant: SensorVariant } {
  const sensor = images.find((image) => image.imageType === IMAGE_TYPE_RAW || image.imageType === IMAGE_TYPE_RAW_V1);
  if (!sensor) throw fail('the file holds no sensor data section');
  const describe = `type ${sensor.imageType} format 0x${sensor.format.toString(16)}`;
  if (sensor.imageType === IMAGE_TYPE_RAW && sensor.format === IMAGE_FORMAT_TRUE) return { sensor, variant: 'true' };
  if (sensor.imageType === IMAGE_TYPE_RAW && sensor.format === IMAGE_FORMAT_HUFFMAN) return { sensor, variant: 'huffman' };
  if (sensor.imageType === IMAGE_TYPE_RAW_V1 && sensor.format === IMAGE_FORMAT_TRUE) return { sensor, variant: 'merrill' };
  if (sensor.imageType === IMAGE_TYPE_RAW_V1 && sensor.format === IMAGE_FORMAT_QUATTRO) return { sensor, variant: 'quattro' };
  throw new RawDecodeError(`Sigma X3F sensor data (${describe}) is not supported`, true);
}

function decodeLayers(file: Buffer, sensor: X3fImageSection, variant: SensorVariant): FoveonLayers {
  switch (variant) {
    case 'huffman':
      return decodeHuffmanLayers(file, sensor);
    case 'quattro':
      return decodeQuattroLayers(file, sensor);
    default:
      return decodeTrueLayers(file, sensor, variant === 'merrill' ? X3F_MERRILL_MAX_PIXELS : X3F_TRUE_MAX_PIXELS);
  }
}

/**
 * The Merrill and Quattro generations record no saturation level; their sensors clip a little below the
 * converter's full scale (Merrill 4073..4077 of 4095, Quattro 16383 of 16383), so a layer counts as
 * saturated from this share of the full scale of the CAMF ImageDepth.
 */
const SENSOR_CLIP_FRACTION = 0.99;
const IMAGE_DEPTH_MIN = 8;
const IMAGE_DEPTH_MAX = 16;

/** Per-layer span between the dark level and saturation, in the planes' own units. */
function usableRange(variant: SensorVariant, matrices: Map<string, CamfMatrix>, black: number[]): number[] {
  let range: number[];
  if (variant === 'true') {
    range = requireMatrix(matrices, 'RawSaturationLevel', GAIN_ELEMENTS, SAMPLE_MAX).map((level, layer) => level - black[layer]);
  } else if (variant === 'huffman') {
    // Samples are relative to each row's dark first column: the span is the calibration's own.
    const saturation = requireMatrix(matrices, 'SaturationLevel', GAIN_ELEMENTS, SAMPLE_MAX);
    const dark = requireMatrix(matrices, 'DarkLevel', GAIN_ELEMENTS, SAMPLE_MAX);
    range = saturation.map((level, layer) => level - dark[layer]);
  } else {
    const [depth] = requireMatrix(matrices, 'ImageDepth', 1, IMAGE_DEPTH_MAX);
    if (!Number.isInteger(depth) || depth < IMAGE_DEPTH_MIN) throw fail(`the calibration image depth ${depth} is not valid`);
    range = black.map((level) => ((1 << depth) - 1) * SENSOR_CLIP_FRACTION - level);
  }
  if (range.some((value) => !(value > 1))) throw fail('the saturation level is not above the dark level');
  return range;
}

const XYZ_ELEMENTS = 9;
const TEMPERATURE_GAIN_ENTRY = 'TempGainFact';
/** XYZ (D65) to linear sRGB primaries, IEC 61966-2-1. */
const XYZ_D65_TO_SRGB: Matrix3x3 = [3.2404542, -1.5371385, -0.4985314, -0.969266, 1.8760108, 0.041556, 0.0556434, -0.2040259, 1.0572252];

/**
 * Matrix taking a layer triple (dark level removed) to linear sRGB, with the usable ranges and ISO
 * factor folded in. The TRUE-coded generations (DP1/DP2, Merrill, Quattro) list a colour matrix and white
 * balance gains per white balance; the SD14/SD15 generation lists one camera-to-XYZ matrix and, per
 * white balance, a 3x3 correction applied to the layer values first, with the layers in raw counts.
 */
function colourMatrix(variant: SensorVariant, matrices: Map<string, CamfMatrix>, whiteBalance: string, range: number[], isoFactor: number): number[] {
  const combined: number[] = [];
  if (variant === 'huffman') {
    const toXyz = requireMatrix(matrices, 'CamToXYZ_Flash', XYZ_ELEMENTS, MAX_CALIBRATION_MAGNITUDE) as unknown as Matrix3x3;
    const correction = requireMatrix(matrices, `WBCorrection_${whiteBalance}`, XYZ_ELEMENTS, MAX_CALIBRATION_MAGNITUDE) as unknown as Matrix3x3;
    const full = multiply3x3(correction, toXyz);
    const toSrgb = multiply3x3(XYZ_D65_TO_SRGB, full);
    const scale = range.reduce((sum, value) => sum + value, 0) / range.length;
    for (const value of toSrgb) combined.push((value * isoFactor) / scale);
    return combined;
  }
  const gains = requireMatrix(matrices, findWhiteBalanceEntry(matrices, whiteBalance, 'WBGain'), GAIN_ELEMENTS, MAX_CALIBRATION_MAGNITUDE);
  const colour = requireMatrix(matrices, findWhiteBalanceEntry(matrices, whiteBalance, 'CCMatrix'), MATRIX_ELEMENTS, MAX_CALIBRATION_MAGNITUDE);
  // Sensor temperature compensation, when the calibration lists one.
  const temperature = matrices.has(TEMPERATURE_GAIN_ENTRY) ? requireMatrix(matrices, TEMPERATURE_GAIN_ENTRY, GAIN_ELEMENTS, MAX_CALIBRATION_MAGNITUDE) : [1, 1, 1];
  if (temperature.some((value) => !(value > 0))) throw fail(`the calibration entry ${TEMPERATURE_GAIN_ENTRY} holds a non-positive gain`);
  // Colour matrix x diag(white balance gain x temperature gain x ISO factor / usable range).
  for (let row = 0; row < RGB_CHANNELS; row += 1) {
    for (let layer = 0; layer < RGB_CHANNELS; layer += 1) {
      combined.push((colour[row * RGB_CHANNELS + layer] * gains[layer] * temperature[layer] * isoFactor) / range[layer]);
    }
  }
  return combined;
}

/**
 * Decodes a Sigma X3F file (TRUE-format sensor data) into gamma-encoded 16-bit sRGB.
 *
 * Linear sRGB = colour matrix x white balance gains x (layer - dark level) / (saturation - dark level)
 * x ISO factor x spatial gain; matrix, gains, levels and spatial gain come from the file's CAMF block for
 * the white balance recorded in the header. The exposure is then normalised to a mid-grey scene average.
 */
export function decodeX3f(file: Buffer): DecodedX3f {
  const header = readX3fHeaderInfo(file);
  const sections = readX3fDirectory(file);
  const images = readX3fImageSections(file, sections);
  const { sensor, variant } = findSensorSection(images);
  const camf = sections.find((section) => section.type === 'CAMF');
  if (!camf) throw fail('the file holds no CAMF calibration section');
  const matrices = parseCamfMatrices(decodeCamfBytes(file, camf));

  const layers = decodeLayers(file, sensor, variant);
  const active = readRectangle(matrices, 'ActiveImageArea', layers.width, layers.height);
  if (!active) throw fail('the calibration holds no valid active image area');
  const width = active.right - active.left + 1;
  const height = active.bottom - active.top + 1;

  const reader = new LayerRowReader(layers);
  const black = darkLevels(layers, reader, matrices);
  const range = usableRange(variant, matrices, black);
  const fullScale = range.map((value, layer) => black[layer] + value);
  const isoFactor = isoScale(matrices);
  const spatial = readSpatialGain(matrices, header.whiteBalance);
  const sampler = spatial ? new SpatialGainSampler(spatial, layers.width, layers.height) : null;
  const combined = colourMatrix(variant, matrices, header.whiteBalance, range, isoFactor);

  if (combined.some((value) => !Number.isFinite(value))) throw fail('the combined calibration is not finite');
  assertDecodeMemory(layers, width * height);

  // Linear sRGB of one pixel, single precision; computed twice per sampled pixel rather than kept for the
  // whole image, which would cost 12 bytes per pixel.
  const pixel = new Float32Array(RGB_CHANNELS);
  const normalised: number[] = [0, 0, 0];
  const rows: LayerPlane[] = [];
  const loadRow = (y: number) => {
    sampler?.setRow(y + active.top);
    for (let layer = 0; layer < RGB_CHANNELS; layer += 1) rows[layer] = reader.row(layer, y + active.top);
  };
  const linearPixel = (x: number) => {
    let clipped = false;
    for (let layer = 0; layer < RGB_CHANNELS; layer += 1) {
      const value = rows[layer][x + active.left];
      if (value >= fullScale[layer]) clipped = true;
      const gain = sampler ? sampler.gain(x + active.left, layer) : 1;
      normalised[layer] = Math.max(0, value - black[layer]) * gain;
    }
    for (let row = 0; row < RGB_CHANNELS; row += 1) {
      pixel[row] =
        combined[row * RGB_CHANNELS] * normalised[0] +
        combined[row * RGB_CHANNELS + 1] * normalised[1] +
        combined[row * RGB_CHANNELS + 2] * normalised[2];
    }
    if (clipped) neutralise(pixel);
  };

  // First pass over the statistics grid only: the exposure that brings the scene average to mid-grey.
  const samples: number[] = [];
  for (let y = 0; y < height; y += STATISTICS_STEP) {
    loadRow(y);
    for (let x = 0; x < width; x += STATISTICS_STEP) {
      linearPixel(x);
      samples.push(Math.max(0, LUMA_RED * pixel[0] + LUMA_GREEN * pixel[1] + LUMA_BLUE * pixel[2]));
    }
  }
  const exposure = exposureScale(Float32Array.from(samples));

  const rgb16 = new Uint16Array(width * height * RGB_CHANNELS);
  for (let y = 0; y < height; y += 1) {
    loadRow(y);
    for (let x = 0; x < width; x += 1) {
      linearPixel(x);
      const out = (y * width + x) * RGB_CHANNELS;
      for (let channel = 0; channel < RGB_CHANNELS; channel += 1) {
        rgb16[out + channel] = Math.round(Math.min(1, Math.max(0, pixel[channel] * exposure)) * MAX_SAMPLE_16);
      }
    }
  }
  applyMatrixAndSrgbEncode(rgb16, IDENTITY);
  return { width, height, rgb16 };
}

/**
 * Ceiling of the typed arrays a decode holds at once: the stored layer planes plus the 16-bit output.
 * The per-generation pixel caps keep the largest real layouts (Quattro at its cap: about 216 MB) below
 * it; the thread's heap limit does not cover these buffers, so this check is what bounds them.
 */
export const X3F_DECODE_MEMORY_BUDGET_BYTES = 256 * 1024 * 1024;

function assertDecodeMemory(layers: FoveonLayers, outputPixels: number): void {
  const planeBytes = layers.planes.reduce((sum, plane) => sum + plane.byteLength, 0);
  const outputBytes = outputPixels * RGB_CHANNELS * Uint16Array.BYTES_PER_ELEMENT;
  if (planeBytes + outputBytes > X3F_DECODE_MEMORY_BUDGET_BYTES) {
    throw new RawDecodeError(`Sigma X3F decode needs ${planeBytes + outputBytes} bytes, above its ${X3F_DECODE_MEMORY_BUDGET_BYTES} byte limit`);
  }
}

const IDENTITY: Matrix3x3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const LUMA_RED = 0.2126;
const LUMA_GREEN = 0.7152;
const LUMA_BLUE = 0.0722;

/** Replaces a pixel whose layer reached saturation by its luminance: clipped colour is meaningless. */
function neutralise(pixel: Float32Array): void {
  const luma = LUMA_RED * pixel[0] + LUMA_GREEN * pixel[1] + LUMA_BLUE * pixel[2];
  pixel[0] = luma;
  pixel[1] = luma;
  pixel[2] = luma;
}

/** Ratio of the capture ISO to the sensor's native ISO: the layers are stored at the native sensitivity. */
function isoScale(matrices: Map<string, CamfMatrix>): number {
  const sensor = matrices.get('SensorISO')?.values[0];
  const capture = matrices.get('CaptureISO')?.values[0];
  if (sensor === undefined || capture === undefined) return 1;
  if (!Number.isFinite(sensor) || !Number.isFinite(capture) || !(sensor > 0) || !(capture > 0)) {
    throw fail('the calibration ISO values are not positive finite numbers');
  }
  const ratio = capture / sensor;
  if (ratio < 1 / MAX_ISO_RATIO || ratio > MAX_ISO_RATIO) throw fail(`the capture ISO ${capture} is implausible for a sensor ISO of ${sensor}`);
  return ratio;
}
