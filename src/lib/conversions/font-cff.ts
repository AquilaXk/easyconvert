import { ConversionFailedError } from '../types';

/**
 * Compact Font Format (CFF 1) reader and Type 2 charstring interpreter.
 *
 * Implements the Adobe Technical Notes #5176 (CFF) and #5177 (Type 2 charstrings): header, Name /
 * Top DICT / String / Global Subr INDEXes, CharStrings INDEX, charset, Private DICTs with local
 * subroutines, and CID-keyed fonts (ROS, FDArray, FDSelect formats 0 and 3 with a Private DICT
 * and local subroutines per font DICT). Charstrings are interpreted into cubic outlines.
 *
 * Every structural problem and every exceeded limit throws a typed error; there is no clipped or
 * placeholder output. This module does not depend on the rest of the font engine.
 */

/** The CFF structure is malformed or uses an unsupported feature. */
export class CffFormatError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'CffFormatError';
  }
}

/** A Type 2 charstring is malformed or exceeds an execution limit. */
export class CffCharStringError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'CffCharStringError';
  }
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Type 2 argument stack depth. */
export const CFF_MAX_STACK_DEPTH = 48;
/** Maximum nesting of callsubr / callgsubr. */
export const CFF_MAX_SUBR_DEPTH = 10;
/** Interpreter steps (operators and operands) allowed for one glyph. */
export const CFF_MAX_STEPS_PER_GLYPH = 200_000;
/*
 * Per-font budgets. A real charstring spends at least one byte per interpreter step and per path
 * segment, and subroutine reuse multiplies that by a small factor only, so the font-wide budgets
 * grow with the table size on top of a fixed floor for small fonts. A subroutine tree that expands
 * far beyond what its table size can justify is rejected long before it costs real CPU or memory.
 */
/** Interpreter steps (operators and operands) allowed across all glyphs, before the per-byte share. */
export const CFF_BASE_STEPS_PER_FONT = 2_000_000;
/** Extra interpreter steps allowed per byte of CFF table. */
export const CFF_STEPS_PER_TABLE_BYTE = 4;
/** Path segments allowed across all glyphs, before the per-byte share. */
export const CFF_BASE_SEGMENTS_PER_FONT = 250_000;
/** Extra path segments allowed per byte of CFF table. */
export const CFF_SEGMENTS_PER_TABLE_BYTE = 2;
/** Path segments allowed in one glyph before it is rejected. */
export const CFF_MAX_SEGMENTS_PER_GLYPH = 32_767;
/** Largest CFF table accepted. */
export const CFF_MAX_TABLE_BYTES = 64 * 1024 * 1024;

const MAX_DICT_OPERANDS = 48;
const MAX_FONT_DICTS = 256;
const MAX_GLYPHS = 0xffff;
const TRANSIENT_ARRAY_SIZE = 32;

const SUPPORTED_MAJOR_VERSION = 1;
const HEADER_MIN_BYTES = 4;
const INDEX_COUNT_BYTES = 2;
const INDEX_MIN_OFFSET_SIZE = 1;
const INDEX_MAX_OFFSET_SIZE = 4;
const SUBR_BIAS_SMALL = 107;
const SUBR_BIAS_MEDIUM = 1131;
const SUBR_BIAS_LARGE = 32768;
const SUBR_COUNT_SMALL_LIMIT = 1240;
const SUBR_COUNT_MEDIUM_LIMIT = 33900;
const FIXED_16_16_DIVISOR = 65536;
const BYTE_RANGE = 256;
// Operand encodings shared by DICT data and charstrings (CFF spec table 3 and Type 2 table 1).
const OPERAND_INT16 = 28;
const OPERAND_ONE_BYTE_FIRST = 32;
const OPERAND_ONE_BYTE_LAST = 246;
const OPERAND_ONE_BYTE_BIAS = 139;
const OPERAND_POSITIVE_FIRST = 247;
const OPERAND_POSITIVE_LAST = 250;
const OPERAND_NEGATIVE_FIRST = 251;
const OPERAND_NEGATIVE_LAST = 254;
const OPERAND_TWO_BYTE_BIAS = 108;
const DICT_OPERAND_INT32 = 29;
const DICT_OPERAND_REAL = 30;
const DICT_LAST_OPERATOR = 21;
const BITS_PER_BYTE = 8;
const NIBBLE_BITS = 4;
const NIBBLE_MASK = 0x0f;
const REAL_NIBBLE_MAX_DIGIT = 9;
const UINT16_MAX = 0xffff;
const UINT16_BYTES = 2;
const ISO_ADOBE_LAST_SID = 228;
// FDSelect format 3 is a u8 format, a u16 range count, then (first u16, fd u8) ranges and a u16 sentinel.
const FDSELECT_FORMAT_RANGES = 3;
const FDSELECT_HEADER_BYTES = 3;
const FDSELECT_RANGE_BYTES = 3;
const CHARSTRING_TYPE_2 = 2;

// ---------------------------------------------------------------------------
// DICT operators (two-byte operators are 1200 + second byte)
// ---------------------------------------------------------------------------

const DICT_ESCAPE = 12;
const DICT_ESCAPE_BASE = 1200;
const OP_CHARSET = 15;
const OP_CHARSTRINGS = 17;
const OP_PRIVATE = 18;
const OP_SUBRS = 19;
const OP_DEFAULT_WIDTH_X = 20;
const OP_NOMINAL_WIDTH_X = 21;
const OP_CHARSTRING_TYPE = DICT_ESCAPE_BASE + 6;
const OP_FONT_MATRIX = DICT_ESCAPE_BASE + 7;
const OP_ROS = DICT_ESCAPE_BASE + 30;
const OP_FD_ARRAY = DICT_ESCAPE_BASE + 36;
const OP_FD_SELECT = DICT_ESCAPE_BASE + 37;
const FONT_MATRIX_OPERANDS = 6;

// ---------------------------------------------------------------------------
// Type 2 charstring operators
// ---------------------------------------------------------------------------

const CS_HSTEM = 1;
const CS_VSTEM = 3;
const CS_VMOVETO = 4;
const CS_RLINETO = 5;
const CS_HLINETO = 6;
const CS_VLINETO = 7;
const CS_RRCURVETO = 8;
const CS_CALLSUBR = 10;
const CS_RETURN = 11;
const CS_ESCAPE = 12;
const CS_ENDCHAR = 14;
const CS_HSTEMHM = 18;
const CS_HINTMASK = 19;
const CS_CNTRMASK = 20;
const CS_RMOVETO = 21;
const CS_HMOVETO = 22;
const CS_VSTEMHM = 23;
const CS_RCURVELINE = 24;
const CS_RLINECURVE = 25;
const CS_VVCURVETO = 26;
const CS_HHCURVETO = 27;
const CS_CALLGSUBR = 29;
const CS_VHCURVETO = 30;
const CS_HVCURVETO = 31;

const CS_ESC_DOTSECTION = 0;
const CS_ESC_AND = 3;
const CS_ESC_OR = 4;
const CS_ESC_NOT = 5;
const CS_ESC_ABS = 9;
const CS_ESC_ADD = 10;
const CS_ESC_SUB = 11;
const CS_ESC_DIV = 12;
const CS_ESC_NEG = 14;
const CS_ESC_EQ = 15;
const CS_ESC_DROP = 18;
const CS_ESC_PUT = 20;
const CS_ESC_GET = 21;
const CS_ESC_IFELSE = 22;
const CS_ESC_RANDOM = 23;
const CS_ESC_MUL = 24;
const CS_ESC_SQRT = 26;
const CS_ESC_DUP = 27;
const CS_ESC_EXCH = 28;
const CS_ESC_INDEX = 29;
const CS_ESC_ROLL = 30;
const CS_ESC_HFLEX = 34;
const CS_ESC_FLEX = 35;
const CS_ESC_HFLEX1 = 36;
const CS_ESC_FLEX1 = 37;

