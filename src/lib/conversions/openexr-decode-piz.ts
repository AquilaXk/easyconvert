import { OpenExrDecodeError } from './openexr-decode-error';

/**
 * PIZ block decoder for OpenEXR, written from the OpenEXR file layout specification
 * ("Technical Introduction to OpenEXR", PIZ compression).
 *
 * A PIZ block holds: the used-value bitmap range, the bitmap bytes, the length of the Huffman
 * stream, and the canonical Huffman stream itself. Decoding is Huffman -> inverse Haar wavelet per
 * channel -> inverse value lookup table -> channel/scanline re-interleave. Every channel in a block
 * has x/y sampling of 1 (the caller rejects anything else).
 */

const BYTES_PER_WORD = 2;
const BYTES_PER_INT32 = 4;
const VALUE_RANGE = 1 << 16;
const BITMAP_BYTES = VALUE_RANGE >> 3;
const BITS_PER_BYTE = 8;
const WORD_MASK = 0xffff;
const SIGN_BIT_16 = 0x8000;
const WAVELET_14_BIT_LIMIT = 1 << 14;

// --- Huffman stream layout (specification constants) ---
const HUF_SYMBOL_COUNT = VALUE_RANGE + 1;
const HUF_DECODE_BITS = 14;
const HUF_DECODE_SIZE = 1 << HUF_DECODE_BITS;
const HUF_DECODE_MASK = HUF_DECODE_SIZE - 1;
/** Codes at most this long resolve through the direct lookup table; longer ones use canonical per-length ranges. */
const HUF_FIRST_LONG_CODE_BITS = HUF_DECODE_BITS + 1;
const HUF_HEADER_BYTES = 20;
const HUF_LENGTH_BITS = 6;
const HUF_LENGTH_MASK = (1 << HUF_LENGTH_BITS) - 1;
const HUF_RUN_COUNT_BITS = 8;
const HUF_SHORT_ZERO_RUN = 59;
const HUF_LONG_ZERO_RUN = 63;
const HUF_SHORTEST_LONG_RUN = 2 + HUF_LONG_ZERO_RUN - HUF_SHORT_ZERO_RUN;
const HUF_MAX_SPEC_CODE_BITS = 58;
/** Codes are held in doubles, which are exact to 53 bits; longer codes need 64-bit arithmetic. */
const HUF_MAX_SUPPORTED_CODE_BITS = 52;
const HUF_FAST_PEEK_BITS = 25;
const HUF_PEEK_SPLIT_BITS = 24;
const HUF_PEEK_SPLIT_SCALE = 2 ** HUF_PEEK_SPLIT_BITS;
const PEEK_WINDOW_BITS = 32;
const PEEK_NARROW_BITS = 24;
const BYTE_SHIFT_16 = 16;
const BYTE_SHIFT_24 = 24;

function malformed(message: string): never {
  throw new OpenExrDecodeError(`Invalid OpenEXR PIZ block: ${message}`, 'malformed');
}

function truncated(message: string): never {
  throw new OpenExrDecodeError(`Truncated OpenEXR PIZ block: ${message}`, 'truncated');
}

/** Reads bits MSB-first from `data`; bytes past `end` read as zero so codes may peek ahead of the tail. */
class BitPeeker {
  constructor(
    private readonly data: Buffer,
    private readonly start: number,
    private readonly end: number
  ) {}

  private byteAt(index: number): number {
    return index < this.end ? this.data[index] : 0;
  }

  /** Up to 14 bits (decode-table index) at `bitPos`. */
  peekTableIndex(bitPos: number): number {
    const at = this.start + (bitPos >> 3);
    const window =
      (this.byteAt(at) << BYTE_SHIFT_16) | (this.byteAt(at + 1) << BITS_PER_BYTE) | this.byteAt(at + 2);
    const shift = PEEK_NARROW_BITS - HUF_DECODE_BITS - (bitPos & 7);
    return (window >>> shift) & HUF_DECODE_MASK;
  }

