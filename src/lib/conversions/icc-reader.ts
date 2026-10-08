import { ConversionFailedError } from '../types';
import { type Chromaticities, type Matrix3, BT709_PRIMARIES, D65_WHITE, bradfordAdaptation, invert3, multiply3, rgbToXyzMatrix, xyzOfXy } from './colour-primaries';

/**
 * Reader for matrix/TRC ICC profiles (ICC.1:2022, sections 7 and 10): the colorant tags rXYZ/gXYZ/bXYZ and the
 * tone curves rTRC/gTRC/bTRC (`curv` and `para` types). That covers sRGB, Display P3, Adobe RGB, Rec. 2020 and
 * most camera and monitor profiles. A well-formed profile of another kind (LUT based, grey, CMYK) is reported as
 * such so the caller can hand it to the image library's colour engine; a malformed profile is a typed 400.
 */

/** Largest profile inspected; real profiles run from 0.5 KB (matrix) to a few MB (printer LUTs). */
export const ICC_MAX_BYTES = 8 * 1024 * 1024;
/** Most tags a profile may declare; real profiles carry fewer than 60. */
export const ICC_MAX_TAGS = 256;
/** Most entries of a sampled `curv` curve (the table length field is 32 bit). */
export const ICC_MAX_CURVE_ENTRIES = 65_536;

const HEADER_BYTES = 128;
const TAG_TABLE_ENTRY_BYTES = 12;
const SIGNATURE_OFFSET = 36;
const VERSION_OFFSET = 8;
const COLOUR_SPACE_OFFSET = 16;
const PCS_OFFSET = 20;
const XYZ_TYPE_BYTES = 20;
const XYZ_DATA_OFFSET = 8;
/** Bytes before the data of a `curv` or `para` tag: type signature, reserved word, then count or function type. */
const CURVE_HEADER_BYTES = 12;
const CURVE_COUNT_OFFSET = 8;
const PARA_FUNCTION_OFFSET = 8;
const U16_BYTES = 2;
const S15_FIXED16_BYTES = 4;
const S15_FIXED16_DIVISOR = 65_536;
const U8_FIXED8_DIVISOR = 256;
const U16_MAX = 65_535;
/** Parametric curve function types 0 to 4 and the parameters each takes (ICC.1:2022 table 68). */
const PARA_PARAMETER_COUNTS: readonly number[] = [1, 3, 4, 5, 7];
/** PCS illuminant, D50 (ICC.1:2022 section 7.2.16). */
const D50_WHITE_XYZ: readonly [number, number, number] = [0.9642, 1, 0.8249];
const D65_WHITE_XYZ = xyzOfXy(D65_WHITE);

const MATRIX_TRC_TAGS: readonly string[] = ['rXYZ', 'gXYZ', 'bXYZ', 'rTRC', 'gTRC', 'bTRC'];

export class IccProfileError extends ConversionFailedError {
  constructor(message: string) {
    super(`Invalid ICC profile: ${message}`);
    this.name = 'IccProfileError';
  }
}

/** A one-input tone reproduction curve mapping device-encoded [0, 1] to linear [0, 1]. */
export type ToneCurve = (encoded: number) => number;

export interface IccMatrixTrcProfile {
  readonly kind: 'matrix-trc';
  /** Linear RGB of the profile to CIE XYZ relative to the D50 profile connection space. */
  readonly rgbToXyzD50: Matrix3;
  readonly curves: readonly [ToneCurve, ToneCurve, ToneCurve];
}

export interface IccOtherProfile {
  readonly kind: 'other';
  /** Four-character colour space of the header (`RGB `, `GRAY`, `CMYK`, ...). */
  readonly colourSpace: string;
  /** Why the profile is not a matrix/TRC one, for diagnostics. */
  readonly reason: string;
}

export type IccProfile = IccMatrixTrcProfile | IccOtherProfile;

interface TagEntry {
  readonly offset: number;
  readonly size: number;
}

function fixed(buf: Buffer, offset: number): number {
  return buf.readInt32BE(offset) / S15_FIXED16_DIVISOR;
}

