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
  firstSymbol: number;
  lastSymbol: number;
}

/** Reads the run-length-packed code length table (6-bit lengths, MSB-first) and assigns canonical codes. */
function unpackCodeTable(data: Buffer, pos: number, end: number, im: number, iM: number): { table: HuffmanTable; next: number } {
  const lengths = new Uint8Array(HUF_SYMBOL_COUNT);
  let p = pos;
  let acc = 0;
  let accBits = 0;
  const getBits = (count: number): number => {
    while (accBits < count) {
      if (p >= end) truncated('code length table ends early');
      acc = ((acc << BITS_PER_BYTE) | data[p++]) >>> 0;
      accBits += BITS_PER_BYTE;
    }
    accBits -= count;
    const value = (acc >>> accBits) & ((1 << count) - 1);
    acc &= (1 << accBits) - 1;
    return value;
  };

  for (let sym = im; sym <= iM; sym++) {
    const length = getBits(HUF_LENGTH_BITS);
    if (length >= HUF_SHORT_ZERO_RUN) {
      const run =
        length === HUF_LONG_ZERO_RUN
          ? getBits(HUF_RUN_COUNT_BITS) + HUF_SHORTEST_LONG_RUN
          : length - HUF_SHORT_ZERO_RUN + 2;
      if (sym + run > iM + 1) malformed('zero run overruns the code length table');
      sym += run - 1;
    } else {
      lengths[sym] = length;
    }
  }

  // Canonical code assignment: longer codes get numerically smaller prefixes first.
  const counts = new Float64Array(HUF_MAX_SPEC_CODE_BITS + 1);
  let longest = 0;
  for (let sym = im; sym <= iM; sym++) {
    counts[lengths[sym]]++;
    if (lengths[sym] > longest) longest = lengths[sym];
  }
  if (longest > HUF_MAX_SUPPORTED_CODE_BITS) {
    throw new OpenExrDecodeError(
      `OpenEXR PIZ Huffman code of ${longest} bits exceeds the supported ${HUF_MAX_SUPPORTED_CODE_BITS} bits`,
      'unsupported'
    );
  }
  const nextCode = new Float64Array(HUF_MAX_SPEC_CODE_BITS + 1);
  let carry = 0;
  for (let length = HUF_MAX_SPEC_CODE_BITS; length > 0; length--) {
    const half = Math.floor((carry + counts[length]) / 2);
    nextCode[length] = carry;
    carry = half;
  }
  const codes = new Float64Array(HUF_SYMBOL_COUNT);
  for (let sym = im; sym <= iM; sym++) {
    const length = lengths[sym];
    if (length > 0) {
      codes[sym] = nextCode[length]++;
      if (codes[sym] >= 2 ** length) malformed('canonical code overflows its length');
    }
  }
  return { table: { lengths, codes, firstSymbol: im, lastSymbol: iM }, next: p };
}

interface DecodeTables {
  shortLength: Uint8Array;
  shortSymbol: Int32Array;
  longSymbols: Map<number, number[]>;
}

function buildDecodeTables(table: HuffmanTable): DecodeTables {
  const shortLength = new Uint8Array(HUF_DECODE_SIZE);
  const shortSymbol = new Int32Array(HUF_DECODE_SIZE);
  const longSymbols = new Map<number, number[]>();
  for (let sym = table.firstSymbol; sym <= table.lastSymbol; sym++) {
    const length = table.lengths[sym];
    if (length === 0) continue;
    const code = table.codes[sym];
    if (length > HUF_DECODE_BITS) {
      const prefix = Math.floor(code / 2 ** (length - HUF_DECODE_BITS));
      if (shortLength[prefix] !== 0) malformed('long code shares a prefix with a short code');
      const list = longSymbols.get(prefix);
      if (list) {
        list.push(sym);
      } else {
        longSymbols.set(prefix, [sym]);
      }
    } else {
      const span = 1 << (HUF_DECODE_BITS - length);
      const first = code * span;
      for (let i = 0; i < span; i++) {
        if (shortLength[first + i] !== 0 || longSymbols.has(first + i)) malformed('overlapping Huffman codes');
        shortLength[first + i] = length;
        shortSymbol[first + i] = sym;
      }
    }
  }
  return { shortLength, shortSymbol, longSymbols };
}

