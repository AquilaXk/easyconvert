import {
  ReverseBitReader,
  buildFseDecodeTable,
  readFseNormalizedTable,
  zstdFail,
  type FseDecodeTable,
} from './zstd-fse';
import { DecompressionLimitError } from '../types';
import { decodeHuffmanLiterals, readHuffmanTable, type HuffmanDecodeTable } from './zstd-huffman';
import {
  LL_BASELINE,
  LL_BITS,
  ML_BASELINE,
  ML_BITS,
  ZSTD_BLOCK_SIZE_MAX,
  ZSTD_DECODER_WINDOW_SIZE_MAX,
  ZSTD_LL_DEFAULT_ACCURACY_LOG,
  ZSTD_LL_DEFAULT_DISTRIBUTION,
  ZSTD_LL_MAX_ACCURACY_LOG,
  ZSTD_LL_MAX_CODE,
  ZSTD_ML_DEFAULT_ACCURACY_LOG,
  ZSTD_ML_DEFAULT_DISTRIBUTION,
  ZSTD_ML_MAX_ACCURACY_LOG,
  ZSTD_ML_MAX_CODE,
  ZSTD_OF_DEFAULT_ACCURACY_LOG,
  ZSTD_OF_DEFAULT_DISTRIBUTION,
  ZSTD_OF_MAX_ACCURACY_LOG,
  ZSTD_OF_MAX_CODE,
  ZSTD_REP_OFFSET_INITIAL,
} from './zstd-tables';

/**
 * RFC 8878 compressed-block decoder: literals section (raw, RLE, Huffman, treeless) and
 * sequences section (predefined, RLE, FSE-compressed and repeat table modes).
 */

const LITERALS_RAW = 0;
const LITERALS_RLE = 1;
const LITERALS_COMPRESSED = 2;
const LITERALS_TREELESS = 3;

const MODE_PREDEFINED = 0;
const MODE_RLE = 1;
const MODE_COMPRESSED = 2;
const MODE_REPEAT = 3;
const LL_MODE_SHIFT = 6;
const OF_MODE_SHIFT = 4;
const ML_MODE_SHIFT = 2;
const MODE_FIELD_MASK = 0x03;

const SEQ_COUNT_TWO_BYTE_BASE = 128;
const SEQ_COUNT_THREE_BYTE_MARKER = 255;
const SEQ_COUNT_THREE_BYTE_BASE = 0x7f00;
const SEQ_RESERVED_MODE_MASK = 0x03;
const COMPRESSED_LITERALS_SIZE_BITS: readonly number[] = [10, 10, 14, 18];
const COMPRESSED_LITERALS_HEADER_BYTES: readonly number[] = [3, 3, 4, 5];
const SHORT_COPY_LIMIT = 32;
/** Matches at least this long that do not overlap themselves are moved with one native copy. */
const LONG_COPY_LIMIT = 64;
const WORD_BYTES = 4;
const LITERAL_HEADER_TYPE_MASK = 0x03;
const LITERAL_HEADER_FORMAT_SHIFT = 2;
const LITERAL_HEADER_FORMAT_MASK = 0x03;
const BYTE_RADIX = 256;

// Raw/RLE literals size formats (RFC 8878 section 3.1.1.3.1.1): the size field starts after the
// 4 type+format bits, except in the 1-byte form where it occupies the upper 5 bits.
const SIZE_FORMAT_ONE_BYTE = 0;
const SIZE_FORMAT_TWO_BYTES = 1;
const SIZE_FORMAT_ONE_BYTE_ALT = 2;
const LITERAL_SIZE_ONE_BYTE_SHIFT = 3;
const LITERAL_HEADER_SIZE_SHIFT = 4;
const LITERAL_HEADER_TYPE_FORMAT_RADIX = 2 ** LITERAL_HEADER_SIZE_SHIFT;
const LITERAL_SIZE_SECOND_BYTE_SCALE = 2 ** LITERAL_HEADER_SIZE_SHIFT;
const LITERAL_SIZE_THIRD_BYTE_SCALE = 2 ** (LITERAL_HEADER_SIZE_SHIFT + 8);
const RAW_HEADER_BYTES_ONE = 1;
const RAW_HEADER_BYTES_TWO = 2;
const RAW_HEADER_BYTES_THREE = 3;