function readTagTable(buf: Buffer): Map<string, TagEntry> {
  if (buf.length > ICC_MAX_BYTES) {
    throw new IccProfileError(`${buf.length} bytes exceed the ${ICC_MAX_BYTES} byte limit`);
  }
  if (buf.length < HEADER_BYTES + 4) throw new IccProfileError('shorter than a profile header');
  if (buf.toString('latin1', SIGNATURE_OFFSET, SIGNATURE_OFFSET + 4) !== 'acsp') {
    throw new IccProfileError('missing the "acsp" file signature');
  }
  const major = buf[VERSION_OFFSET];
  if (major !== 2 && major !== 4) throw new IccProfileError(`unsupported major version ${major}`);
  const declared = buf.readUInt32BE(0);
  if (declared > buf.length) throw new IccProfileError(`declares ${declared} bytes but only ${buf.length} are present`);
  const count = buf.readUInt32BE(HEADER_BYTES);
  if (count > ICC_MAX_TAGS) throw new IccProfileError(`declares ${count} tags (limit ${ICC_MAX_TAGS})`);
  if (HEADER_BYTES + 4 + count * TAG_TABLE_ENTRY_BYTES > buf.length) throw new IccProfileError('tag table is truncated');
  const tags = new Map<string, TagEntry>();
  for (let i = 0; i < count; i += 1) {
    const at = HEADER_BYTES + 4 + i * TAG_TABLE_ENTRY_BYTES;
    const signature = buf.toString('latin1', at, at + 4);
    const offset = buf.readUInt32BE(at + 4);
    const size = buf.readUInt32BE(at + 8);
    if (offset > buf.length || size > buf.length - offset) {
      throw new IccProfileError(`tag "${signature}" lies outside the profile`);
    }
    if (!tags.has(signature)) tags.set(signature, { offset, size });
  }
  return tags;
}

function readXyz(buf: Buffer, tags: Map<string, TagEntry>, signature: string): readonly [number, number, number] {
  const tag = tags.get(signature);
  if (!tag) throw new IccProfileError(`missing the "${signature}" tag`);
  if (tag.size < XYZ_TYPE_BYTES || buf.toString('latin1', tag.offset, tag.offset + 4) !== 'XYZ ') {
    throw new IccProfileError(`"${signature}" is not an XYZ tag`);
  }
  return [fixed(buf, tag.offset + XYZ_DATA_OFFSET), fixed(buf, tag.offset + XYZ_DATA_OFFSET + S15_FIXED16_BYTES), fixed(buf, tag.offset + XYZ_DATA_OFFSET + 2 * S15_FIXED16_BYTES)];
}

function parametricCurve(type: number, p: readonly number[]): ToneCurve {
  const [g, a, b, c, d, e, f] = p;
  switch (type) {
    case 0:
      return (x) => Math.pow(x, g);
    case 1:
      return (x) => (x >= -b / a ? Math.pow(a * x + b, g) : 0);
    case 2:
      return (x) => (x >= -b / a ? Math.pow(a * x + b, g) + c : c);
    case 3:
      return (x) => (x >= d ? Math.pow(a * x + b, g) : c * x);
    default:
      return (x) => (x >= d ? Math.pow(a * x + b, g) + e : c * x + f);
  }
}

function readCurve(buf: Buffer, tags: Map<string, TagEntry>, signature: string): ToneCurve {
  const tag = tags.get(signature);
  if (!tag) throw new IccProfileError(`missing the "${signature}" tag`);
  const type = buf.toString('latin1', tag.offset, tag.offset + 4);
  if (type === 'curv') {
    if (tag.size < CURVE_HEADER_BYTES) throw new IccProfileError(`"${signature}" is truncated`);
    const count = buf.readUInt32BE(tag.offset + CURVE_COUNT_OFFSET);
    if (count > ICC_MAX_CURVE_ENTRIES) {
      throw new IccProfileError(`"${signature}" has ${count} entries (limit ${ICC_MAX_CURVE_ENTRIES})`);
    }
    if (CURVE_HEADER_BYTES + count * U16_BYTES > tag.size) throw new IccProfileError(`"${signature}" table is truncated`);
    if (count === 0) return (x) => x;
    if (count === 1) {
      const gamma = buf.readUInt16BE(tag.offset + CURVE_HEADER_BYTES) / U8_FIXED8_DIVISOR;
      return (x) => Math.pow(x, gamma);
    }
    const table = new Float64Array(count);
    for (let i = 0; i < count; i += 1) table[i] = buf.readUInt16BE(tag.offset + CURVE_HEADER_BYTES + i * U16_BYTES) / U16_MAX;
    const last = count - 1;
    return (x) => {
      const position = Math.min(1, Math.max(0, x)) * last;
      const index = Math.min(last - 1, Math.floor(position));
      return table[index] + (table[index + 1] - table[index]) * (position - index);
    };
  }
  if (type === 'para') {
    if (tag.size < CURVE_HEADER_BYTES) throw new IccProfileError(`"${signature}" is truncated`);
    const functionType = buf.readUInt16BE(tag.offset + PARA_FUNCTION_OFFSET);
    const needed = PARA_PARAMETER_COUNTS[functionType];
    if (needed === undefined) throw new IccProfileError(`"${signature}" uses parametric function ${functionType}`);
    if (CURVE_HEADER_BYTES + needed * S15_FIXED16_BYTES > tag.size) throw new IccProfileError(`"${signature}" parameters are truncated`);
    const params: number[] = [];
    for (let i = 0; i < needed; i += 1) params.push(fixed(buf, tag.offset + CURVE_HEADER_BYTES + i * S15_FIXED16_BYTES));
    if (functionType > 0 && params[1] === 0) throw new IccProfileError(`"${signature}" has a zero slope`);
    return parametricCurve(functionType, params);
  }
  throw new IccProfileError(`"${signature}" has the unsupported type "${type}"`);
}