const SEAC_ARGUMENTS = 4;
const ARGS_PER_LINE = 2;
const ARGS_PER_CURVE = 6;
const ARGS_PER_COMPACT_CURVE = 4;
const MIN_ARGS_CURVE_LINE = ARGS_PER_CURVE + ARGS_PER_LINE;
const FLEX_ARGS = 13;
const HFLEX_ARGS = 7;
const HFLEX1_ARGS = 9;
const FLEX1_ARGS = 11;
const STEM_ARGS = 2;
const SEAC_CHAR_CODE_LIMIT = BYTE_RANGE;

/**
 * Standard SIDs of the glyphs StandardEncoding assigns to codes 161-251 (CFF Appendix B).
 * Codes 32-126 map to SID = code - 31. Zero means the code is unassigned.
 */
const STANDARD_ENCODING_HIGH_SIDS: ReadonlyMap<number, number> = new Map<number, number>([
  [161, 96], [162, 97], [163, 98], [164, 99], [165, 100], [166, 101], [167, 102], [168, 103],
  [169, 104], [170, 105], [171, 106], [172, 107], [173, 108], [174, 109], [175, 110],
  [177, 111], [178, 112], [179, 113], [180, 114],
  [182, 115], [183, 116], [184, 117], [185, 118], [186, 119], [187, 120], [188, 121], [189, 122],
  [191, 123],
  [193, 124], [194, 125], [195, 126], [196, 127], [197, 128], [198, 129], [199, 130], [200, 131],
  [202, 132], [203, 133],
  [205, 134], [206, 135], [207, 136], [208, 137],
  [225, 138], [227, 139],
  [232, 140], [233, 141], [234, 142], [235, 143],
  [241, 144], [245, 145],
  [248, 146], [249, 147], [250, 148], [251, 149],
]);
const STANDARD_ASCII_FIRST = 32;
const STANDARD_ASCII_LAST = 126;
const STANDARD_ASCII_SID_OFFSET = 31;

// ---------------------------------------------------------------------------
// Public data model
// ---------------------------------------------------------------------------

export interface CffPoint {
  x: number;
  y: number;
}

export type CffSegment =
  | { kind: 'line'; to: CffPoint }
  | { kind: 'curve'; c1: CffPoint; c2: CffPoint; to: CffPoint };

/** One closed subpath: a start point followed by lines and cubic Bézier curves. */
export interface CffContour {
  start: CffPoint;
  segments: CffSegment[];
}

/** Affine matrix [a b c d tx ty] with x' = a*x + c*y + tx and y' = b*x + d*y + ty. */
export type CffMatrix = readonly [number, number, number, number, number, number];

export interface CffGlyph {
  glyphId: number;
  /** Advance width declared by the charstring (nominalWidthX + delta, or defaultWidthX). */
  width: number;
  contours: CffContour[];
  /** FontMatrix in effect for this glyph, or null when the font declares none. */
  matrix: CffMatrix | null;
}

// ---------------------------------------------------------------------------
// INDEX and DICT readers
// ---------------------------------------------------------------------------

interface CffIndex {
  count: number;
  offSize: number;
  offsetArrayStart: number;
  /** Position of the byte before the first object; offsets are relative to it. */
  dataBase: number;
  /** Position just past the INDEX. */
  end: number;
}

interface Range {
  start: number;
  end: number;
}

function readUIntBE(data: Buffer, pos: number, size: number, what: string): number {
  if (pos < 0 || pos + size > data.length) {
    throw new CffFormatError(`CFF ${what} is cut short at byte ${pos}.`);
  }
  return data.readUIntBE(pos, size);
}

function readIndex(data: Buffer, pos: number, what: string): CffIndex {
  const count = readUIntBE(data, pos, INDEX_COUNT_BYTES, `${what} INDEX count`);
  if (count === 0) {
    return { count: 0, offSize: 0, offsetArrayStart: pos, dataBase: pos, end: pos + INDEX_COUNT_BYTES };
  }
  const offSize = readUIntBE(data, pos + INDEX_COUNT_BYTES, 1, `${what} INDEX offSize`);
  if (offSize < INDEX_MIN_OFFSET_SIZE || offSize > INDEX_MAX_OFFSET_SIZE) {
    throw new CffFormatError(`CFF ${what} INDEX has offSize ${offSize}; it must be 1 to 4.`);
  }
  const offsetArrayStart = pos + INDEX_COUNT_BYTES + 1;
  const offsetArrayBytes = (count + 1) * offSize;
  if (offsetArrayStart + offsetArrayBytes > data.length) {
    throw new CffFormatError(`CFF ${what} INDEX offset array runs past the end of the table.`);
  }
  const dataBase = offsetArrayStart + offsetArrayBytes - 1;
  let previous = readUIntBE(data, offsetArrayStart, offSize, `${what} INDEX offset`);
  if (previous !== 1) {
    throw new CffFormatError(`CFF ${what} INDEX first offset is ${previous}; it must be 1.`);
  }
  for (let i = 1; i <= count; i++) {
    const offset = readUIntBE(data, offsetArrayStart + i * offSize, offSize, `${what} INDEX offset`);
    if (offset < previous) {
      throw new CffFormatError(`CFF ${what} INDEX offsets are not monotonic at entry ${i}.`);
    }
    previous = offset;
  }
  const end = dataBase + previous;
  if (end > data.length) {
    throw new CffFormatError(`CFF ${what} INDEX data runs past the end of the table.`);
  }
  return { count, offSize, offsetArrayStart, dataBase, end };
}

function indexEntry(data: Buffer, index: CffIndex, i: number): Range {
  const start = index.dataBase + data.readUIntBE(index.offsetArrayStart + i * index.offSize, index.offSize);
  const end = index.dataBase + data.readUIntBE(index.offsetArrayStart + (i + 1) * index.offSize, index.offSize);
  return { start, end };
}

/**
 * Decodes the operand forms DICT data and charstrings have in common: 16-bit integers (28) and the
 * one- and two-byte integers (32-254). Returns null when `b0` starts neither form.
 */
function decodeSharedOperand(
  data: Buffer,
  b0: number,
  pos: number,
  end: number,
  fail: (message: string) => Error
): { value: number; next: number } | null {
  if (b0 === OPERAND_INT16) {
    if (pos + 2 > end) throw fail('ends inside a 16-bit operand.');
    return { value: data.readInt16BE(pos), next: pos + 2 };
  }
  if (b0 >= OPERAND_ONE_BYTE_FIRST && b0 <= OPERAND_ONE_BYTE_LAST) {
    return { value: b0 - OPERAND_ONE_BYTE_BIAS, next: pos };
  }
  if (b0 >= OPERAND_POSITIVE_FIRST && b0 <= OPERAND_NEGATIVE_LAST) {
    if (pos + 1 > end) throw fail('ends inside a two-byte operand.');
    const low = data[pos];
    if (b0 <= OPERAND_POSITIVE_LAST) {
      return { value: (b0 - OPERAND_POSITIVE_FIRST) * BYTE_RANGE + low + OPERAND_TWO_BYTE_BIAS, next: pos + 1 };
    }
    return { value: -(b0 - OPERAND_NEGATIVE_FIRST) * BYTE_RANGE - low - OPERAND_TWO_BYTE_BIAS, next: pos + 1 };
  }
  return null;
}

type DictMap = Map<number, number[]>;