  /** `count` (1..52) bits at `bitPos` as an exact number. */
  peekBits(bitPos: number, count: number): number {
    if (count <= HUF_FAST_PEEK_BITS) {
      const at = this.start + (bitPos >> 3);
      const window =
        ((this.byteAt(at) << BYTE_SHIFT_24) |
          (this.byteAt(at + 1) << BYTE_SHIFT_16) |
          (this.byteAt(at + 2) << BITS_PER_BYTE) |
          this.byteAt(at + 3)) >>>
        0;
      return ((window << (bitPos & 7)) >>> (PEEK_WINDOW_BITS - count)) >>> 0;
    }
    const high = this.peekBits(bitPos, count - HUF_PEEK_SPLIT_BITS);
    const low = this.peekBits(bitPos + count - HUF_PEEK_SPLIT_BITS, HUF_PEEK_SPLIT_BITS);
    return high * HUF_PEEK_SPLIT_SCALE + low;
  }
}

interface HuffmanTable {
  lengths: Uint8Array;
  codes: Float64Array;
  /** First canonical code of each length (the code of the first symbol with that length). */
  firstCode: Float64Array;
  /** Number of symbols per code length. */
  counts: Float64Array;
  longest: number;
  firstSymbol: number;
  lastSymbol: number;
}

/** MSB-first bit reader over the code length table bytes. */
class TableBitReader {
  private acc = 0;
  private accBits = 0;

  constructor(
    private readonly data: Buffer,
    private position: number,
    private readonly end: number
  ) {}

  /** Index of the first byte not yet consumed; a partly read byte counts as consumed. */
  get next(): number {
    return this.position;
  }

  getBits(count: number): number {
    while (this.accBits < count) {
      if (this.position >= this.end) truncated('code length table ends early');
      this.acc = ((this.acc << BITS_PER_BYTE) | this.data[this.position++]) >>> 0;
      this.accBits += BITS_PER_BYTE;
    }
    this.accBits -= count;
    const value = (this.acc >>> this.accBits) & ((1 << count) - 1);
    this.acc &= (1 << this.accBits) - 1;
    return value;
  }
}

/** Number of consecutive zero-length symbols announced by a run marker (59..63). */
function zeroRunLength(reader: TableBitReader, marker: number): number {
  if (marker === HUF_LONG_ZERO_RUN) return reader.getBits(HUF_RUN_COUNT_BITS) + HUF_SHORTEST_LONG_RUN;
  return marker - HUF_SHORT_ZERO_RUN + 2;
}

/** Reads the run-length-packed 6-bit code lengths of symbols im..iM. */
function readCodeLengths(reader: TableBitReader, im: number, iM: number): Uint8Array {
  const lengths = new Uint8Array(HUF_SYMBOL_COUNT);
  for (let sym = im; sym <= iM; sym++) {
    const length = reader.getBits(HUF_LENGTH_BITS);
    if (length < HUF_SHORT_ZERO_RUN) {
      lengths[sym] = length;
    } else {
      const run = zeroRunLength(reader, length);
      if (sym + run > iM + 1) malformed('zero run overruns the code length table');
      sym += run - 1;
    }
  }
  return lengths;
}

/** Counts symbols per code length and finds the longest length. */
function tallyCodeLengths(lengths: Uint8Array, im: number, iM: number): { counts: Float64Array; longest: number } {
  const counts = new Float64Array(HUF_MAX_SPEC_CODE_BITS + 1);
  let longest = 0;
  for (let sym = im; sym <= iM; sym++) {
    counts[lengths[sym]]++;
    longest = Math.max(longest, lengths[sym]);
  }
  return { counts, longest };
}

/** First canonical code of each length: longer codes get the numerically smaller prefixes. */
function firstCodePerLength(counts: Float64Array): Float64Array {
  const firstCode = new Float64Array(HUF_MAX_SPEC_CODE_BITS + 1);
  let carry = 0;
  for (let length = HUF_MAX_SPEC_CODE_BITS; length > 0; length--) {
    const half = Math.floor((carry + counts[length]) / 2);
    firstCode[length] = carry;
    carry = half;
  }
  return firstCode;
}