/** RFC 8878 section 5 dictionary magic; the 4 bytes after it are the Dictionary_ID. */
export const ZSTD_DICTIONARY_MAGIC = 0xec30a437;
/** Legacy header used by this project's content-only formatted dictionaries. */
export const ZSTD_DICTIONARY_MAGIC_LEGACY = 0xec30a428;
const DICTIONARY_HEADER_BYTES = 8;
const DICTIONARY_REP_OFFSET_COUNT = 3;
const DICTIONARY_REP_OFFSET_BYTES = 4 * DICTIONARY_REP_OFFSET_COUNT;

export interface ZstdParsedDictionary {
  /** Dictionary_ID from the header, or null for raw-content dictionaries. */
  id: number | null;
  /** History made available to matches: the dictionary content. */
  content: Uint8Array;
  /** Entropy state and repeat offsets a frame starts from; null when the dictionary has none. */
  entropy: {
    huffman: HuffmanDecodeTable;
    llTable: FseDecodeTable;
    ofTable: FseDecodeTable;
    mlTable: FseDecodeTable;
    reps: [number, number, number];
  } | null;
}

function tryParseDictionaryEntropy(dictionary: Uint8Array): ZstdParsedDictionary['entropy'] & { contentStart: number } | null {
  try {
    let pos = DICTIONARY_HEADER_BYTES;
    const huffman = readHuffmanTable(dictionary, pos, dictionary.length);
    pos += huffman.bytesRead;
    const of = readFseNormalizedTable(dictionary, pos, dictionary.length, ZSTD_OF_MAX_CODE, ZSTD_OF_MAX_ACCURACY_LOG);
    pos += of.bytesRead;
    const ml = readFseNormalizedTable(dictionary, pos, dictionary.length, ZSTD_ML_MAX_CODE, ZSTD_ML_MAX_ACCURACY_LOG);
    pos += ml.bytesRead;
    const ll = readFseNormalizedTable(dictionary, pos, dictionary.length, ZSTD_LL_MAX_CODE, ZSTD_LL_MAX_ACCURACY_LOG);
    pos += ll.bytesRead;
    if (pos + DICTIONARY_REP_OFFSET_BYTES > dictionary.length) return null;
    const view = new DataView(dictionary.buffer, dictionary.byteOffset, dictionary.byteLength);
    const contentStart = pos + DICTIONARY_REP_OFFSET_BYTES;
    const contentLength = dictionary.length - contentStart;
    const reps: [number, number, number] = [
      view.getUint32(pos, true),
      view.getUint32(pos + 4, true),
      view.getUint32(pos + 8, true),
    ];
    // Repeat offsets must point into the content (RFC 8878 section 5).
    if (reps.some((rep) => rep === 0 || rep > contentLength)) return null;
    return {
      huffman: huffman.table,
      ofTable: buildFseDecodeTable(of.table.counts, of.table.maxSymbol, of.table.accuracyLog),
      mlTable: buildFseDecodeTable(ml.table.counts, ml.table.maxSymbol, ml.table.accuracyLog),
      llTable: buildFseDecodeTable(ll.table.counts, ll.table.maxSymbol, ll.table.accuracyLog),
      reps,
      contentStart,
    };
  } catch {
    return null;
  }
}

const parsedDictionaryCache = new WeakMap<Uint8Array, ZstdParsedDictionary>();

/**
 * Interprets a dictionary buffer: a full RFC 8878 section 5 dictionary (entropy tables, repeat
 * offsets, content), a content-only dictionary behind the 8-byte header, or raw content.
 * A magic-prefixed buffer whose entropy section does not parse is treated as content-only.
 */