const REAL_NIBBLE_DECIMAL = 0xa;
const REAL_NIBBLE_EXPONENT = 0xb;
const REAL_NIBBLE_NEGATIVE_EXPONENT = 0xc;
const REAL_NIBBLE_MINUS = 0xe;
const REAL_NIBBLE_END = 0xf;

function decodeRealNumber(data: Buffer, pos: number, end: number, what: string): { value: number; next: number } {
  let text = '';
  let p = pos;
  while (p < end) {
    const byte = data[p++];
    for (const nibble of [byte >> NIBBLE_BITS, byte & NIBBLE_MASK]) {
      if (nibble <= REAL_NIBBLE_MAX_DIGIT) {
        text += String(nibble);
      } else if (nibble === REAL_NIBBLE_DECIMAL) {
        text += '.';
      } else if (nibble === REAL_NIBBLE_EXPONENT) {
        text += 'E';
      } else if (nibble === REAL_NIBBLE_NEGATIVE_EXPONENT) {
        text += 'E-';
      } else if (nibble === REAL_NIBBLE_MINUS) {
        text += '-';
      } else if (nibble === REAL_NIBBLE_END) {
        const value = Number(text);
        if (text === '' || !Number.isFinite(value)) {
          throw new CffFormatError(`CFF ${what} contains a malformed real number.`);
        }
        return { value, next: p };
      } else {
        throw new CffFormatError(`CFF ${what} contains a reserved real-number nibble.`);
      }
    }
  }
  throw new CffFormatError(`CFF ${what} ends inside a real number.`);
}

function parseDict(data: Buffer, range: Range, what: string): DictMap {
  const dict: DictMap = new Map();
  let operands: number[] = [];
  let p = range.start;
  while (p < range.end) {
    const b0 = data[p++];
    if (b0 <= DICT_LAST_OPERATOR) {
      let op = b0;
      if (b0 === DICT_ESCAPE) {
        if (p >= range.end) throw new CffFormatError(`CFF ${what} ends inside an escape operator.`);
        op = DICT_ESCAPE_BASE + data[p++];
      }
      dict.set(op, operands);
      operands = [];
      continue;
    }
    const failDict = (message: string): Error => new CffFormatError(`CFF ${what} ${message}`);
    let value: number;
    const shared = decodeSharedOperand(data, b0, p, range.end, failDict);
    if (shared !== null) {
      value = shared.value;
      p = shared.next;
    } else if (b0 === DICT_OPERAND_INT32) {
      if (p + 4 > range.end) throw failDict('ends inside a 32-bit operand.');
      value = data.readInt32BE(p);
      p += 4;
    } else if (b0 === DICT_OPERAND_REAL) {
      const real = decodeRealNumber(data, p, range.end, what);
      value = real.value;
      p = real.next;
    } else {
      throw new CffFormatError(`CFF ${what} contains the reserved byte ${b0}.`);
    }
    if (operands.length >= MAX_DICT_OPERANDS) {
      throw new CffFormatError(`CFF ${what} exceeds ${MAX_DICT_OPERANDS} operands before an operator.`);
    }
    operands.push(value);
  }
  if (operands.length > 0) {
    throw new CffFormatError(`CFF ${what} ends with operands that have no operator.`);
  }
  return dict;
}

function dictInteger(dict: DictMap, op: number, what: string): number | undefined {
  const operands = dict.get(op);
  if (operands === undefined) return undefined;
  if (operands.length !== 1 || !Number.isInteger(operands[0]) || operands[0] < 0) {
    throw new CffFormatError(`CFF ${what} has an invalid operand for operator ${op}.`);
  }
  return operands[0];
}

function dictNumber(dict: DictMap, op: number, what: string): number | undefined {
  const operands = dict.get(op);
  if (operands === undefined) return undefined;
  if (operands.length !== 1) {
    throw new CffFormatError(`CFF ${what} has an invalid operand count for operator ${op}.`);
  }
  return operands[0];
}

function dictMatrix(dict: DictMap, what: string): CffMatrix | null {
  const operands = dict.get(OP_FONT_MATRIX);
  if (operands === undefined) return null;
  if (operands.length !== FONT_MATRIX_OPERANDS) {
    throw new CffFormatError(`CFF ${what} FontMatrix must have 6 operands.`);
  }
  const [a, b, c, d, tx, ty] = operands;
  return [a, b, c, d, tx, ty];
}

/** Composes two matrices so that the result applies `inner` first, then `outer`. */
function composeMatrices(outer: CffMatrix, inner: CffMatrix): CffMatrix {
  return [
    outer[0] * inner[0] + outer[2] * inner[1],
    outer[1] * inner[0] + outer[3] * inner[1],
    outer[0] * inner[2] + outer[2] * inner[3],
    outer[1] * inner[2] + outer[3] * inner[3],
    outer[0] * inner[4] + outer[2] * inner[5] + outer[4],
    outer[1] * inner[4] + outer[3] * inner[5] + outer[5],
  ];
}

// ---------------------------------------------------------------------------
// Charset, FDSelect, Private DICT
// ---------------------------------------------------------------------------

/** Returns the SID (or CID) of every glyph, or null for the predefined Expert charsets. */
function readCharset(data: Buffer, offset: number, numGlyphs: number): Uint16Array | null {
  const charset = new Uint16Array(numGlyphs);
  if (offset === 0) {
    if (numGlyphs - 1 > ISO_ADOBE_LAST_SID) {
      throw new CffFormatError('CFF ISOAdobe charset cannot cover more than 229 glyphs.');
    }
    for (let g = 0; g < numGlyphs; g++) charset[g] = g;
    return charset;
  }
  if (offset === 1 || offset === 2) return null;
  const format = readUIntBE(data, offset, 1, 'charset format');
  let p = offset + 1;
  let g = 1;
  if (format === 0) {
    for (; g < numGlyphs; g++, p += UINT16_BYTES) {
      charset[g] = readUIntBE(data, p, UINT16_BYTES, 'charset');
    }
    return charset;
  }
  if (format !== 1 && format !== 2) {
    throw new CffFormatError(`CFF charset has the unsupported format ${format}.`);
  }
  const leftBytes = format === 1 ? 1 : 2;
  while (g < numGlyphs) {
    const first = readUIntBE(data, p, UINT16_BYTES, 'charset range');
    const nLeft = readUIntBE(data, p + UINT16_BYTES, leftBytes, 'charset range');
    p += UINT16_BYTES + leftBytes;
    if (first + nLeft > UINT16_MAX || g + nLeft + 1 > numGlyphs) {
      throw new CffFormatError('CFF charset range runs past the glyph count.');
    }
    for (let i = 0; i <= nLeft; i++) charset[g++] = first + i;
  }
  return charset;
}

