import { ConversionFailedError } from '../types';

/**
 * WOFF2 container primitives, authored from the W3C WOFF2 Recommendation
 * (https://www.w3.org/TR/WOFF2/): known table tags (5.1), UIntBase128 and 255UInt16 (5.2, 5.3).
 * The container codec builds on these in later units of the same module.
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

/** Known table tags by directory index (Recommendation 5.1). Index 63 announces an explicit tag. */
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
const BASE128_MAX_BYTES = 5;
const BASE128_CONTINUE = 0x80;
const BASE128_RADIX = 128;
const BASE128_PAYLOAD = 0x7f;
/** A value above this overflows 32 bits when shifted by one more group (the 0xFE000000 test of the spec). */
const BASE128_OVERFLOW_GUARD = 0x01ffffff;

const U255_WORD_CODE = 253;
const U255_ONE_MORE_BYTE_2 = 254;
const U255_ONE_MORE_BYTE_1 = 255;
const U255_LOWEST_UCODE = 253;
const U255_BYTE_1_BASE = 253;
const U255_BYTE_2_BASE = 506;
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
  return [U255_WORD_CODE, value >> 8, value & 0xff];
}

/** Reads a 255UInt16 at `cursor.offset` and advances the cursor. */
export function decode255UInt16(buffer: Uint8Array, cursor: { offset: number }): number {
  const at = cursor.offset;
  if (at >= buffer.length) throw new Woff2FormatError('Unexpected end of data while reading a 255UInt16 in WOFF2.');
  const code = buffer[at];
  if (code === U255_WORD_CODE) {
    if (at + 3 > buffer.length) throw new Woff2FormatError('Unexpected end of data while reading a 255UInt16 in WOFF2.');
    cursor.offset = at + 3;
    return (buffer[at + 1] << 8) | buffer[at + 2];
  }
  if (code === U255_ONE_MORE_BYTE_1 || code === U255_ONE_MORE_BYTE_2) {
    if (at + 2 > buffer.length) throw new Woff2FormatError('Unexpected end of data while reading a 255UInt16 in WOFF2.');
    cursor.offset = at + 2;
    return buffer[at + 1] + (code === U255_ONE_MORE_BYTE_1 ? U255_BYTE_1_BASE : U255_BYTE_2_BASE);
  }
  cursor.offset = at + 1;
  return code;
}
