import {
  ReverseBitReader,
  buildFseDecodeTable,
  readFseNormalizedTable,
  zstdFail,
  type FseDecodeTable,
} from './zstd-fse';
import { decodeHuffmanLiterals, readHuffmanTable, type HuffmanDecodeTable } from './zstd-huffman';
import {
  LL_BASELINE,
  LL_BITS,
  ML_BASELINE,
  ML_BITS,
  ZSTD_BLOCK_SIZE_MAX,
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

export interface ZstdFrameDecodeState {
  windowSize: number;
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

export function createFrameDecodeState(windowSize: number, contentSize: number | null = null): ZstdFrameDecodeState {
  return {
    windowSize,
    blockMaxSize: Math.min(windowSize, ZSTD_BLOCK_SIZE_MAX),
    contentSize,
    rep1: ZSTD_REP_OFFSET_INITIAL[0],
    rep2: ZSTD_REP_OFFSET_INITIAL[1],
    rep3: ZSTD_REP_OFFSET_INITIAL[2],
    huffman: null,
    llTable: null,
    mlTable: null,
    ofTable: null,
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
      if (extra > this.hardLimit) zstdFail('Zstandard output exceeds the decoder size limit.');
      this.data = new Uint8Array(extra);
      return;
    }
    this.ensure(extra);
  }

  public ensure(extra: number): void {
    const needed = this.length + extra;
    if (needed <= this.data.length) return;
    if (needed > this.hardLimit) zstdFail('Zstandard output exceeds the decoder size limit.');
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
  let llState = reader.read(llTable.accuracyLog);
  let ofState = reader.read(ofTable.accuracyLog);
  let mlState = reader.read(mlTable.accuracyLog);

  const data = out.data;
  let outLen = out.length;
  let litPos = 0;
  let rep1 = state.rep1;
  let rep2 = state.rep2;
  let rep3 = state.rep3;
  const windowLimit = state.windowSize;
  const litTotal = literals.length;

  for (let i = 0; i < numSeq; i++) {
    const ofCode = ofTable.symbol[ofState];
    const mlCode = mlTable.symbol[mlState];
    const llCode = llTable.symbol[llState];
    const ofValue = 2 ** ofCode + reader.read(ofCode);
    const matchLen = ML_BASELINE[mlCode] + reader.read(ML_BITS[mlCode]);
    const litLen = LL_BASELINE[llCode] + reader.read(LL_BITS[llCode]);

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

    if (i < numSeq - 1) {
      llState = llTable.base[llState] + reader.read(llTable.nbBits[llState]);
      mlState = mlTable.base[mlState] + reader.read(mlTable.nbBits[mlState]);
      ofState = ofTable.base[ofState] + reader.read(ofTable.nbBits[ofState]);
    }
    if (reader.overflowed) zstdFail('Malformed Zstandard sequences: bitstream over-read.');

    if (outLen - blockStart + litLen + matchLen > budget) {
      zstdFail('Corrupt Zstandard block: decoded size exceeds the block maximum or declared content size.');
    }
    if (litPos + litLen > litTotal) zstdFail('Corrupt Zstandard sequence: literal length exceeds available literals.');
    if (litLen < SHORT_COPY_LIMIT) {
      for (let k = 0; k < litLen; k++) data[outLen + k] = literals[litPos + k];
    } else {
      data.set(literals.subarray(litPos, litPos + litLen), outLen);
    }
    litPos += litLen;
    outLen += litLen;

    if (offset > outLen - frameStart || offset > windowLimit) {
      zstdFail(`Corrupt Zstandard sequence: offset ${offset} exceeds the available window.`);
    }
    const from = outLen - offset;
    if (offset >= matchLen && matchLen >= SHORT_COPY_LIMIT) {
      data.copyWithin(outLen, from, from + matchLen);
    } else {
      for (let k = 0; k < matchLen; k++) data[outLen + k] = data[from + k];
    }
    outLen += matchLen;
  }
  if (reader.bitsLeft !== 0) zstdFail('Malformed Zstandard sequences: bitstream not fully consumed.');

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