/** Assigns each symbol the next consecutive code of its length. */
function assignCanonicalCodes(lengths: Uint8Array, firstCode: Float64Array, im: number, iM: number): Float64Array {
  const nextCode = firstCode.slice();
  const codes = new Float64Array(HUF_SYMBOL_COUNT);
  for (let sym = im; sym <= iM; sym++) {
    const length = lengths[sym];
    if (length > 0) {
      codes[sym] = nextCode[length]++;
      if (codes[sym] >= 2 ** length) malformed('canonical code overflows its length');
    }
  }
  return codes;
}

/** Reads the code length table and assigns canonical codes. */
function unpackCodeTable(data: Buffer, pos: number, end: number, im: number, iM: number): { table: HuffmanTable; next: number } {
  const reader = new TableBitReader(data, pos, end);
  const lengths = readCodeLengths(reader, im, iM);
  const { counts, longest } = tallyCodeLengths(lengths, im, iM);
  if (longest > HUF_MAX_SUPPORTED_CODE_BITS) {
    throw new OpenExrDecodeError(
      `OpenEXR PIZ Huffman code of ${longest} bits exceeds the supported ${HUF_MAX_SUPPORTED_CODE_BITS} bits`,
      'unsupported'
    );
  }
  const firstCode = firstCodePerLength(counts);
  const codes = assignCanonicalCodes(lengths, firstCode, im, iM);
  return { table: { lengths, codes, firstCode, counts, longest, firstSymbol: im, lastSymbol: iM }, next: reader.next };
}

interface DecodeTables {
  shortLength: Uint8Array;
  shortSymbol: Int32Array;
  /** Marks the 14-bit prefixes owned by a long code, to reject overlapping code tables. */
  longPrefix: Uint8Array;
  /** Index of the first symbol of each length inside `longSymbols`. */
  longOffset: Int32Array;
  /** Symbols with codes over 14 bits, ordered by code length then symbol (= canonical code order). */
  longSymbols: Int32Array;
}

/** Offset of each long code length inside the length-sorted long symbol array, and the array's size. */
function longCodeOffsets(table: HuffmanTable): { longOffset: Int32Array; longTotal: number } {
  const longOffset = new Int32Array(HUF_MAX_SPEC_CODE_BITS + 1);
  let longTotal = 0;
  for (let length = HUF_FIRST_LONG_CODE_BITS; length <= table.longest; length++) {
    longOffset[length] = longTotal;
    longTotal += table.counts[length];
  }
  return { longOffset, longTotal };
}

function registerLongCode(tables: DecodeTables, table: HuffmanTable, sym: number): void {
  const length = table.lengths[sym];
  const code = table.codes[sym];
  const prefix = Math.floor(code / 2 ** (length - HUF_DECODE_BITS));
  if (tables.shortLength[prefix] !== 0) malformed('long code shares a prefix with a short code');
  tables.longPrefix[prefix] = 1;
  tables.longSymbols[tables.longOffset[length] + (code - table.firstCode[length])] = sym;
}

function registerShortCode(tables: DecodeTables, table: HuffmanTable, sym: number): void {
  const length = table.lengths[sym];
  const span = 1 << (HUF_DECODE_BITS - length);
  const first = table.codes[sym] * span;
  for (let i = 0; i < span; i++) {
    if (tables.shortLength[first + i] !== 0 || tables.longPrefix[first + i] !== 0) malformed('overlapping Huffman codes');
    tables.shortLength[first + i] = length;
    tables.shortSymbol[first + i] = sym;
  }
}

function buildDecodeTables(table: HuffmanTable): DecodeTables {
  const { longOffset, longTotal } = longCodeOffsets(table);
  const tables: DecodeTables = {
    shortLength: new Uint8Array(HUF_DECODE_SIZE),
    shortSymbol: new Int32Array(HUF_DECODE_SIZE),
    longPrefix: new Uint8Array(HUF_DECODE_SIZE),
    longOffset,
    longSymbols: new Int32Array(longTotal),
  };
  for (let sym = table.firstSymbol; sym <= table.lastSymbol; sym++) {
    const length = table.lengths[sym];
    if (length > HUF_DECODE_BITS) {
      registerLongCode(tables, table, sym);
    } else if (length > 0) {
      registerShortCode(tables, table, sym);
    }
  }
  return tables;
}