export function parseZstdDictionary(dictionary: Uint8Array): ZstdParsedDictionary {
  const cached = parsedDictionaryCache.get(dictionary);
  if (cached !== undefined) return cached;
  let parsed: ZstdParsedDictionary;
  const magic =
    dictionary.length >= DICTIONARY_HEADER_BYTES
      ? new DataView(dictionary.buffer, dictionary.byteOffset, dictionary.byteLength).getUint32(0, true)
      : 0;
  if (magic === ZSTD_DICTIONARY_MAGIC || magic === ZSTD_DICTIONARY_MAGIC_LEGACY) {
    const id = new DataView(dictionary.buffer, dictionary.byteOffset, dictionary.byteLength).getUint32(4, true);
    const entropy = magic === ZSTD_DICTIONARY_MAGIC ? tryParseDictionaryEntropy(dictionary) : null;
    if (entropy === null) {
      parsed = { id, content: dictionary.subarray(DICTIONARY_HEADER_BYTES), entropy: null };
    } else {
      const { contentStart, ...tables } = entropy;
      parsed = { id, content: dictionary.subarray(contentStart), entropy: tables };
    }
  } else {
    parsed = { id: null, content: dictionary, entropy: null };
  }
  parsedDictionaryCache.set(dictionary, parsed);
  return parsed;
}

export interface ZstdFrameDecodeState {
  windowSize: number;
  /** Bytes of dictionary content that sit immediately before the frame's output and may be matched. */
  dictionaryLength: number;
  blockMaxSize: number;
  /** Declared Frame_Content_Size, or null when the frame does not state one. */
  contentSize: number | null;
  rep1: number;
  rep2: number;
  rep3: number;
  huffman: HuffmanDecodeTable | null;
  llTable: FseDecodeTable | null;
  mlTable: FseDecodeTable | null;
  ofTable: FseDecodeTable | null;
}

export function createFrameDecodeState(
  windowSize: number,
  contentSize: number | null = null,
  dictionary: ZstdParsedDictionary | null = null
): ZstdFrameDecodeState {
  const entropy = dictionary?.entropy ?? null;
  return {
    windowSize,
    dictionaryLength: dictionary === null ? 0 : dictionary.content.length,
    blockMaxSize: Math.min(windowSize, ZSTD_BLOCK_SIZE_MAX),
    contentSize,
    rep1: entropy === null ? ZSTD_REP_OFFSET_INITIAL[0] : entropy.reps[0],
    rep2: entropy === null ? ZSTD_REP_OFFSET_INITIAL[1] : entropy.reps[1],
    rep3: entropy === null ? ZSTD_REP_OFFSET_INITIAL[2] : entropy.reps[2],
    huffman: entropy === null ? null : entropy.huffman,
    llTable: entropy === null ? null : entropy.llTable,
    mlTable: entropy === null ? null : entropy.mlTable,
    ofTable: entropy === null ? null : entropy.ofTable,
  };
}

/** Smallest capacity step when the output has to grow without a size hint. */
const OUTPUT_MIN_GROWTH_BYTES = 256 * 1024;
/** Growth beyond the projected final size, as a numerator/denominator pair (12.5%). */
const OUTPUT_PROJECTION_SLACK_NUMERATOR = 9;
const OUTPUT_PROJECTION_SLACK_DENOMINATOR = 8;
const OUTPUT_GROWTH_FACTOR = 2;

/**
 * Output with explicit capacity control (no per-block concatenation). A declared content size is
 * reserved exactly; otherwise growth doubles, capped by a projection of the final size from the
 * input consumed so far so that a long stream does not end with a 2x oversized buffer.
 */
export class ZstdOutputBuffer {
  public data: Uint8Array = new Uint8Array(0);
  public length = 0;
  /** Projected total output size, refreshed by the caller; 0 when unknown. */
  public projectedTotal = 0;
  private readonly hardLimit: number;

  constructor(hardLimit: number) {
    this.hardLimit = hardLimit;
  }

  /** Reserves exactly `extra` more bytes when nothing has been written yet; otherwise grows normally. */
  public reserve(extra: number): void {
    if (this.length === 0 && extra > this.data.length) {
      if (extra > this.hardLimit) throw new DecompressionLimitError('Zstandard output exceeds the decoder size limit.');
      this.data = new Uint8Array(extra);
      return;
    }
    this.ensure(extra);
  }

  public ensure(extra: number): void {
    const needed = this.length + extra;
    if (needed <= this.data.length) return;
    if (needed > this.hardLimit) throw new DecompressionLimitError('Zstandard output exceeds the decoder size limit.');
    let capacity = Math.max(this.data.length * OUTPUT_GROWTH_FACTOR, OUTPUT_MIN_GROWTH_BYTES);
    if (this.projectedTotal > needed) {
      const projected = Math.ceil(
        (this.projectedTotal * OUTPUT_PROJECTION_SLACK_NUMERATOR) / OUTPUT_PROJECTION_SLACK_DENOMINATOR
      );
      capacity = Math.min(capacity, projected);
    }
    capacity = Math.min(Math.max(capacity, needed), this.hardLimit);
    const grown = new Uint8Array(capacity);
    grown.set(this.data.subarray(0, this.length));
    this.data = grown;
  }