function readFdSelect(data: Buffer, offset: number, numGlyphs: number, fdCount: number): Uint8Array {
  const select = new Uint8Array(numGlyphs);
  const format = readUIntBE(data, offset, 1, 'FDSelect format');
  if (format === 0) {
    if (offset + 1 + numGlyphs > data.length) throw new CffFormatError('CFF FDSelect format 0 is cut short.');
    for (let g = 0; g < numGlyphs; g++) {
      const fd = data[offset + 1 + g];
      if (fd >= fdCount) throw new CffFormatError(`CFF FDSelect names font DICT ${fd} of ${fdCount}.`);
      select[g] = fd;
    }
    return select;
  }
  if (format !== FDSELECT_FORMAT_RANGES) {
    throw new CffFormatError(`CFF FDSelect has the unsupported format ${format}.`);
  }
  const nRanges = readUIntBE(data, offset + 1, UINT16_BYTES, 'FDSelect range count');
  if (nRanges === 0) throw new CffFormatError('CFF FDSelect format 3 has no ranges.');
  let p = offset + FDSELECT_HEADER_BYTES;
  let expectedFirst = 0;
  for (let r = 0; r < nRanges; r++, p += FDSELECT_RANGE_BYTES) {
    const rangeFirst = readUIntBE(data, p, UINT16_BYTES, 'FDSelect range');
    const fd = readUIntBE(data, p + UINT16_BYTES, 1, 'FDSelect range');
    const next = readUIntBE(data, p + FDSELECT_RANGE_BYTES, UINT16_BYTES, 'FDSelect range');
    if (rangeFirst !== expectedFirst) {
      throw new CffFormatError('CFF FDSelect ranges must start at glyph 0 and be contiguous.');
    }
    if (fd >= fdCount) throw new CffFormatError(`CFF FDSelect names font DICT ${fd} of ${fdCount}.`);
    if (next <= rangeFirst || next > numGlyphs) {
      throw new CffFormatError('CFF FDSelect ranges are not ascending or run past the glyph count.');
    }
    select.fill(fd, rangeFirst, next);
    expectedFirst = next;
  }
  if (expectedFirst !== numGlyphs) {
    throw new CffFormatError('CFF FDSelect sentinel must equal the glyph count.');
  }
  return select;
}

interface PrivateData {
  defaultWidthX: number;
  nominalWidthX: number;
  subrs: CffIndex | null;
  subrBias: number;
}

function subrBias(count: number): number {
  if (count < SUBR_COUNT_SMALL_LIMIT) return SUBR_BIAS_SMALL;
  if (count < SUBR_COUNT_MEDIUM_LIMIT) return SUBR_BIAS_MEDIUM;
  return SUBR_BIAS_LARGE;
}

function readPrivate(data: Buffer, size: number, offset: number, what: string): PrivateData {
  if (offset + size > data.length) {
    throw new CffFormatError(`CFF ${what} Private DICT runs past the end of the table.`);
  }
  const dict = parseDict(data, { start: offset, end: offset + size }, `${what} Private DICT`);
  const subrsOffset = dictInteger(dict, OP_SUBRS, `${what} Private DICT`);
  let subrs: CffIndex | null = null;
  if (subrsOffset !== undefined) {
    subrs = readIndex(data, offset + subrsOffset, `${what} local Subr`);
  }
  return {
    defaultWidthX: dictNumber(dict, OP_DEFAULT_WIDTH_X, `${what} Private DICT`) ?? 0,
    nominalWidthX: dictNumber(dict, OP_NOMINAL_WIDTH_X, `${what} Private DICT`) ?? 0,
    subrs,
    subrBias: subrs === null ? 0 : subrBias(subrs.count),
  };
}

function privateReference(dict: DictMap, what: string): { size: number; offset: number } | null {
  const operands = dict.get(OP_PRIVATE);
  if (operands === undefined) return null;
  if (operands.length !== 2 || !operands.every((v) => Number.isInteger(v) && v >= 0)) {
    throw new CffFormatError(`CFF ${what} has an invalid Private operator.`);
  }
  return { size: operands[0], offset: operands[1] };
}

// ---------------------------------------------------------------------------
// Font
// ---------------------------------------------------------------------------

interface FontDictInfo {
  privateData: PrivateData;
  matrix: CffMatrix | null;
}

const EMPTY_PRIVATE: PrivateData = { defaultWidthX: 0, nominalWidthX: 0, subrs: null, subrBias: 0 };

function standardEncodingSid(code: number): number {
  if (code >= STANDARD_ASCII_FIRST && code <= STANDARD_ASCII_LAST) {
    return code - STANDARD_ASCII_SID_OFFSET;
  }
  return STANDARD_ENCODING_HIGH_SIDS.get(code) ?? 0;
}

interface StackState {
  stack: number[];
  steps: number;
  nStems: number;
  haveWidth: boolean;
  widthDelta: number | null;
  x: number;
  y: number;
  contours: CffContour[];
  current: CffContour | null;
  segmentCount: number;
  transient: number[];
}

interface Frame {
  ip: number;
  end: number;
}

interface RunResult {
  width: number;
  contours: CffContour[];
}

export class CffFont {
  readonly numGlyphs: number;
  readonly isCidKeyed: boolean;
  /** SID (name-keyed) or CID (CID-keyed) per glyph; null for the predefined Expert charsets. */
  readonly charset: Uint16Array | null;

  private fontSteps = 0;
  private fontSegments = 0;
  private readonly stepBudget: number;
  private readonly segmentBudget: number;
  private sidToGlyph: Map<number, number> | null = null;

  constructor(
    private readonly data: Buffer,
    private readonly charStrings: CffIndex,
    private readonly globalSubrs: CffIndex,
    private readonly fontDicts: FontDictInfo[],
    private readonly fdSelect: Uint8Array | null,
    charset: Uint16Array | null,
    isCidKeyed: boolean
  ) {
    this.numGlyphs = charStrings.count;
    this.charset = charset;
    this.isCidKeyed = isCidKeyed;
    this.stepBudget = CFF_BASE_STEPS_PER_FONT + CFF_STEPS_PER_TABLE_BYTE * data.length;
    this.segmentBudget = CFF_BASE_SEGMENTS_PER_FONT + CFF_SEGMENTS_PER_TABLE_BYTE * data.length;
  }

  /** Interpreter steps spent so far across all glyphs interpreted by this instance. */
  get stepsExecuted(): number {
    return this.fontSteps;
  }

  /**
   * Interprets one glyph. The font-wide step and segment budgets accumulate over every call on this
   * instance, so callers should convert and release glyphs one at a time instead of keeping them all.
   */
  glyph(glyphId: number): CffGlyph {
    if (!Number.isInteger(glyphId) || glyphId < 0 || glyphId >= this.numGlyphs) {
      throw new CffCharStringError(`CFF glyph ${glyphId} is outside 0..${this.numGlyphs - 1}.`);
    }
    try {
      const result = this.run(glyphId, true);
      return {
        glyphId,
        width: result.width,
        contours: result.contours,
        matrix: this.fontDictFor(glyphId).matrix,
      };
    } catch (error) {
      if (error instanceof RangeError) {
        throw new CffCharStringError(`CFF glyph ${glyphId} reads outside the table.`);
      }
      throw error;
    }
  }

  private fontDictFor(glyphId: number): FontDictInfo {
    const index = this.fdSelect === null ? 0 : this.fdSelect[glyphId];
    return this.fontDicts[index];
  }

  private glyphForStandardCode(code: number): number {
    if (this.isCidKeyed || this.charset === null) {
      throw new CffCharStringError('CFF seac needs a name-keyed font with an explicit or ISOAdobe charset.');
    }
    const sid = standardEncodingSid(code);
    if (sid === 0) throw new CffCharStringError(`CFF seac character code ${code} is not in StandardEncoding.`);
    if (this.sidToGlyph === null) {
      this.sidToGlyph = new Map();
      for (let g = this.charset.length - 1; g >= 0; g--) this.sidToGlyph.set(this.charset[g], g);
    }
    const glyphId = this.sidToGlyph.get(sid);
    if (glyphId === undefined) {
      throw new CffCharStringError(`CFF seac component with SID ${sid} is not in the font.`);
    }
    return glyphId;
  }

  private tick(state: StackState): void {
    state.steps++;
    this.fontSteps++;
    if (state.steps > CFF_MAX_STEPS_PER_GLYPH) {
      throw new CffCharStringError(`CFF charstring exceeds ${CFF_MAX_STEPS_PER_GLYPH} steps.`);
    }
    if (this.fontSteps > this.stepBudget) {
      throw new CffCharStringError(`CFF font exceeds the budget of ${this.stepBudget} charstring steps.`);
    }
  }