/** Length in bits of the code matched by the last successful decodeLongCode call. */
let matchedLength = 0;

/**
 * Resolves a code longer than 14 bits. Canonical codes of one length are consecutive integers, so
 * each length needs one range test; the cost per symbol is bounded by the number of long lengths.
 * Returns the symbol and stores its length in `matchedLength`; throws when no code matches.
 */
function decodeLongCode(tables: DecodeTables, table: HuffmanTable, peeker: BitPeeker, bitPos: number, index: number): number {
  if (tables.longPrefix[index] !== 0) {
    const wide = peeker.peekBits(bitPos, table.longest);
    for (let length = HUF_FIRST_LONG_CODE_BITS; length <= table.longest; length++) {
      const relative = Math.floor(wide / 2 ** (table.longest - length)) - table.firstCode[length];
      if (relative >= 0 && relative < table.counts[length]) {
        matchedLength = length;
        return tables.longSymbols[tables.longOffset[length] + relative];
      }
    }
  }
  return malformed('bit pattern matches no Huffman code');
}

interface HuffmanHeader {
  im: number;
  iM: number;
  bitCount: number;
  end: number;
}

function readHuffmanHeader(data: Buffer, start: number, length: number): HuffmanHeader {
  if (length < HUF_HEADER_BYTES) truncated('Huffman header is incomplete');
  const im = data.readUInt32LE(start);
  const iM = data.readUInt32LE(start + 4);
  if (im >= HUF_SYMBOL_COUNT || iM >= HUF_SYMBOL_COUNT) malformed('Huffman symbol range is invalid');
  if (im > iM) malformed('Huffman symbol range is empty');
  return { im, iM, bitCount: data.readUInt32LE(start + 12), end: start + length };
}

/** Expands a run-length symbol: repeats the previous word and returns the new output position. */
function applyRepeat(raw: Uint16Array, out: number, peeker: BitPeeker, bitPos: number, bitCount: number): number {
  if (bitPos + HUF_RUN_COUNT_BITS > bitCount) truncated('run length is cut off');
  const repeat = peeker.peekBits(bitPos, HUF_RUN_COUNT_BITS);
  if (out === 0) malformed('run length with no preceding symbol');
  if (out + repeat > raw.length) malformed('Huffman stream decodes to more data than expected');
  raw.fill(raw[out - 1], out, out + repeat);
  return out + repeat;
}

/** Decodes a PIZ Huffman stream into exactly `raw.length` 16-bit words. */
function huffmanDecode(data: Buffer, start: number, length: number, raw: Uint16Array): Uint16Array {
  const rawCount = raw.length;
  const { im, iM, bitCount, end } = readHuffmanHeader(data, start, length);
  const { table, next } = unpackCodeTable(data, start + HUF_HEADER_BYTES, end, im, iM);
  if (bitCount > BITS_PER_BYTE * (end - next)) truncated('Huffman bit stream is shorter than declared');
  const tables = buildDecodeTables(table);
  const peeker = new BitPeeker(data, next, end);
  const repeatSymbol = iM;

  let bitPos = 0;
  let out = 0;
  while (bitPos < bitCount) {
    const index = peeker.peekTableIndex(bitPos);
    const shortLen = tables.shortLength[index];
    let symbol: number;
    if (shortLen !== 0) {
      symbol = tables.shortSymbol[index];
      bitPos += shortLen;
    } else {
      symbol = decodeLongCode(tables, table, peeker, bitPos, index);
      bitPos += matchedLength;
    }
    if (bitPos > bitCount) truncated('Huffman code runs past the end of the bit stream');

    if (symbol === repeatSymbol) {
      out = applyRepeat(raw, out, peeker, bitPos, bitCount);
      bitPos += HUF_RUN_COUNT_BITS;
    } else {
      if (out >= rawCount) malformed('Huffman stream decodes to more data than expected');
      raw[out++] = symbol;
    }
  }
  if (out !== rawCount) truncated(`Huffman stream decoded ${out} of ${rawCount} words`);
  return raw;
}

// --- Inverse Haar wavelet (OpenEXR 14-bit and 16-bit variants) ---
let waveletA = 0;
let waveletB = 0;

