import { ConversionFailedError } from '../types';

/**
 * Building blocks of the WOFF2 codec, authored from the W3C WOFF2 Recommendation
 * (https://www.w3.org/TR/WOFF2/): the known table tags of the table directory, the UIntBase128 and
 * 255UInt16 data types, and the errors, limits and buffers the glyf and container modules share.
 */

/** Malformed WOFF2 input, or a font that cannot be expressed as WOFF2. Maps to HTTP 400 at the API. */
export class Woff2FormatError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'Woff2FormatError';
  }
}

/** A size or count in a WOFF2 file, or in a font to encode, exceeds the limits of this engine. */
export class Woff2LimitError extends Woff2FormatError {
  constructor(message: string) {
    super(message);
    this.name = 'Woff2LimitError';
  }
}

export function truncated(what: string): Woff2FormatError {
  return new Woff2FormatError(`Invalid WOFF2: ${what} is cut short.`);
}

/** Tables in one WOFF2 directory (a collection lists the tables of all its fonts). */
export const WOFF2_MAX_TABLES = 4096;
/** Fonts in one WOFF2 collection. */
export const WOFF2_MAX_FONTS = 256;
/** Bytes of table data a WOFF2 file may decode to or an sfnt may encode from, counted over all tables. */
export const WOFF2_MAX_DECODED_BYTES = 256 * 1024 * 1024;
/** Bytes of table data all fonts of one collection may describe together, shared tables counted once per font. */
export const WOFF2_MAX_COLLECTION_BYTES = WOFF2_MAX_DECODED_BYTES;
/** Table bytes a compressed stream may carry per compressed byte; real fonts stay below 20. */
export const WOFF2_MAX_EXPANSION_RATIO = 1000;
/** The expansion ratio is only enforced above this many table bytes, where it could hurt memory. */
export const WOFF2_EXPANSION_RATIO_FLOOR_BYTES = 4 * 1024 * 1024;
/** The head table is exactly 54 bytes, so a longer one is not a font table but an amplification vehicle. */
export const WOFF2_HEAD_BYTES = 54;
/** Points in one glyph: end points are 16-bit indices, so 0xFFFF is the last addressable one. */
export const WOFF2_MAX_POINTS_PER_GLYPH = 0x10000;

/** Known table tags by directory index (Recommendation, table directory format). Index 63 announces an explicit tag. */
export const WOFF2_KNOWN_TAGS: readonly string[] = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm',
  'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern',
  'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC',
  'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar',
  'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty',
  'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat',
  'Gloc', 'Feat', 'Sill',
];

const UINT32_MAX = 0xffffffff;
const UINT16_MAX = 0xffff;
const BYTE_BITS = 8;
const BYTE_MASK = 0xff;
const BASE128_MAX_BYTES = 5;
const BASE128_CONTINUE = 0x80;
const BASE128_RADIX = 128;
const BASE128_PAYLOAD = 0x7f;
/** A value above this overflows 32 bits when shifted by one more group (the 0xFE000000 test of the spec). */
const BASE128_OVERFLOW_GUARD = 0x01ffffff;

export const U255_WORD_CODE = 253;
export const U255_ONE_MORE_BYTE_2 = 254;
export const U255_ONE_MORE_BYTE_1 = 255;
export const U255_BYTE_1_BASE = 253;
export const U255_BYTE_2_BASE = 506;
const U255_LOWEST_UCODE = 253;
const U255_WORD_BASE = 762;

/** Returns the UIntBase128 form of `value` (big endian groups of seven bits, continuation bit on all but the last). */
export function encodeUIntBase128(value: number): number[] {
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new Woff2FormatError(`UIntBase128 cannot represent ${value}: only 0 to ${UINT32_MAX} are allowed.`);
  }
  const bytes = [value % BASE128_RADIX];
  let rest = Math.floor(value / BASE128_RADIX);
  while (rest > 0) {
    bytes.push((rest % BASE128_RADIX) | BASE128_CONTINUE);
    rest = Math.floor(rest / BASE128_RADIX);
  }
  return bytes.reverse();
}

/**
 * Reads a UIntBase128 at `cursor.offset` and advances the cursor. A leading 0x80 byte (redundant
 * zero group), more than five bytes, and a value past 32 bits are rejected as the specification demands.
 */
export function decodeUIntBase128(buffer: Uint8Array, cursor: { offset: number }): number {
  let accum = 0;
  for (let i = 0; i < BASE128_MAX_BYTES; i++) {
    if (cursor.offset >= buffer.length) {
      throw new Woff2FormatError('Unexpected end of data while reading a UIntBase128 in WOFF2.');
    }
    const byte = buffer[cursor.offset++];
    if (i === 0 && byte === BASE128_CONTINUE) {
      throw new Woff2FormatError('Invalid WOFF2 UIntBase128: a leading zero group is not allowed.');
    }
    if (accum > BASE128_OVERFLOW_GUARD) {
      throw new Woff2FormatError('Invalid WOFF2 UIntBase128: the value exceeds 32 bits.');
    }
    accum = accum * BASE128_RADIX + (byte & BASE128_PAYLOAD);
    if ((byte & BASE128_CONTINUE) === 0) return accum;
  }
  throw new Woff2FormatError(`Invalid WOFF2 UIntBase128: longer than ${BASE128_MAX_BYTES} bytes.`);
}