  private run(glyphId: number, allowSeac: boolean): RunResult {
    const fontDict = this.fontDictFor(glyphId);
    const priv = fontDict.privateData;
    const state: StackState = {
      stack: [],
      steps: 0,
      nStems: 0,
      haveWidth: false,
      widthDelta: null,
      x: 0,
      y: 0,
      contours: [],
      current: null,
      segmentCount: 0,
      transient: new Array<number>(TRANSIENT_ARRAY_SIZE).fill(0),
    };
    const data = this.data;
    const entry = indexEntry(data, this.charStrings, glyphId);
    const frames: Frame[] = [{ ip: entry.start, end: entry.end }];

    const widthOf = (): number =>
      state.widthDelta === null ? priv.defaultWidthX : priv.nominalWidthX + state.widthDelta;

    for (;;) {
      const frame = frames[frames.length - 1];
      if (frame.ip >= frame.end) {
        const inSubr = frames.length > 1;
        const missing = inSubr ? 'return' : 'endchar';
        throw new CffCharStringError(
          `CFF glyph ${glyphId} runs off the end of its ${inSubr ? 'subroutine' : 'charstring'} without ${missing}.`
        );
      }
      this.tick(state);
      const b0 = data[frame.ip++];

      if (b0 >= OPERAND_ONE_BYTE_FIRST || b0 === OPERAND_INT16) {
        this.pushNumber(state, frame, b0);
        continue;
      }

      switch (b0) {
        case CS_HSTEM:
        case CS_VSTEM:
        case CS_HSTEMHM:
        case CS_VSTEMHM:
          this.stemHints(state, glyphId);
          break;

        case CS_HINTMASK:
        case CS_CNTRMASK: {
          this.stemHints(state, glyphId, true);
          const maskBytes = Math.ceil(state.nStems / BITS_PER_BYTE);
          if (frame.ip + maskBytes > frame.end) {
            throw new CffCharStringError(`CFF glyph ${glyphId} has a hint mask that runs past its charstring.`);
          }
          frame.ip += maskBytes;
          break;
        }

        case CS_RMOVETO:
          this.moveTo(state, glyphId, 2, (a) => [a[0], a[1]]);
          break;
        case CS_HMOVETO:
          this.moveTo(state, glyphId, 1, (a) => [a[0], 0]);
          break;
        case CS_VMOVETO:
          this.moveTo(state, glyphId, 1, (a) => [0, a[0]]);
          break;

        case CS_RLINETO:
          this.rlineto(state, glyphId);
          break;
        case CS_HLINETO:
        case CS_VLINETO:
          this.hvlineto(state, glyphId, b0 === CS_HLINETO);
          break;
        case CS_RRCURVETO:
          this.rrcurveto(state, glyphId);
          break;
        case CS_RCURVELINE:
          this.rcurveline(state, glyphId);
          break;
        case CS_RLINECURVE:
          this.rlinecurve(state, glyphId);
          break;
        case CS_HHCURVETO:
        case CS_VVCURVETO:
          this.hhvvcurveto(state, glyphId, b0 === CS_HHCURVETO);
          break;
        case CS_HVCURVETO:
        case CS_VHCURVETO:
          this.hvvhcurveto(state, glyphId, b0 === CS_HVCURVETO);
          break;

        case CS_CALLSUBR:
        case CS_CALLGSUBR: {
          const subrs = b0 === CS_CALLSUBR ? priv.subrs : this.globalSubrs;
          const bias = b0 === CS_CALLSUBR ? priv.subrBias : subrBias(this.globalSubrs.count);
          const selector = this.popNumber(state, glyphId);
          if (subrs === null || !Number.isInteger(selector)) {
            throw new CffCharStringError(`CFF glyph ${glyphId} calls a subroutine that does not exist.`);
          }
          const subrIndex = selector + bias;
          if (subrIndex < 0 || subrIndex >= subrs.count) {
            throw new CffCharStringError(`CFF glyph ${glyphId} calls subroutine ${subrIndex} of ${subrs.count}.`);
          }
          if (frames.length > CFF_MAX_SUBR_DEPTH) {
            throw new CffCharStringError(
              `CFF glyph ${glyphId} nests subroutines deeper than ${CFF_MAX_SUBR_DEPTH}.`
            );
          }
          const subr = indexEntry(data, subrs, subrIndex);
          frames.push({ ip: subr.start, end: subr.end });
          break;
        }

        case CS_RETURN:
          if (frames.length === 1) {
            throw new CffCharStringError(`CFF glyph ${glyphId} executes return outside a subroutine.`);
          }
          frames.pop();
          break;

        case CS_ENDCHAR:
          return this.endChar(state, glyphId, allowSeac, widthOf);

        case CS_ESCAPE: {
          if (frame.ip >= frame.end) {
            throw new CffCharStringError(`CFF glyph ${glyphId} ends inside an escape operator.`);
          }
          this.escapeOperator(state, glyphId, data[frame.ip++]);
          break;
        }

        default:
          throw new CffCharStringError(`CFF glyph ${glyphId} uses the reserved operator ${b0}.`);
      }
    }
  }

  private pushNumber(state: StackState, frame: Frame, b0: number): void {
    const fail = (message: string): Error => new CffCharStringError(`CFF charstring ${message}`);
    const shared = decodeSharedOperand(this.data, b0, frame.ip, frame.end, fail);
    if (shared !== null) {
      frame.ip = shared.next;
      this.push(state, shared.value);
      return;
    }
    // The only remaining operand form is the 16.16 fixed-point number introduced by byte 255.
    if (frame.ip + 4 > frame.end) throw fail('ends inside a 16.16 operand.');
    this.push(state, this.data.readInt32BE(frame.ip) / FIXED_16_16_DIVISOR);
    frame.ip += 4;
  }

  private push(state: StackState, value: number): void {
    if (state.stack.length >= CFF_MAX_STACK_DEPTH) {
      throw new CffCharStringError(`CFF charstring pushes past the stack limit of ${CFF_MAX_STACK_DEPTH}.`);
    }
    state.stack.push(value);
  }

  private popNumber(state: StackState, glyphId: number): number {
    const value = state.stack.pop();
    if (value === undefined) {
      throw new CffCharStringError(`CFF glyph ${glyphId} pops from an empty stack.`);
    }
    return value;
  }

  /**
   * Consumes the optional leading width of the first stack-clearing operator. `counts` lists the
   * argument counts the operator accepts without a width; with a width the count is one more.
   */
  private takeWidth(state: StackState, glyphId: number, counts: readonly number[], name: string): void {
    const stack = state.stack;
    if (!state.haveWidth) {
      state.haveWidth = true;
      if (counts.some((count) => stack.length === count + 1)) {
        state.widthDelta = stack.shift() as number;
      }
    }
    if (!counts.includes(stack.length)) {
      throw new CffCharStringError(`CFF glyph ${glyphId} gives ${name} ${stack.length} arguments.`);
    }
  }

  private stemHints(state: StackState, glyphId: number, allowEmpty = false): void {
    const stack = state.stack;
    if (!state.haveWidth) {
      state.haveWidth = true;
      if (stack.length % STEM_ARGS === 1) state.widthDelta = stack.shift() as number;
    }
    if (stack.length % STEM_ARGS !== 0 || (stack.length === 0 && !allowEmpty)) {
      throw new CffCharStringError(`CFF glyph ${glyphId} gives a stem operator ${stack.length} arguments.`);
    }
    state.nStems += stack.length / STEM_ARGS;
    stack.length = 0;
  }