  /**
   * The result as a Buffer. Capacity left over after an exact or well-projected reservation is
   * kept (at most 12.5%); anything larger is trimmed by copying.
   */
  public toBuffer(): Buffer {
    const waste = this.data.length - this.length;
    if (waste * OUTPUT_PROJECTION_SLACK_DENOMINATOR > this.length) {
      return Buffer.from(this.data.subarray(0, this.length));
    }
    return Buffer.from(this.data.buffer, this.data.byteOffset, this.length);
  }
}

let predefinedTables: { ll: FseDecodeTable; ml: FseDecodeTable; of: FseDecodeTable } | null = null;

function getPredefinedTables(): { ll: FseDecodeTable; ml: FseDecodeTable; of: FseDecodeTable } {
  if (predefinedTables === null) {
    predefinedTables = {
      ll: buildFseDecodeTable(ZSTD_LL_DEFAULT_DISTRIBUTION, ZSTD_LL_MAX_CODE, ZSTD_LL_DEFAULT_ACCURACY_LOG),
      ml: buildFseDecodeTable(ZSTD_ML_DEFAULT_DISTRIBUTION, ZSTD_ML_MAX_CODE, ZSTD_ML_DEFAULT_ACCURACY_LOG),
      of: buildFseDecodeTable(ZSTD_OF_DEFAULT_DISTRIBUTION, ZSTD_OF_DEFAULT_DISTRIBUTION.length - 1, ZSTD_OF_DEFAULT_ACCURACY_LOG),
    };
  }
  return predefinedTables;
}

function rleTable(symbol: number): FseDecodeTable {
  return {
    accuracyLog: 0,
    symbol: Uint8Array.of(symbol),
    nbBits: Uint8Array.of(0),
    base: Uint16Array.of(0),
  };
}

interface SymbolTableRead {
  table: FseDecodeTable;
  next: number;
}

function readSymbolTable(
  mode: number,
  src: Uint8Array,
  pos: number,
  end: number,
  predefined: FseDecodeTable,
  previous: FseDecodeTable | null,
  maxCode: number,
  maxAccuracyLog: number,
  fieldName: string
): SymbolTableRead {
  if (mode === MODE_PREDEFINED) return { table: predefined, next: pos };
  if (mode === MODE_RLE) {
    if (pos >= end) zstdFail(`Malformed Zstandard sequences: truncated ${fieldName} RLE symbol.`);
    const symbol = src[pos];
    if (symbol > maxCode) zstdFail(`Malformed Zstandard sequences: ${fieldName} RLE symbol out of range.`);
    return { table: rleTable(symbol), next: pos + 1 };
  }
  if (mode === MODE_REPEAT) {
    if (previous === null) zstdFail(`Malformed Zstandard sequences: ${fieldName} repeat mode without a previous table.`);
    return { table: previous, next: pos };
  }
  const parsed = readFseNormalizedTable(src, pos, end, maxCode, maxAccuracyLog);
  return {
    table: buildFseDecodeTable(parsed.table.counts, parsed.table.maxSymbol, parsed.table.accuracyLog),
    next: pos + parsed.bytesRead,
  };
}

interface LiteralsSection {
  literals: Uint8Array;
  next: number;
}