function toInt16(value: number): number {
  return (value << BYTE_SHIFT_16) >> BYTE_SHIFT_16;
}

/** Inverse of the 14-bit lifting step: leaves the two outputs in waveletA and waveletB. */
function decode14(low: number, high: number): void {
  const ls = toInt16(low);
  const hs = toInt16(high);
  const ai = ls + (hs & 1) + (hs >> 1);
  waveletA = ai & WORD_MASK;
  waveletB = (ai - hs) & WORD_MASK;
}

/** Inverse of the 16-bit modulo lifting step. */
function decode16(low: number, high: number): void {
  const b = (low - (high >> 1)) & WORD_MASK;
  const a = (high + b - SIGN_BIT_16) & WORD_MASK;
  waveletA = a;
  waveletB = b;
}

type WaveletStep = (low: number, high: number) => void;

/** One level of the inverse transform over the grid with spacing `p` (the previous level had 2p). */
function waveletLevel(data: Uint16Array, base: number, nx: number, ox: number, ny: number, oy: number, p: number, step: WaveletStep): void {
  const p2 = p << 1;
  const oy1 = oy * p;
  const oy2 = oy * p2;
  const ox1 = ox * p;
  const ox2 = ox * p2;
  const lastY = base + oy * (ny - p2);
  let py = base;
  for (; py <= lastY; py += oy2) {
    let px = py;
    const lastX = py + ox * (nx - p2);
    for (; px <= lastX; px += ox2) {
      const p01 = px + ox1;
      const p10 = px + oy1;
      const p11 = p10 + ox1;
      step(data[px], data[p10]);
      const i00 = waveletA;
      const i10 = waveletB;
      step(data[p01], data[p11]);
      const i01 = waveletA;
      const i11 = waveletB;
      step(i00, i01);
      data[px] = waveletA;
      data[p01] = waveletB;
      step(i10, i11);
      data[p10] = waveletA;
      data[p11] = waveletB;
    }
    if ((nx & p) !== 0) {
      const p10 = px + oy1;
      step(data[px], data[p10]);
      data[px] = waveletA;
      data[p10] = waveletB;
    }
  }
  if ((ny & p) !== 0) {
    let px = py;
    const lastX = py + ox * (nx - p2);
    for (; px <= lastX; px += ox2) {
      const p01 = px + ox1;
      step(data[px], data[p01]);
      data[px] = waveletA;
      data[p01] = waveletB;
    }
  }
}

function waveletDecode(data: Uint16Array, base: number, nx: number, ox: number, ny: number, oy: number, maxValue: number): void {
  const step = maxValue < WAVELET_14_BIT_LIMIT ? decode14 : decode16;
  const smaller = Math.min(nx, ny);
  let top = 1;
  while (top <= smaller) top <<= 1;
  top >>= 1;
  // Levels run from the coarsest grid (spacing top / 2) down to spacing 1.
  for (let p = top >> 1; p >= 1; p >>= 1) {
    waveletLevel(data, base, nx, ox, ny, oy, p, step);
  }
}

/** Scratch arrays reused across the blocks of one image so large blocks are not reallocated each time. */
export class PizWorkspace {
  readonly bitmap = new Uint8Array(BITMAP_BYTES);
  readonly lut = new Uint16Array(VALUE_RANGE);
  private words = new Uint16Array(0);

  /** A view of exactly `count` words; contents are unspecified and must be fully overwritten. */
  wordsFor(count: number): Uint16Array {
    if (this.words.length < count) this.words = new Uint16Array(count);
    return this.words.subarray(0, count);
  }
}

/** Builds the reverse value table from the used-value bitmap; returns the highest index in use. */
function buildReverseLut(bitmap: Uint8Array, lut: Uint16Array): number {
  let count = 0;
  for (let value = 0; value < VALUE_RANGE; value++) {
    if (value === 0 || (bitmap[value >> 3] & (1 << (value & 7))) !== 0) lut[count++] = value;
  }
  lut.fill(0, count);
  return count - 1;
}

interface PizBlockLayout {
  maxValue: number;
  huffmanStart: number;
  huffmanLength: number;
}