  private startContour(state: StackState, glyphId: number): void {
    this.closeContour(state);
    if (state.contours.length >= CFF_MAX_SEGMENTS_PER_GLYPH) {
      throw new CffCharStringError(`CFF glyph ${glyphId} has too many subpaths.`);
    }
    state.current = { start: { x: state.x, y: state.y }, segments: [] };
  }

  private closeContour(state: StackState): void {
    if (state.current !== null && state.current.segments.length > 0) {
      state.contours.push(state.current);
    }
    state.current = null;
  }

  private moveTo(
    state: StackState,
    glyphId: number,
    argCount: number,
    delta: (args: number[]) => [number, number]
  ): void {
    this.takeWidth(state, glyphId, [argCount], 'a moveto operator');
    const [dx, dy] = delta(state.stack);
    state.stack.length = 0;
    state.x += dx;
    state.y += dy;
    this.startContour(state, glyphId);
  }

  private requireContour(state: StackState, glyphId: number): CffContour {
    if (state.current === null) {
      throw new CffCharStringError(`CFF glyph ${glyphId} draws before its first moveto.`);
    }
    return state.current;
  }

  private addLine(state: StackState, glyphId: number, dx: number, dy: number): void {
    const contour = this.requireContour(state, glyphId);
    this.countSegment(state, glyphId);
    state.x += dx;
    state.y += dy;
    contour.segments.push({ kind: 'line', to: { x: state.x, y: state.y } });
  }

  private addCurve(
    state: StackState,
    glyphId: number,
    d: readonly [number, number, number, number, number, number]
  ): void {
    const contour = this.requireContour(state, glyphId);
    this.countSegment(state, glyphId);
    const c1 = { x: state.x + d[0], y: state.y + d[1] };
    const c2 = { x: c1.x + d[2], y: c1.y + d[3] };
    const to = { x: c2.x + d[4], y: c2.y + d[5] };
    state.x = to.x;
    state.y = to.y;
    contour.segments.push({ kind: 'curve', c1, c2, to });
  }

  private countSegment(state: StackState, glyphId: number): void {
    state.segmentCount++;
    if (state.segmentCount > CFF_MAX_SEGMENTS_PER_GLYPH) {
      throw new CffCharStringError(`CFF glyph ${glyphId} has more than ${CFF_MAX_SEGMENTS_PER_GLYPH} segments.`);
    }
    this.fontSegments++;
    if (this.fontSegments > this.segmentBudget) {
      throw new CffCharStringError(`CFF font exceeds the budget of ${this.segmentBudget} path segments.`);
    }
  }

  private rlineto(state: StackState, glyphId: number): void {
    const a = state.stack;
    if (a.length === 0 || a.length % ARGS_PER_LINE !== 0) {
      throw new CffCharStringError(`CFF glyph ${glyphId} gives rlineto ${a.length} arguments.`);
    }
    for (let i = 0; i < a.length; i += ARGS_PER_LINE) this.addLine(state, glyphId, a[i], a[i + 1]);
    a.length = 0;
  }

  private hvlineto(state: StackState, glyphId: number, horizontalFirst: boolean): void {
    const a = state.stack;
    if (a.length === 0) throw new CffCharStringError(`CFF glyph ${glyphId} gives hlineto/vlineto no arguments.`);
    let horizontal = horizontalFirst;
    for (const delta of a) {
      if (horizontal) {
        this.addLine(state, glyphId, delta, 0);
      } else {
        this.addLine(state, glyphId, 0, delta);
      }
      horizontal = !horizontal;
    }
    a.length = 0;
  }

  private rrcurveto(state: StackState, glyphId: number): void {
    const a = state.stack;
    if (a.length === 0 || a.length % ARGS_PER_CURVE !== 0) {
      throw new CffCharStringError(`CFF glyph ${glyphId} gives rrcurveto ${a.length} arguments.`);
    }
    for (let i = 0; i < a.length; i += ARGS_PER_CURVE) {
      this.addCurve(state, glyphId, [a[i], a[i + 1], a[i + 2], a[i + 3], a[i + 4], a[i + 5]]);
    }
    a.length = 0;
  }

  private rcurveline(state: StackState, glyphId: number): void {
    const a = state.stack;
    if (a.length < MIN_ARGS_CURVE_LINE || (a.length - ARGS_PER_LINE) % ARGS_PER_CURVE !== 0) {
      throw new CffCharStringError(`CFF glyph ${glyphId} gives rcurveline ${a.length} arguments.`);
    }
    let i = 0;
    for (; i + ARGS_PER_CURVE <= a.length - ARGS_PER_LINE; i += ARGS_PER_CURVE) {
      this.addCurve(state, glyphId, [a[i], a[i + 1], a[i + 2], a[i + 3], a[i + 4], a[i + 5]]);
    }
    this.addLine(state, glyphId, a[i], a[i + 1]);
    a.length = 0;
  }

  private rlinecurve(state: StackState, glyphId: number): void {
    const a = state.stack;
    if (a.length < MIN_ARGS_CURVE_LINE || (a.length - ARGS_PER_CURVE) % ARGS_PER_LINE !== 0) {
      throw new CffCharStringError(`CFF glyph ${glyphId} gives rlinecurve ${a.length} arguments.`);
    }
    let i = 0;
    for (; i < a.length - ARGS_PER_CURVE; i += ARGS_PER_LINE) this.addLine(state, glyphId, a[i], a[i + 1]);
    this.addCurve(state, glyphId, [a[i], a[i + 1], a[i + 2], a[i + 3], a[i + 4], a[i + 5]]);
    a.length = 0;
  }

  private hhvvcurveto(state: StackState, glyphId: number, horizontal: boolean): void {
    const a = state.stack;
    const extra = a.length % ARGS_PER_COMPACT_CURVE;
    if (a.length < ARGS_PER_COMPACT_CURVE || extra > 1) {
      throw new CffCharStringError(`CFF glyph ${glyphId} gives hhcurveto/vvcurveto ${a.length} arguments.`);
    }
    let i = 0;
    let lead = extra === 1 ? a[i++] : 0;
    for (; i < a.length; i += ARGS_PER_COMPACT_CURVE) {
      if (horizontal) {
        // hhcurveto: dxa dxb dyb dxc, with the optional leading dy1 applying to the first curve only.
        this.addCurve(state, glyphId, [a[i], lead, a[i + 1], a[i + 2], a[i + 3], 0]);
      } else {
        // vvcurveto: dya dxb dyb dyc, with the optional leading dx1 applying to the first curve only.
        this.addCurve(state, glyphId, [lead, a[i], a[i + 1], a[i + 2], 0, a[i + 3]]);
      }
      lead = 0;
    }
    a.length = 0;
  }

  private hvvhcurveto(state: StackState, glyphId: number, horizontalFirst: boolean): void {
    const a = state.stack;
    const extra = a.length % ARGS_PER_COMPACT_CURVE;
    if (a.length < ARGS_PER_COMPACT_CURVE || extra > 1) {
      throw new CffCharStringError(`CFF glyph ${glyphId} gives hvcurveto/vhcurveto ${a.length} arguments.`);
    }
    let horizontal = horizontalFirst;
    for (let i = 0; i + ARGS_PER_COMPACT_CURVE <= a.length; i += ARGS_PER_COMPACT_CURVE) {
      const last = i + ARGS_PER_COMPACT_CURVE + extra === a.length;
      const tail = last && extra === 1 ? a[i + ARGS_PER_COMPACT_CURVE] : 0;
      if (horizontal) {
        // dx1 dx2 dy2 dy3 (dxf): starts horizontal, ends vertical unless a final dxf is given.
        this.addCurve(state, glyphId, [a[i], 0, a[i + 1], a[i + 2], tail, a[i + 3]]);
      } else {
        // dy1 dx2 dy2 dx3 (dyf): starts vertical, ends horizontal unless a final dyf is given.
        this.addCurve(state, glyphId, [0, a[i], a[i + 1], a[i + 2], a[i + 3], tail]);
      }
      horizontal = !horizontal;
    }
    a.length = 0;
  }