function readLiteralsSection(src: Uint8Array, start: number, end: number, state: ZstdFrameDecodeState): LiteralsSection {
  if (start >= end) zstdFail('Malformed Zstandard block: missing literals section.');
  const first = src[start];
  const type = first & LITERAL_HEADER_TYPE_MASK;
  const sizeFormat = (first >> LITERAL_HEADER_FORMAT_SHIFT) & LITERAL_HEADER_FORMAT_MASK;
  let pos = start;
  let regenerated: number;
  if (type === LITERALS_RAW || type === LITERALS_RLE) {
    if (sizeFormat === SIZE_FORMAT_ONE_BYTE || sizeFormat === SIZE_FORMAT_ONE_BYTE_ALT) {
      regenerated = first >> LITERAL_SIZE_ONE_BYTE_SHIFT;
      pos += RAW_HEADER_BYTES_ONE;
    } else if (sizeFormat === SIZE_FORMAT_TWO_BYTES) {
      if (pos + RAW_HEADER_BYTES_TWO > end) zstdFail('Malformed Zstandard literals: truncated header.');
      regenerated = (first >> LITERAL_HEADER_SIZE_SHIFT) + src[pos + 1] * LITERAL_SIZE_SECOND_BYTE_SCALE;
      pos += RAW_HEADER_BYTES_TWO;
    } else {
      if (pos + RAW_HEADER_BYTES_THREE > end) zstdFail('Malformed Zstandard literals: truncated header.');
      regenerated =
        (first >> LITERAL_HEADER_SIZE_SHIFT) +
        src[pos + 1] * LITERAL_SIZE_SECOND_BYTE_SCALE +
        src[pos + 2] * LITERAL_SIZE_THIRD_BYTE_SCALE;
      pos += RAW_HEADER_BYTES_THREE;
    }
    if (regenerated > state.blockMaxSize) zstdFail('Malformed Zstandard literals: size exceeds block maximum.');
    if (type === LITERALS_RAW) {
      if (pos + regenerated > end) zstdFail('Malformed Zstandard literals: raw data out of bounds.');
      return { literals: src.subarray(pos, pos + regenerated), next: pos + regenerated };
    }
    if (pos >= end) zstdFail('Malformed Zstandard literals: missing RLE byte.');
    return { literals: new Uint8Array(regenerated).fill(src[pos]), next: pos + 1 };
  }
  const headerBytes = COMPRESSED_LITERALS_HEADER_BYTES[sizeFormat];
  const sizeBits = COMPRESSED_LITERALS_SIZE_BITS[sizeFormat];
  if (pos + headerBytes > end) zstdFail('Malformed Zstandard literals: truncated header.');
  let header = 0;
  let scale = 1;
  for (let i = 0; i < headerBytes; i++) {
    header += src[pos + i] * scale;
    scale *= BYTE_RADIX;
  }
  const afterType = Math.floor(header / LITERAL_HEADER_TYPE_FORMAT_RADIX);
  const sizeRadix = 2 ** sizeBits;
  regenerated = afterType % sizeRadix;
  const compressed = Math.floor(afterType / sizeRadix);
  pos += headerBytes;
  if (regenerated > state.blockMaxSize) zstdFail('Malformed Zstandard literals: size exceeds block maximum.');
  if (pos + compressed > end) zstdFail('Malformed Zstandard literals: compressed data out of bounds.');
  const payloadEnd = pos + compressed;
  let table: HuffmanDecodeTable;
  let streamStart = pos;
  if (type === LITERALS_COMPRESSED) {
    const parsed = readHuffmanTable(src, pos, payloadEnd);
    table = parsed.table;
    state.huffman = table;
    streamStart += parsed.bytesRead;
  } else {
    if (state.huffman === null) zstdFail('Malformed Zstandard literals: treeless block without a previous Huffman table.');
    table = state.huffman;
  }
  const out = new Uint8Array(regenerated);
  if (regenerated === 0) zstdFail('Malformed Zstandard literals: compressed literals with zero size.');
  decodeHuffmanLiterals(table, src, streamStart, payloadEnd, out, regenerated, sizeFormat !== 0);
  return { literals: out, next: payloadEnd };
}

/**
 * Typed copies of the code tables, read in the sequence loop. Module-local constants avoid an accessor call per use when the
 * imported bindings are compiled to getters (CommonJS interop), and typed arrays are cheaper to index than plain ones.
 */
const LL_BASELINE_TABLE = Uint32Array.from(LL_BASELINE);
const LL_BITS_TABLE = Uint8Array.from(LL_BITS);
const ML_BASELINE_TABLE = Uint32Array.from(ML_BASELINE);
const ML_BITS_TABLE = Uint8Array.from(ML_BITS);

/** Widest field the single 32-bit window read below can return (the window holds 25 usable bits at any shift). */
const WINDOW_FIELD_BITS_MAX = 24;
const OFFSET_EXTRA_BITS_SPLIT = 24;
const OFFSET_EXTRA_BITS_RADIX = 2 ** OFFSET_EXTRA_BITS_SPLIT;