/** Reads the value bitmap, builds the reverse lookup table and locates the Huffman stream. */
function readPizBlockHeader(input: Buffer, workspace: PizWorkspace): PizBlockLayout {
  let pos = 0;
  if (input.length < 2 * BYTES_PER_WORD) truncated('block header is incomplete');
  const minNonZero = input.readUInt16LE(pos);
  const maxNonZero = input.readUInt16LE(pos + BYTES_PER_WORD);
  pos += 2 * BYTES_PER_WORD;
  if (maxNonZero >= BITMAP_BYTES) malformed('bitmap range is out of bounds');

  const bitmap = workspace.bitmap;
  bitmap.fill(0);
  if (minNonZero <= maxNonZero) {
    const span = maxNonZero - minNonZero + 1;
    if (pos + span > input.length) truncated('bitmap is cut off');
    bitmap.set(input.subarray(pos, pos + span), minNonZero);
    pos += span;
  }
  const maxValue = buildReverseLut(bitmap, workspace.lut);

  if (pos + BYTES_PER_INT32 > input.length) truncated('Huffman length is missing');
  const huffmanLength = input.readInt32LE(pos);
  pos += BYTES_PER_INT32;
  if (huffmanLength < 0 || pos + huffmanLength > input.length) truncated('Huffman stream is cut off');
  return { maxValue, huffmanStart: pos, huffmanLength };
}

/** Applies the inverse wavelet to each channel plane; returns where each plane starts in `words`. */
function waveletPlanes(words: Uint16Array, width: number, rows: number, wordsPerChannel: readonly number[], maxValue: number): number[] {
  let planeStart = 0;
  const planeStarts: number[] = [];
  for (const channelWords of wordsPerChannel) {
    planeStarts.push(planeStart);
    for (let part = 0; part < channelWords; part++) {
      waveletDecode(words, planeStart + part, width, channelWords, rows, width * channelWords, maxValue);
    }
    planeStart += width * rows * channelWords;
  }
  return planeStarts;
}

/** Re-interleaves the channel planes into scanline order as little-endian words. */
function interleaveRows(words: Uint16Array, planeStarts: number[], width: number, rows: number, wordsPerChannel: readonly number[], out: Buffer): void {
  const cursors = planeStarts.slice();
  let outPos = 0;
  for (let y = 0; y < rows; y++) {
    for (let c = 0; c < wordsPerChannel.length; c++) {
      const run = width * wordsPerChannel[c];
      for (let i = 0; i < run; i++) {
        out.writeUInt16LE(words[cursors[c] + i], outPos);
        outPos += BYTES_PER_WORD;
      }
      cursors[c] += run;
    }
  }
}

/**
 * Decodes one PIZ block.
 * @param input compressed block bytes
 * @param width pixels per row in the block
 * @param rows number of rows in the block
 * @param wordsPerChannel 16-bit words per sample for each channel in file order (1 for HALF, 2 for FLOAT/UINT)
 * @param out receives the uncompressed block (rows of channel-major little-endian samples); must be exactly its size
 * @param workspace reusable scratch arrays
 */
export function decodePizBlock(
  input: Buffer,
  width: number,
  rows: number,
  wordsPerChannel: readonly number[],
  out: Buffer,
  workspace: PizWorkspace = new PizWorkspace()
): void {
  const { maxValue, huffmanStart, huffmanLength } = readPizBlockHeader(input, workspace);
  const wordsPerPixel = wordsPerChannel.reduce((sum, words) => sum + words, 0);
  const wordCount = width * rows * wordsPerPixel;
  if (out.length !== wordCount * BYTES_PER_WORD) malformed(`output holds ${out.length} bytes, block needs ${wordCount * BYTES_PER_WORD}`);
  const words = huffmanDecode(input, huffmanStart, huffmanLength, workspace.wordsFor(wordCount));

  const planeStarts = waveletPlanes(words, width, rows, wordsPerChannel, maxValue);
  const lut = workspace.lut;
  for (let i = 0; i < words.length; i++) words[i] = lut[words[i]];
  interleaveRows(words, planeStarts, width, rows, wordsPerChannel, out);
}