/**
 * Parses a profile. A matrix/TRC profile returns its colorants and curves; any other well-formed profile returns
 * `{ kind: 'other' }`. Malformed or oversized input throws IccProfileError.
 */
export function readIccProfile(buf: Buffer): IccProfile {
  const tags = readTagTable(buf);
  const colourSpace = buf.toString('latin1', COLOUR_SPACE_OFFSET, COLOUR_SPACE_OFFSET + 4);
  const pcs = buf.toString('latin1', PCS_OFFSET, PCS_OFFSET + 4);
  if (colourSpace !== 'RGB ') return { kind: 'other', colourSpace, reason: `colour space "${colourSpace.trim()}"` };
  const present = MATRIX_TRC_TAGS.filter((signature) => tags.has(signature));
  if (present.length === 0 || pcs !== 'XYZ ') {
    return { kind: 'other', colourSpace, reason: 'no matrix/TRC tags (lookup-table profile)' };
  }
  if (present.length !== MATRIX_TRC_TAGS.length) {
    const missing = MATRIX_TRC_TAGS.filter((signature) => !tags.has(signature));
    throw new IccProfileError(`matrix/TRC profile lacks ${missing.join(', ')}`);
  }
  const red = readXyz(buf, tags, 'rXYZ');
  const green = readXyz(buf, tags, 'gXYZ');
  const blue = readXyz(buf, tags, 'bXYZ');
  const rgbToXyzD50: Matrix3 = [red[0], green[0], blue[0], red[1], green[1], blue[1], red[2], green[2], blue[2]];
  return {
    kind: 'matrix-trc',
    rgbToXyzD50,
    curves: [readCurve(buf, tags, 'rTRC'), readCurve(buf, tags, 'gTRC'), readCurve(buf, tags, 'bTRC')],
  };
}

/** Linear RGB of a matrix/TRC profile to linear Rec. 709 (D65), through the D50 profile connection space. */
export function iccToLinearBt709(profile: IccMatrixTrcProfile): Matrix3 {
  const bt709ToXyzD65 = rgbToXyzMatrix(BT709_PRIMARIES);
  const bt709ToXyzD50 = multiply3(bradfordAdaptation(D65_WHITE_XYZ, D50_WHITE_XYZ), bt709ToXyzD65);
  return multiply3(invert3(bt709ToXyzD50), profile.rgbToXyzD50);
}

/** Chromaticities of the profile's primaries as seen from D65, for comparing against named primaries. */
export function iccPrimaries(profile: IccMatrixTrcProfile): Chromaticities {
  const toD65 = multiply3(bradfordAdaptation(D50_WHITE_XYZ, D65_WHITE_XYZ), profile.rgbToXyzD50);
  const xy = (column: number): { x: number; y: number } => {
    const x = toD65[column];
    const y = toD65[3 + column];
    const z = toD65[6 + column];
    const sum = x + y + z;
    return { x: x / sum, y: y / sum };
  };
  return { red: xy(0), green: xy(1), blue: xy(2), white: BT709_PRIMARIES.white };
}

/** Table of the curve for `levels` evenly spaced encoded values, e.g. 256 for 8-bit or 65536 for 16-bit samples. */
export function curveTable(curve: ToneCurve, levels: number): Float32Array {
  const table = new Float32Array(levels);
  const last = levels - 1;
  for (let i = 0; i < levels; i += 1) table[i] = curve(i / last);
  return table;
}