/**
 * Bits [pos, pos + n) of the backward stream that starts at src[base], n <= 24, bits below position 0 reading as zero.
 * Equivalent to ReverseBitReader's field read; inlined by the JIT into the sequence loop. Bytes past the end of the
 * stream can enter the 32-bit window only above bit pos + n, which the mask drops.
 */
function streamBits(src: Uint8Array, base: number, pos: number, n: number): number {
  const at = base + (pos >> 3);
  if (pos >= 0 && at + 3 < src.length) {
    return ((src[at] | (src[at + 1] << 8) | (src[at + 2] << 16) | (src[at + 3] << 24)) >>> (pos & 7)) & ((1 << n) - 1);
  }
  let word = 0;
  for (let k = 0; k < 4; k++) {
    const index = at + k;
    const byte = pos >= 0 || index >= base ? (index < src.length ? src[index] : 0) : 0;
    word |= byte << (8 * k);
  }
  return (word >>> (pos & 7)) & ((1 << n) - 1);
}

/**
 * Decodes one compressed block (src[start..end)) and appends its output to `out`.
 * `frameStart` is the output offset where the current frame began; offsets are validated against it.
 */
export function decodeCompressedBlock(
  src: Uint8Array,
  start: number,
  end: number,
  out: ZstdOutputBuffer,
  frameStart: number,
  state: ZstdFrameDecodeState
): void {
  const { literals, next } = readLiteralsSection(src, start, end, state);
  let pos = next;
  const blockStart = out.length;
  // A declared content size caps what the rest of the frame may produce, so a block never reserves more.
  const declaredRemaining = state.contentSize === null ? Infinity : state.contentSize - (blockStart - frameStart);
  const budget = Math.min(state.blockMaxSize, declaredRemaining);
  if (budget < 0) zstdFail('Corrupt Zstandard block: output exceeds the declared content size.');
  out.ensure(budget);

  if (pos >= end) zstdFail('Malformed Zstandard block: missing sequences section.');
  let numSeq = src[pos++];
  if (numSeq >= SEQ_COUNT_TWO_BYTE_BASE) {
    if (numSeq < SEQ_COUNT_THREE_BYTE_MARKER) {
      if (pos >= end) zstdFail('Malformed Zstandard sequences: truncated count.');
      numSeq = ((numSeq - SEQ_COUNT_TWO_BYTE_BASE) << 8) + src[pos++];
    } else {
      if (pos + 2 > end) zstdFail('Malformed Zstandard sequences: truncated count.');
      numSeq = src[pos] + (src[pos + 1] << 8) + SEQ_COUNT_THREE_BYTE_BASE;
      pos += 2;
    }
  }

  if (numSeq === 0) {
    if (pos !== end) zstdFail('Malformed Zstandard block: trailing data after empty sequences section.');
    if (literals.length > budget) zstdFail('Corrupt Zstandard block: output exceeds the declared content size.');
    out.data.set(literals, out.length);
    out.length += literals.length;
    return;
  }

  if (pos >= end) zstdFail('Malformed Zstandard sequences: missing compression modes.');
  const modes = src[pos++];
  if ((modes & SEQ_RESERVED_MODE_MASK) !== 0) zstdFail('Malformed Zstandard sequences: reserved bits set in modes byte.');
  const predefined = getPredefinedTables();
  const llRead = readSymbolTable((modes >> LL_MODE_SHIFT) & MODE_FIELD_MASK, src, pos, end, predefined.ll, state.llTable, ZSTD_LL_MAX_CODE, ZSTD_LL_MAX_ACCURACY_LOG, 'literal-length');
  const ofRead = readSymbolTable((modes >> OF_MODE_SHIFT) & MODE_FIELD_MASK, src, llRead.next, end, predefined.of, state.ofTable, ZSTD_OF_MAX_CODE, ZSTD_OF_MAX_ACCURACY_LOG, 'offset');
  const mlRead = readSymbolTable((modes >> ML_MODE_SHIFT) & MODE_FIELD_MASK, src, ofRead.next, end, predefined.ml, state.mlTable, ZSTD_ML_MAX_CODE, ZSTD_ML_MAX_ACCURACY_LOG, 'match-length');
  const llTable = llRead.table;
  const ofTable = ofRead.table;
  const mlTable = mlRead.table;
  state.llTable = llTable;
  state.ofTable = ofTable;
  state.mlTable = mlTable;
  pos = mlRead.next;

  const reader = new ReverseBitReader(src, pos, end);
  const streamBase = pos;
  let llState = reader.read(llTable.accuracyLog);
  let ofState = reader.read(ofTable.accuracyLog);
  let mlState = reader.read(mlTable.accuracyLog);
  let bitsLeft = reader.bitsLeft;

  const data = out.data;
  const dataLength = data.length;
  const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const literalView = new DataView(literals.buffer, literals.byteOffset, literals.byteLength);
  let outLen = out.length;
  let litPos = 0;
  let rep1 = state.rep1;
  let rep2 = state.rep2;
  let rep3 = state.rep3;
  // With a dictionary, matches may reach back into its content on top of the declared window.
  const windowLimit = state.windowSize + state.dictionaryLength;
  const availableHistoryBase = frameStart - state.dictionaryLength;
  const litTotal = literals.length;
  const llSymbol = llTable.symbol;
  const llNbBits = llTable.nbBits;
  const llBase = llTable.base;
  const mlSymbol = mlTable.symbol;
  const mlNbBits = mlTable.nbBits;
  const mlBase = mlTable.base;
  const ofSymbol = ofTable.symbol;
  const ofNbBits = ofTable.nbBits;
  const ofBase = ofTable.base;
  const lastSequence = numSeq - 1;

  for (let i = 0; i < numSeq; i++) {
    const ofCode = ofSymbol[ofState];
    const mlCode = mlSymbol[mlState];
    const llCode = llSymbol[llState];
    // Extra bits are read offset first, then match length, then literal length (RFC 8878 section 3.1.1.4).
    let ofValue: number;
    if (ofCode === 0) {
      ofValue = 1;
    } else if (ofCode <= WINDOW_FIELD_BITS_MAX) {
      bitsLeft -= ofCode;
      ofValue = (1 << ofCode) + streamBits(src, streamBase, bitsLeft, ofCode);
    } else {
      bitsLeft -= ofCode;
      const low = streamBits(src, streamBase, bitsLeft, OFFSET_EXTRA_BITS_SPLIT);
      const high = streamBits(src, streamBase, bitsLeft + OFFSET_EXTRA_BITS_SPLIT, ofCode - OFFSET_EXTRA_BITS_SPLIT);
      ofValue = 2 ** ofCode + high * OFFSET_EXTRA_BITS_RADIX + low;
    }
    const mlBits = ML_BITS_TABLE[mlCode];
    let matchLen = ML_BASELINE_TABLE[mlCode];
    if (mlBits > 0) {
      bitsLeft -= mlBits;
      matchLen += streamBits(src, streamBase, bitsLeft, mlBits);
    }
    const llBits = LL_BITS_TABLE[llCode];
    let litLen = LL_BASELINE_TABLE[llCode];
    if (llBits > 0) {
      bitsLeft -= llBits;
      litLen += streamBits(src, streamBase, bitsLeft, llBits);
    }

    let offset: number;
    if (ofValue > 3) {
      offset = ofValue - 3;
      rep3 = rep2;
      rep2 = rep1;
      rep1 = offset;
    } else {
      const index = ofValue - 1 + (litLen === 0 ? 1 : 0);
      if (index === 0) {
        offset = rep1;
      } else if (index === 1) {
        offset = rep2;
        rep2 = rep1;
        rep1 = offset;
      } else if (index === 2) {
        offset = rep3;
        rep3 = rep2;
        rep2 = rep1;
        rep1 = offset;
      } else {
        offset = rep1 - 1;
        rep3 = rep2;
        rep2 = rep1;
        rep1 = offset;
      }
    }
    if (offset <= 0) zstdFail('Corrupt Zstandard sequence: invalid offset 0.');

    if (i < lastSequence) {
      const llUpdateBits = llNbBits[llState];
      bitsLeft -= llUpdateBits;
      llState = llBase[llState] + (llUpdateBits > 0 ? streamBits(src, streamBase, bitsLeft, llUpdateBits) : 0);
      const mlUpdateBits = mlNbBits[mlState];
      bitsLeft -= mlUpdateBits;
      mlState = mlBase[mlState] + (mlUpdateBits > 0 ? streamBits(src, streamBase, bitsLeft, mlUpdateBits) : 0);
      const ofUpdateBits = ofNbBits[ofState];
      bitsLeft -= ofUpdateBits;
      ofState = ofBase[ofState] + (ofUpdateBits > 0 ? streamBits(src, streamBase, bitsLeft, ofUpdateBits) : 0);
    }
    if (bitsLeft < 0) zstdFail('Malformed Zstandard sequences: bitstream over-read.');

    if (outLen - blockStart + litLen + matchLen > budget) {
      zstdFail('Corrupt Zstandard block: decoded size exceeds the block maximum or declared content size.');
    }
    if (litPos + litLen > litTotal) zstdFail('Corrupt Zstandard sequence: literal length exceeds available literals.');
    if (litLen < SHORT_COPY_LIMIT) {
      if (litPos + litLen + WORD_BYTES <= litTotal && outLen + litLen + WORD_BYTES <= dataLength) {
        // Whole words: the bytes written past the run are overwritten by what follows.
        for (let k = 0; k < litLen; k += WORD_BYTES) dataView.setUint32(outLen + k, literalView.getUint32(litPos + k, true), true);
      } else {
        for (let k = 0; k < litLen; k++) data[outLen + k] = literals[litPos + k];
      }
    } else {
      data.set(literals.subarray(litPos, litPos + litLen), outLen);
    }
    litPos += litLen;
    outLen += litLen;

    if (offset > outLen - availableHistoryBase || offset > windowLimit) {
      zstdFail(`Corrupt Zstandard sequence: offset ${offset} exceeds the available window.`);
    }
    const from = outLen - offset;
    if (offset >= matchLen && matchLen >= LONG_COPY_LIMIT) {
      data.copyWithin(outLen, from, from + matchLen);
    } else if (offset >= WORD_BYTES && outLen + matchLen + WORD_BYTES <= dataLength) {
      // A chunk of four bytes reads only bytes that are final once the chunk before it is written, also when the match
      // overlaps itself; the bytes written past the match are overwritten by what follows.
      for (let k = 0; k < matchLen; k += WORD_BYTES) dataView.setUint32(outLen + k, dataView.getUint32(from + k, true), true);
    } else {
      for (let k = 0; k < matchLen; k++) data[outLen + k] = data[from + k];
    }
    outLen += matchLen;
  }
  if (bitsLeft !== 0) zstdFail('Malformed Zstandard sequences: bitstream not fully consumed.');

  const trailing = litTotal - litPos;
  if (outLen - blockStart + trailing > budget) {
    zstdFail('Corrupt Zstandard block: decoded size exceeds the block maximum or declared content size.');
  }
  data.set(literals.subarray(litPos), outLen);
  outLen += trailing;
  out.length = outLen;
  state.rep1 = rep1;
  state.rep2 = rep2;
  state.rep3 = rep3;
}