/** Decodes a PIZ Huffman stream into exactly `rawCount` 16-bit words. */
function huffmanDecode(data: Buffer, start: number, length: number, rawCount: number): Uint16Array {
  const raw = new Uint16Array(rawCount);
  if (length < HUF_HEADER_BYTES) truncated('Huffman header is incomplete');
  const end = start + length;
  const im = data.readUInt32LE(start);
  const iM = data.readUInt32LE(start + 4);
  const bitCount = data.readUInt32LE(start + 12);
  if (im >= HUF_SYMBOL_COUNT || iM >= HUF_SYMBOL_COUNT) malformed('Huffman symbol range is invalid');
  if (im > iM) malformed('Huffman symbol range is empty');

  const { table, next } = unpackCodeTable(data, start + HUF_HEADER_BYTES, end, im, iM);
  if (bitCount > BITS_PER_BYTE * (end - next)) truncated('Huffman bit stream is shorter than declared');
  const tables = buildDecodeTables(table);
  const peeker = new BitPeeker(data, next, end);
  const repeatSymbol = iM;

  let bitPos = 0;
  let out = 0;
  while (bitPos < bitCount) {
    const index = peeker.peekTableIndex(bitPos);
    let symbol = -1;
    const shortLen = tables.shortLength[index];
    if (shortLen !== 0) {
      symbol = tables.shortSymbol[index];
      bitPos += shortLen;
    } else {
      const candidates = tables.longSymbols.get(index);
      if (!candidates) malformed('bit pattern matches no Huffman code');
      for (const candidate of candidates) {
        const candidateLength = table.lengths[candidate];
        if (peeker.peekBits(bitPos, candidateLength) === table.codes[candidate]) {
          symbol = candidate;
          bitPos += candidateLength;
          break;
        }
      }
      if (symbol < 0) malformed('bit pattern matches no Huffman code');
    }
    if (bitPos > bitCount) truncated('Huffman code runs past the end of the bit stream');

    if (symbol === repeatSymbol) {
      if (bitPos + HUF_RUN_COUNT_BITS > bitCount) truncated('run length is cut off');
      const repeat = peeker.peekBits(bitPos, HUF_RUN_COUNT_BITS);
      bitPos += HUF_RUN_COUNT_BITS;
      if (out === 0) malformed('run length with no preceding symbol');
      if (out + repeat > rawCount) malformed('Huffman stream decodes to more data than expected');
      raw.fill(raw[out - 1], out, out + repeat);
      out += repeat;
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

function waveletDecode(data: Uint16Array, base: number, nx: number, ox: number, ny: number, oy: number, maxValue: number): void {
  const step = maxValue < WAVELET_14_BIT_LIMIT ? decode14 : decode16;
  const smaller = Math.min(nx, ny);
  let p = 1;
  while (p <= smaller) p <<= 1;
  p >>= 1;
  let p2 = p;
  p >>= 1;

  while (p >= 1) {
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
    p2 = p;
    p >>= 1;
  }
}

/** Builds the reverse value table from the used-value bitmap; returns the highest index in use. */
function buildReverseLut(bitmap: Uint8Array, lut: Uint16Array): number {
  let count = 0;
  for (let value = 0; value < VALUE_RANGE; value++) {
    if (value === 0 || (bitmap[value >> 3] & (1 << (value & 7))) !== 0) lut[count++] = value;
  }
  return count - 1;
}

/**
 * Decodes one PIZ block.
 * @param input compressed block bytes
 * @param width pixels per row in the block
 * @param rows number of rows in the block
 * @param wordsPerChannel 16-bit words per sample for each channel in file order (1 for HALF, 2 for FLOAT/UINT)
 * @returns the uncompressed block (rows of channel-major little-endian samples)
 */
export function decodePizBlock(input: Buffer, width: number, rows: number, wordsPerChannel: readonly number[]): Buffer {
  let pos = 0;
  if (input.length < 2 * BYTES_PER_WORD) truncated('block header is incomplete');
  const minNonZero = input.readUInt16LE(pos);
  const maxNonZero = input.readUInt16LE(pos + BYTES_PER_WORD);
  pos += 2 * BYTES_PER_WORD;
  if (maxNonZero >= BITMAP_BYTES) malformed('bitmap range is out of bounds');

  const bitmap = new Uint8Array(BITMAP_BYTES);
  if (minNonZero <= maxNonZero) {
    const span = maxNonZero - minNonZero + 1;
    if (pos + span > input.length) truncated('bitmap is cut off');
    bitmap.set(input.subarray(pos, pos + span), minNonZero);
    pos += span;
  }
  const lut = new Uint16Array(VALUE_RANGE);
  const maxValue = buildReverseLut(bitmap, lut);

  if (pos + 4 > input.length) truncated('Huffman length is missing');
  const huffmanLength = input.readInt32LE(pos);
  pos += 4;
  if (huffmanLength < 0 || pos + huffmanLength > input.length) truncated('Huffman stream is cut off');

  const wordsPerPixel = wordsPerChannel.reduce((sum, words) => sum + words, 0);
  const wordCount = width * rows * wordsPerPixel;
  const words = huffmanDecode(input, pos, huffmanLength, wordCount);

  let planeStart = 0;
  const planeStarts: number[] = [];
  for (const channelWords of wordsPerChannel) {
    planeStarts.push(planeStart);
    for (let part = 0; part < channelWords; part++) {
      waveletDecode(words, planeStart + part, width, channelWords, rows, width * channelWords, maxValue);
    }
    planeStart += width * rows * channelWords;
  }
  for (let i = 0; i < words.length; i++) words[i] = lut[words[i]];

  const out = Buffer.alloc(wordCount * BYTES_PER_WORD);
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
  return out;
}