  private endChar(
    state: StackState,
    glyphId: number,
    allowSeac: boolean,
    widthOf: () => number
  ): RunResult {
    this.takeWidth(state, glyphId, [0, SEAC_ARGUMENTS], 'endchar');
    this.closeContour(state);
    if (state.stack.length === 0) {
      return { width: widthOf(), contours: state.contours };
    }
    if (!allowSeac) {
      throw new CffCharStringError(`CFF glyph ${glyphId} nests a seac accent inside a seac component.`);
    }
    const [adx, ady, bchar, achar] = state.stack;
    for (const code of [bchar, achar]) {
      if (!Number.isInteger(code) || code < 0 || code >= SEAC_CHAR_CODE_LIMIT) {
        throw new CffCharStringError(`CFF glyph ${glyphId} has an invalid seac character code.`);
      }
    }
    const base = this.run(this.glyphForStandardCode(bchar), false);
    const accent = this.run(this.glyphForStandardCode(achar), false);
    const shifted = accent.contours.map(
      (contour): CffContour => ({
        start: { x: contour.start.x + adx, y: contour.start.y + ady },
        segments: contour.segments.map((segment): CffSegment => {
          if (segment.kind === 'line') {
            return { kind: 'line', to: { x: segment.to.x + adx, y: segment.to.y + ady } };
          }
          return {
            kind: 'curve',
            c1: { x: segment.c1.x + adx, y: segment.c1.y + ady },
            c2: { x: segment.c2.x + adx, y: segment.c2.y + ady },
            to: { x: segment.to.x + adx, y: segment.to.y + ady },
          };
        }),
      })
    );
    return { width: widthOf(), contours: [...base.contours, ...shifted] };
  }

  private binary(state: StackState, glyphId: number, op: (a: number, b: number) => number): void {
    const b = this.popNumber(state, glyphId);
    const a = this.popNumber(state, glyphId);
    this.push(state, op(a, b));
  }

  private unary(state: StackState, glyphId: number, op: (a: number) => number): void {
    this.push(state, op(this.popNumber(state, glyphId)));
  }

  private escapeOperator(state: StackState, glyphId: number, op: number): void {
    const stack = state.stack;
    switch (op) {
      case CS_ESC_DOTSECTION:
        stack.length = 0;
        return;
      case CS_ESC_FLEX:
        this.flex(state, glyphId);
        return;
      case CS_ESC_HFLEX:
        this.hflex(state, glyphId);
        return;
      case CS_ESC_HFLEX1:
        this.hflex1(state, glyphId);
        return;
      case CS_ESC_FLEX1:
        this.flex1(state, glyphId);
        return;
      case CS_ESC_AND:
        this.binary(state, glyphId, (a, b) => (a !== 0 && b !== 0 ? 1 : 0));
        return;
      case CS_ESC_OR:
        this.binary(state, glyphId, (a, b) => (a !== 0 || b !== 0 ? 1 : 0));
        return;
      case CS_ESC_NOT:
        this.unary(state, glyphId, (a) => (a === 0 ? 1 : 0));
        return;
      case CS_ESC_ABS:
        this.unary(state, glyphId, Math.abs);
        return;
      case CS_ESC_ADD:
        this.binary(state, glyphId, (a, b) => a + b);
        return;
      case CS_ESC_SUB:
        this.binary(state, glyphId, (a, b) => a - b);
        return;
      case CS_ESC_DIV:
        this.binary(state, glyphId, (a, b) => {
          if (b === 0) throw new CffCharStringError(`CFF glyph ${glyphId} divides by zero.`);
          return a / b;
        });
        return;
      case CS_ESC_NEG:
        this.unary(state, glyphId, (a) => -a);
        return;
      case CS_ESC_EQ:
        this.binary(state, glyphId, (a, b) => (a === b ? 1 : 0));
        return;
      case CS_ESC_DROP:
        this.popNumber(state, glyphId);
        return;
      case CS_ESC_MUL:
        this.binary(state, glyphId, (a, b) => a * b);
        return;
      case CS_ESC_SQRT:
        this.unary(state, glyphId, (a) => {
          if (a < 0) throw new CffCharStringError(`CFF glyph ${glyphId} takes the square root of a negative number.`);
          return Math.sqrt(a);
        });
        return;
      case CS_ESC_DUP: {
        const top = this.popNumber(state, glyphId);
        this.push(state, top);
        this.push(state, top);
        return;
      }
      case CS_ESC_EXCH: {
        const b = this.popNumber(state, glyphId);
        const a = this.popNumber(state, glyphId);
        this.push(state, b);
        this.push(state, a);
        return;
      }
      case CS_ESC_PUT: {
        const slot = this.popNumber(state, glyphId);
        const value = this.popNumber(state, glyphId);
        state.transient[this.transientSlot(slot, glyphId)] = value;
        return;
      }
      case CS_ESC_GET: {
        const slot = this.popNumber(state, glyphId);
        this.push(state, state.transient[this.transientSlot(slot, glyphId)]);
        return;
      }
      case CS_ESC_IFELSE: {
        const v2 = this.popNumber(state, glyphId);
        const v1 = this.popNumber(state, glyphId);
        const s2 = this.popNumber(state, glyphId);
        const s1 = this.popNumber(state, glyphId);
        this.push(state, v1 <= v2 ? s1 : s2);
        return;
      }
      case CS_ESC_INDEX: {
        const selector = this.popNumber(state, glyphId);
        if (!Number.isInteger(selector)) {
          throw new CffCharStringError(`CFF glyph ${glyphId} uses a fractional index operand.`);
        }
        const from = Math.max(selector, 0);
        if (from >= stack.length) {
          throw new CffCharStringError(`CFF glyph ${glyphId} indexes past the bottom of the stack.`);
        }
        this.push(state, stack[stack.length - 1 - from]);
        return;
      }
      case CS_ESC_ROLL:
        this.roll(state, glyphId);
        return;
      case CS_ESC_RANDOM:
        throw new CffCharStringError(`CFF glyph ${glyphId} uses random, which would make the output nondeterministic.`);
      default:
        throw new CffCharStringError(`CFF glyph ${glyphId} uses the reserved operator 12 ${op}.`);
    }
  }

  private transientSlot(slot: number, glyphId: number): number {
    if (!Number.isInteger(slot) || slot < 0 || slot >= TRANSIENT_ARRAY_SIZE) {
      throw new CffCharStringError(`CFF glyph ${glyphId} uses transient array slot ${slot}.`);
    }
    return slot;
  }

  private roll(state: StackState, glyphId: number): void {
    const shift = this.popNumber(state, glyphId);
    const count = this.popNumber(state, glyphId);
    const stack = state.stack;
    if (!Number.isInteger(count) || !Number.isInteger(shift) || count < 0 || count > stack.length) {
      throw new CffCharStringError(`CFF glyph ${glyphId} rolls ${count} of ${stack.length} stack elements.`);
    }
    if (count === 0) return;
    const window = stack.splice(stack.length - count, count);
    const amount = ((shift % count) + count) % count;
    // A positive shift moves elements toward the top of the stack, wrapping the top to the bottom.
    for (let i = 0; i < count; i++) {
      stack.push(window[(i - amount + count) % count]);
    }
  }