/**
 * Decodes one compressed block against explicit history: the dictionary content followed by the
 * given earlier blocks. Used by chunked callers that frame blocks themselves. Bounded by the
 * block maximum like every other block.
 */
export function decodeBlockWithHistory(
  payload: Uint8Array,
  dictionary: ZstdParsedDictionary | null,
  previousBlocks: readonly Uint8Array[]
): Buffer {
  if (payload.length === 0) return Buffer.alloc(0);
  let historyLength = dictionary === null ? 0 : dictionary.content.length;
  for (const block of previousBlocks) historyLength += block.length;
  const out = new ZstdOutputBuffer(historyLength + ZSTD_BLOCK_SIZE_MAX);
  out.reserve(historyLength + ZSTD_BLOCK_SIZE_MAX);
  let cursor = 0;
  if (dictionary !== null) {
    out.data.set(dictionary.content, cursor);
    cursor += dictionary.content.length;
  }
  for (const block of previousBlocks) {
    out.data.set(block, cursor);
    cursor += block.length;
  }
  out.length = historyLength;
  const state = createFrameDecodeState(ZSTD_DECODER_WINDOW_SIZE_MAX, null, dictionary);
  state.dictionaryLength = historyLength;
  decodeCompressedBlock(payload, 0, payload.length, out, historyLength, state);
  return Buffer.from(out.data.subarray(historyLength, out.length));
}