/** Encodes `value` as a 255UInt16, using the shortest of the one, two and three byte forms. */
export function encode255UInt16(value: number): number[] {
  if (!Number.isInteger(value) || value < 0 || value > UINT16_MAX) {
    throw new Woff2FormatError(`255UInt16 cannot represent ${value}: only 0 to ${UINT16_MAX} are allowed.`);
  }
  if (value < U255_LOWEST_UCODE) return [value];
  if (value < U255_BYTE_2_BASE) return [U255_ONE_MORE_BYTE_1, value - U255_BYTE_1_BASE];
  if (value < U255_WORD_BASE) return [U255_ONE_MORE_BYTE_2, value - U255_BYTE_2_BASE];
  return [U255_WORD_CODE, value >> BYTE_BITS, value & BYTE_MASK];
}

/** Reads a 255UInt16 at `cursor.offset` and advances the cursor. */
export function decode255UInt16(buffer: Uint8Array, cursor: { offset: number }): number {
  const at = cursor.offset;
  if (at >= buffer.length) throw new Woff2FormatError('Unexpected end of data while reading a 255UInt16 in WOFF2.');
  const code = buffer[at];
  if (code === U255_WORD_CODE) {
    if (at + 3 > buffer.length) throw new Woff2FormatError('Unexpected end of data while reading a 255UInt16 in WOFF2.');
    cursor.offset = at + 3;
    return (buffer[at + 1] << BYTE_BITS) | buffer[at + 2];
  }
  if (code === U255_ONE_MORE_BYTE_1 || code === U255_ONE_MORE_BYTE_2) {
    if (at + 2 > buffer.length) throw new Woff2FormatError('Unexpected end of data while reading a 255UInt16 in WOFF2.');
    cursor.offset = at + 2;
    return buffer[at + 1] + (code === U255_ONE_MORE_BYTE_1 ? U255_BYTE_1_BASE : U255_BYTE_2_BASE);
  }
  cursor.offset = at + 1;
  return code;
}

const ALIGNMENT = 4;

/** Orders table tags as the sfnt directory does: by unsigned byte value, ascending. */
export function compareTags(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Rounds up to the next multiple of four without 32-bit wrap-around. */
export function alignUp(n: number): number {
  return Math.ceil(n / ALIGNMENT) * ALIGNMENT;
}

/** The sfnt checksum: the sum of the big-endian 32-bit words of the table, zero padded. */
export function sfntChecksum(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const whole = bytes.length - (bytes.length % ALIGNMENT);
  let sum = 0;
  for (let i = 0; i < whole; i += ALIGNMENT) sum = (sum + view.getUint32(i)) >>> 0;
  if (whole < bytes.length) {
    let tail = 0;
    for (let i = whole, shift = 24; i < bytes.length; i++, shift -= 8) tail |= bytes[i] << shift;
    sum = (sum + (tail >>> 0)) >>> 0;
  }
  return sum;
}

/** Room a single reservation may take beyond the cap of a GrowBuffer; the largest glyph needs well under this. */
export const GROW_BUFFER_SLACK = 1024 * 1024;

/**
 * A byte buffer that grows on demand. `reserve` makes room before bytes are written, possibly past
 * the cap by at most GROW_BUFFER_SLACK; `commit` checks the bytes actually written against the cap.
 */
export class GrowBuffer {
  bytes: Uint8Array;
  length = 0;
  private view: DataView;

  constructor(initial: number, private readonly cap: number, private readonly overflow: (needed: number) => Error) {
    this.bytes = new Uint8Array(Math.min(Math.max(initial, 1), cap + GROW_BUFFER_SLACK));
    this.view = new DataView(this.bytes.buffer);
  }

  /** Makes room for `extra` more bytes. Callers re-read `bytes` afterwards because it may be replaced. */
  reserve(extra: number): void {
    const needed = this.length + extra;
    if (needed <= this.bytes.length) return;
    if (needed > this.cap + GROW_BUFFER_SLACK) throw this.overflow(needed);
    const next = new Uint8Array(Math.min(this.cap + GROW_BUFFER_SLACK, Math.max(needed, this.bytes.length * 2)));
    next.set(this.bytes.subarray(0, this.length));
    this.bytes = next;
    this.view = new DataView(next.buffer);
  }

  /** Throws when more than the cap has been written. */
  commit(): void {
    if (this.length > this.cap) throw this.overflow(this.length);
  }

  u16(at: number, value: number): void {
    this.view.setUint16(at, value);
  }

  /** Appends one byte. */
  u8(value: number): void {
    this.reserve(1);
    this.bytes[this.length++] = value;
  }

  /** Appends a 16-bit unsigned integer, big endian. */
  u16be(value: number): void {
    this.reserve(2);
    this.bytes[this.length++] = value >> BYTE_BITS;
    this.bytes[this.length++] = value & BYTE_MASK;
  }

  /** Appends the bytes of `source`. */
  append(source: Uint8Array): void {
    this.reserve(source.length);
    this.bytes.set(source, this.length);
    this.length += source.length;
  }

  /** Appends a 255UInt16 (the value must be a 16-bit unsigned integer). */
  u255(value: number): void {
    if (value < U255_LOWEST_UCODE) {
      this.u8(value);
    } else if (value < U255_BYTE_2_BASE) {
      this.u8(U255_ONE_MORE_BYTE_1);
      this.u8(value - U255_BYTE_1_BASE);
    } else if (value < U255_WORD_BASE) {
      this.u8(U255_ONE_MORE_BYTE_2);
      this.u8(value - U255_BYTE_2_BASE);
    } else {
      this.u8(U255_WORD_CODE);
      this.u8(value >> BYTE_BITS);
      this.u8(value & BYTE_MASK);
    }
  }

  i16(at: number, value: number): void {
    this.view.setInt16(at, value);
  }

  finish(): Uint8Array {
    this.commit();
    return this.bytes.subarray(0, this.length);
  }
}