  private flex(state: StackState, glyphId: number): void {
    const a = state.stack;
    if (a.length !== FLEX_ARGS) throw new CffCharStringError(`CFF glyph ${glyphId} gives flex ${a.length} arguments.`);
    this.addCurve(state, glyphId, [a[0], a[1], a[2], a[3], a[4], a[5]]);
    this.addCurve(state, glyphId, [a[6], a[7], a[8], a[9], a[10], a[11]]);
    a.length = 0;
  }

  private hflex(state: StackState, glyphId: number): void {
    const a = state.stack;
    if (a.length !== HFLEX_ARGS) throw new CffCharStringError(`CFF glyph ${glyphId} gives hflex ${a.length} arguments.`);
    this.addCurve(state, glyphId, [a[0], 0, a[1], a[2], a[3], 0]);
    this.addCurve(state, glyphId, [a[4], 0, a[5], -a[2], a[6], 0]);
    a.length = 0;
  }

  private hflex1(state: StackState, glyphId: number): void {
    const a = state.stack;
    if (a.length !== HFLEX1_ARGS) throw new CffCharStringError(`CFF glyph ${glyphId} gives hflex1 ${a.length} arguments.`);
    this.addCurve(state, glyphId, [a[0], a[1], a[2], a[3], a[4], 0]);
    this.addCurve(state, glyphId, [a[5], 0, a[6], a[7], a[8], -(a[1] + a[3] + a[7])]);
    a.length = 0;
  }

  private flex1(state: StackState, glyphId: number): void {
    const a = state.stack;
    if (a.length !== FLEX1_ARGS) throw new CffCharStringError(`CFF glyph ${glyphId} gives flex1 ${a.length} arguments.`);
    const dx = a[0] + a[2] + a[4] + a[6] + a[8];
    const dy = a[1] + a[3] + a[5] + a[7] + a[9];
    this.addCurve(state, glyphId, [a[0], a[1], a[2], a[3], a[4], a[5]]);
    if (Math.abs(dx) > Math.abs(dy)) {
      this.addCurve(state, glyphId, [a[6], a[7], a[8], a[9], a[10], -dy]);
    } else {
      this.addCurve(state, glyphId, [a[6], a[7], a[8], a[9], -dx, a[10]]);
    }
    a.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Parses a CFF 1 table. Throws CffFormatError for any structural problem. */
export function parseCff(data: Buffer): CffFont {
  try {
    return parseCffUnchecked(data);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new CffFormatError('CFF table reads outside its own bounds.');
    }
    throw error;
  }
}

function parseCffUnchecked(data: Buffer): CffFont {
  if (data.length < HEADER_MIN_BYTES) {
    throw new CffFormatError('CFF table is shorter than its 4-byte header.');
  }
  if (data.length > CFF_MAX_TABLE_BYTES) {
    throw new CffFormatError(`CFF table is larger than ${CFF_MAX_TABLE_BYTES} bytes.`);
  }
  if (data[0] !== SUPPORTED_MAJOR_VERSION) {
    throw new CffFormatError(`CFF major version ${data[0]} is not supported; only version 1 is.`);
  }
  const hdrSize = data[2];
  const headerOffSize = data[3];
  if (hdrSize < HEADER_MIN_BYTES || hdrSize > data.length) {
    throw new CffFormatError(`CFF header size ${hdrSize} is invalid.`);
  }
  if (headerOffSize < INDEX_MIN_OFFSET_SIZE || headerOffSize > INDEX_MAX_OFFSET_SIZE) {
    throw new CffFormatError(`CFF header offSize ${headerOffSize} must be 1 to 4.`);
  }

  const nameIndex = readIndex(data, hdrSize, 'Name');
  const topDictIndex = readIndex(data, nameIndex.end, 'Top DICT');
  if (topDictIndex.count !== 1 || nameIndex.count !== 1) {
    throw new CffFormatError('An OpenType CFF table holds exactly one font (one Name and one Top DICT entry).');
  }
  const stringIndex = readIndex(data, topDictIndex.end, 'String');
  const globalSubrs = readIndex(data, stringIndex.end, 'Global Subr');

  const topDict = parseDict(data, indexEntry(data, topDictIndex, 0), 'Top DICT');
  const charstringType = dictInteger(topDict, OP_CHARSTRING_TYPE, 'Top DICT');
  if (charstringType !== undefined && charstringType !== CHARSTRING_TYPE_2) {
    throw new CffFormatError(`CFF CharstringType ${charstringType} is not supported; only Type 2 is.`);
  }

  const charStringsOffset = dictInteger(topDict, OP_CHARSTRINGS, 'Top DICT');
  if (charStringsOffset === undefined || charStringsOffset >= data.length) {
    throw new CffFormatError('CFF Top DICT has no valid CharStrings offset.');
  }
  const charStrings = readIndex(data, charStringsOffset, 'CharStrings');
  if (charStrings.count === 0 || charStrings.count > MAX_GLYPHS) {
    throw new CffFormatError(`CFF CharStrings INDEX holds ${charStrings.count} glyphs.`);
  }

  const charsetOffset = dictInteger(topDict, OP_CHARSET, 'Top DICT') ?? 0;
  const charset = readCharset(data, charsetOffset, charStrings.count);

  const isCidKeyed = topDict.has(OP_ROS);
  const topMatrix = dictMatrix(topDict, 'Top DICT');
  const fontDicts: FontDictInfo[] = [];
  let fdSelect: Uint8Array | null = null;

  if (isCidKeyed) {
    if (topDict.get(OP_ROS)?.length !== 3) {
      throw new CffFormatError('CFF ROS operator needs three operands.');
    }
    const fdArrayOffset = dictInteger(topDict, OP_FD_ARRAY, 'Top DICT');
    const fdSelectOffset = dictInteger(topDict, OP_FD_SELECT, 'Top DICT');
    if (fdArrayOffset === undefined || fdSelectOffset === undefined) {
      throw new CffFormatError('A CID-keyed CFF font needs both FDArray and FDSelect.');
    }
    const fdArray = readIndex(data, fdArrayOffset, 'FDArray');
    if (fdArray.count === 0 || fdArray.count > MAX_FONT_DICTS) {
      throw new CffFormatError(`CFF FDArray holds ${fdArray.count} font DICTs.`);
    }
    const privateCache = new Map<string, PrivateData>();
    for (let i = 0; i < fdArray.count; i++) {
      const what = `font DICT ${i}`;
      const fdDict = parseDict(data, indexEntry(data, fdArray, i), what);
      const reference = privateReference(fdDict, what);
      let privateData = EMPTY_PRIVATE;
      if (reference !== null) {
        const key = `${reference.offset}:${reference.size}`;
        const cached = privateCache.get(key);
        if (cached === undefined) {
          privateData = readPrivate(data, reference.size, reference.offset, what);
          privateCache.set(key, privateData);
        } else {
          privateData = cached;
        }
      }
      const fdMatrix = dictMatrix(fdDict, what);
      let matrix: CffMatrix | null = fdMatrix ?? topMatrix;
      if (fdMatrix !== null && topMatrix !== null) matrix = composeMatrices(topMatrix, fdMatrix);
      fontDicts.push({ privateData, matrix });
    }
    fdSelect = readFdSelect(data, fdSelectOffset, charStrings.count, fontDicts.length);
  } else {
    const reference = privateReference(topDict, 'Top DICT');
    const privateData =
      reference === null ? EMPTY_PRIVATE : readPrivate(data, reference.size, reference.offset, 'Top DICT');
    fontDicts.push({ privateData, matrix: topMatrix });
  }

  return new CffFont(data, charStrings, globalSubrs, fontDicts, fdSelect, charset, isCidKeyed);
}
