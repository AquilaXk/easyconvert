import { ConvertedType, ParquetFormatError, ParquetType, ParquetUnsupportedError } from './parquet-format';

/**
 * Logical-type interpretation for reading. Every physical value is turned into the most faithful
 * JSON-safe value: integers beyond 2^53 and decimals become exact decimal strings, dates and times
 * become ISO-8601 strings, and binary that is not text becomes base64. Nothing is rounded.
 *
 * Governing spec: Apache Parquet LogicalTypes.md (DECIMAL, DATE, TIME, TIMESTAMP, INTEGER, UUID).
 */

export type ColumnValue = string | number | boolean | null;
export type TimeUnit = 'millis' | 'micros' | 'nanos';

export type Annotation =
  | { tag: 'none' }
  | { tag: 'string' }
  | { tag: 'enum' }
  | { tag: 'json' }
  | { tag: 'bson' }
  | { tag: 'uuid' }
  | { tag: 'decimal'; scale: number; precision: number }
  | { tag: 'date' }
  | { tag: 'time'; unit: TimeUnit }
  | { tag: 'timestamp'; unit: TimeUnit; adjustedToUtc: boolean }
  | { tag: 'int'; bitWidth: number; signed: boolean }
  | { tag: 'unsupported'; name: string };

/** How a leaf column's PLAIN bytes become values. `map` post-processes the raw integer or bytes. */
export type ValueKind = 'bool' | 'i32' | 'u32' | 'i64' | 'u64' | 'f32' | 'f64' | 'bytes';

export interface ColumnReader {
  kind: ValueKind;
  /** Fixed byte width for FIXED_LEN_BYTE_ARRAY values; 0 means length-prefixed BYTE_ARRAY. */
  width: number;
  map: ((raw: number | bigint | Buffer) => ColumnValue) | null;
}

const SECONDS_PER_DAY = 86_400;
const SECONDS_PER_HOUR = 3_600;
const SECONDS_PER_MINUTE = 60;
const MILLIS_PER_SECOND = 1_000;
const MICROS_PER_SECOND = 1_000_000;
const NANOS_PER_SECOND = 1_000_000_000;
const FRACTION_DIGITS: Record<TimeUnit, number> = { millis: 3, micros: 6, nanos: 9 };
const UNITS_PER_SECOND: Record<TimeUnit, number> = {
  millis: MILLIS_PER_SECOND,
  micros: MICROS_PER_SECOND,
  nanos: NANOS_PER_SECOND,
};
/** Days from 0000-03-01 to 1970-01-01, the shift used by the civil-date conversion. */
const DAYS_TO_EPOCH_FROM_ERA_START = 719_468;
const DAYS_PER_ERA = 146_097;
const YEARS_PER_ERA = 400;
const DAYS_PER_YEAR = 365;
const NORMAL_YEAR_DIGITS = 4;
const EXPANDED_YEAR_DIGITS = 6;
const MAX_DECIMAL_SCALE = 76;
const MAX_DECIMAL_BYTES = 32;
const UUID_BYTES = 16;
const BYTE_BITS = 8n;
const BYTE_SIGN_BIT = 0x80;
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const UINT64_MODULUS_BITS = 64;
const REPLACEMENT_CHARACTER = '�';

const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true });

/** An exact JSON-safe form of a 64-bit integer: a Number when safe, otherwise its decimal digits. */
export function exactInteger(value: bigint): number | string {
  return value >= MIN_SAFE_BIGINT && value <= MAX_SAFE_BIGINT ? Number(value) : value.toString();
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function formatYear(year: number): string {
  if (year >= 0 && year <= 9999) return pad(year, NORMAL_YEAR_DIGITS);
  const sign = year < 0 ? '-' : '+';
  return sign + pad(Math.abs(year), EXPANDED_YEAR_DIGITS);
}

/** Proleptic Gregorian date for a day count since 1970-01-01, as YYYY-MM-DD. */
export function formatDate(days: number): string {
  const z = days + DAYS_TO_EPOCH_FROM_ERA_START;
  const era = Math.floor(z / DAYS_PER_ERA);
  const dayOfEra = z - era * DAYS_PER_ERA;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36_524) - Math.floor(dayOfEra / 146_096)) /
      DAYS_PER_YEAR
  );
  const dayOfYear = dayOfEra - (DAYS_PER_YEAR * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthIndex = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthIndex + 2) / 5) + 1;
  const month = monthIndex < 10 ? monthIndex + 3 : monthIndex - 9;
  const year = yearOfEra + era * YEARS_PER_ERA + (month <= 2 ? 1 : 0);
  return `${formatYear(year)}-${pad(month, 2)}-${pad(day, 2)}`;
}

function floorDivide(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

function formatFraction(fraction: bigint, unit: TimeUnit): string {
  if (fraction === 0n) return '';
  return `.${fraction.toString().padStart(FRACTION_DIGITS[unit], '0')}`;
}

function formatClock(secondOfDay: number): string {
  const hours = Math.floor(secondOfDay / SECONDS_PER_HOUR);
  const minutes = Math.floor((secondOfDay % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(secondOfDay % SECONDS_PER_MINUTE, 2)}`;
}

/** ISO-8601 timestamp from an exact integer count of `unit` since the epoch. */
export function formatTimestamp(value: bigint, unit: TimeUnit, adjustedToUtc: boolean): string {
  const perSecond = BigInt(UNITS_PER_SECOND[unit]);
  const seconds = floorDivide(value, perSecond);
  const fraction = value - seconds * perSecond;
  const days = floorDivide(seconds, BigInt(SECONDS_PER_DAY));
  const secondOfDay = Number(seconds - days * BigInt(SECONDS_PER_DAY));
  const zone = adjustedToUtc ? 'Z' : '';
  return `${formatDate(Number(days))}T${formatClock(secondOfDay)}${formatFraction(fraction, unit)}${zone}`;
}

/** Time of day from an exact integer count of `unit` since midnight. */
export function formatTime(value: bigint, unit: TimeUnit, column: string): string {
  const perSecond = BigInt(UNITS_PER_SECOND[unit]);
  if (value < 0n || value >= perSecond * BigInt(SECONDS_PER_DAY)) {
    throw new ParquetFormatError(`Corrupted Parquet file: time of day ${value} is outside one day in column '${column}'`);
  }
  const seconds = value / perSecond;
  return `${formatClock(Number(seconds))}${formatFraction(value - seconds * perSecond, unit)}`;
}

/** Exact decimal text of an unscaled integer and a non-negative scale. */
export function formatDecimal(unscaled: bigint, scale: number): string {
  const negative = unscaled < 0n;
  const digits = (negative ? -unscaled : unscaled).toString();
  const sign = negative ? '-' : '';
  if (scale === 0) return sign + digits;
  const padded = digits.padStart(scale + 1, '0');
  return `${sign}${padded.slice(0, padded.length - scale)}.${padded.slice(padded.length - scale)}`;
}

/** Big-endian two's-complement bytes to an integer. */
function signedBigEndian(bytes: Buffer, column: string): bigint {
  if (bytes.length > MAX_DECIMAL_BYTES) {
    throw new ParquetFormatError(`Corrupted Parquet file: decimal of ${bytes.length} bytes in column '${column}'`);
  }
  let value = 0n;
  for (const b of bytes) value = (value << BYTE_BITS) | BigInt(b);
  if (bytes.length > 0 && (bytes[0] & BYTE_SIGN_BIT) !== 0) value -= 1n << (BYTE_BITS * BigInt(bytes.length));
  return value;
}

/** Valid UTF-8 text, or null when the bytes are not valid UTF-8. */
export function decodeUtf8OrNull(bytes: Buffer): string | null {
  const text = bytes.toString('utf8');
  if (!text.includes(REPLACEMENT_CHARACTER)) return text;
  try {
    return UTF8_STRICT.decode(bytes);
  } catch {
    return null;
  }
}

function uuidText(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function describeAnnotation(a: Annotation): string {
  return a.tag === 'unsupported' ? a.name : a.tag.toUpperCase();
}

/** Resolves the annotation of a leaf from its LogicalType, falling back to its ConvertedType. */
export function annotationFromConverted(
  converted: number | undefined,
  scale: number,
  precision: number
): Annotation {
  if (converted === undefined) return { tag: 'none' };
  switch (converted) {
    case ConvertedType.UTF8:
      return { tag: 'string' };
    case ConvertedType.ENUM:
      return { tag: 'enum' };
    case ConvertedType.JSON:
      return { tag: 'json' };
    case ConvertedType.BSON:
      return { tag: 'bson' };
    case ConvertedType.DECIMAL:
      return { tag: 'decimal', scale, precision };
    case ConvertedType.DATE:
      return { tag: 'date' };
    case ConvertedType.TIME_MILLIS:
      return { tag: 'time', unit: 'millis' };
    case ConvertedType.TIME_MICROS:
      return { tag: 'time', unit: 'micros' };
    case ConvertedType.TIMESTAMP_MILLIS:
      return { tag: 'timestamp', unit: 'millis', adjustedToUtc: true };
    case ConvertedType.TIMESTAMP_MICROS:
      return { tag: 'timestamp', unit: 'micros', adjustedToUtc: true };
    case ConvertedType.UINT_8:
      return { tag: 'int', bitWidth: 8, signed: false };
    case ConvertedType.UINT_16:
      return { tag: 'int', bitWidth: 16, signed: false };
    case ConvertedType.UINT_32:
      return { tag: 'int', bitWidth: 32, signed: false };
    case ConvertedType.UINT_64:
      return { tag: 'int', bitWidth: 64, signed: false };
    case ConvertedType.INT_8:
      return { tag: 'int', bitWidth: 8, signed: true };
    case ConvertedType.INT_16:
      return { tag: 'int', bitWidth: 16, signed: true };
    case ConvertedType.INT_32:
      return { tag: 'int', bitWidth: 32, signed: true };
    case ConvertedType.INT_64:
      return { tag: 'int', bitWidth: 64, signed: true };
    default:
      return { tag: 'unsupported', name: ConvertedType[converted] ?? `converted type ${converted}` };
  }
}

function incompatible(column: string, type: ParquetType, annotation: Annotation): never {
  throw new ParquetFormatError(
    `Corrupted Parquet metadata: ${describeAnnotation(annotation)} annotation does not apply to ${ParquetType[type]} column '${column}'`
  );
}

function validateDecimal(column: string, annotation: { scale: number; precision: number }): void {
  if (annotation.scale < 0 || annotation.scale > MAX_DECIMAL_SCALE || annotation.precision < 1) {
    throw new ParquetFormatError(
      `Corrupted Parquet metadata: invalid decimal(${annotation.precision}, ${annotation.scale}) in column '${column}'`
    );
  }
}

function bytesReader(width: number, map: (raw: number | bigint | Buffer) => ColumnValue): ColumnReader {
  return { kind: 'bytes', width, map };
}

function textOrBinary(): (raw: number | bigint | Buffer) => ColumnValue {
  return (raw) => {
    const bytes = raw as Buffer;
    return decodeUtf8OrNull(bytes) ?? bytes.toString('base64');
  };
}

function strictText(column: string): (raw: number | bigint | Buffer) => ColumnValue {
  return (raw) => {
    const text = decodeUtf8OrNull(raw as Buffer);
    if (text === null) {
      throw new ParquetFormatError(`Corrupted Parquet file: invalid UTF-8 in text column '${column}'`);
    }
    return text;
  };
}

function resolveByteArray(column: string, annotation: Annotation, width: number): ColumnReader {
  switch (annotation.tag) {
    case 'string':
    case 'enum':
    case 'json':
      return bytesReader(width, strictText(column));
    case 'none':
      return bytesReader(width, textOrBinary());
    case 'bson':
      return bytesReader(width, (raw) => (raw as Buffer).toString('base64'));
    case 'decimal':
      validateDecimal(column, annotation);
      return bytesReader(width, (raw) => formatDecimal(signedBigEndian(raw as Buffer, column), annotation.scale));
    case 'uuid':
      return bytesReader(width, (raw) => uuidText(raw as Buffer));
    default:
      return incompatibleOrUnsupported(column, ParquetType.BYTE_ARRAY, annotation);
  }
}

function incompatibleOrUnsupported(column: string, type: ParquetType, annotation: Annotation): never {
  if (annotation.tag === 'unsupported') {
    throw new ParquetUnsupportedError(
      `Unsupported Parquet logical type ${annotation.name} on ${ParquetType[type]} column '${column}'`
    );
  }
  return incompatible(column, type, annotation);
}

function resolveInt32(column: string, annotation: Annotation): ColumnReader {
  switch (annotation.tag) {
    case 'none':
      return { kind: 'i32', width: 0, map: null };
    case 'int':
      if (annotation.bitWidth > 32) return incompatible(column, ParquetType.INT32, annotation);
      return { kind: annotation.signed ? 'i32' : 'u32', width: 0, map: null };
    case 'date':
      return { kind: 'i32', width: 0, map: (raw) => formatDate(raw as number) };
    case 'time':
      if (annotation.unit !== 'millis') return incompatible(column, ParquetType.INT32, annotation);
      return { kind: 'i32', width: 0, map: (raw) => formatTime(BigInt(raw as number), 'millis', column) };
    case 'decimal':
      validateDecimal(column, annotation);
      return { kind: 'i32', width: 0, map: (raw) => formatDecimal(BigInt(raw as number), annotation.scale) };
    default:
      return incompatibleOrUnsupported(column, ParquetType.INT32, annotation);
  }
}

function resolveInt64(column: string, annotation: Annotation): ColumnReader {
  switch (annotation.tag) {
    case 'none':
      return { kind: 'i64', width: 0, map: null };
    case 'int':
      return { kind: annotation.signed ? 'i64' : 'u64', width: 0, map: null };
    case 'time':
      if (annotation.unit === 'millis') return incompatible(column, ParquetType.INT64, annotation);
      return { kind: 'i64', width: 0, map: (raw) => formatTime(raw as bigint, annotation.unit, column) };
    case 'timestamp':
      return {
        kind: 'i64',
        width: 0,
        map: (raw) => formatTimestamp(raw as bigint, annotation.unit, annotation.adjustedToUtc),
      };
    case 'decimal':
      validateDecimal(column, annotation);
      return { kind: 'i64', width: 0, map: (raw) => formatDecimal(raw as bigint, annotation.scale) };
    default:
      return incompatibleOrUnsupported(column, ParquetType.INT64, annotation);
  }
}

/**
 * Chooses how a leaf's values are read. INT96 and annotations this engine cannot represent
 * throw ParquetUnsupportedError; an annotation that contradicts the physical type is malformed.
 */
export function resolveColumnReader(
  column: string,
  type: ParquetType,
  typeLength: number,
  annotation: Annotation
): ColumnReader {
  switch (type) {
    case ParquetType.BOOLEAN:
      if (annotation.tag !== 'none') return incompatibleOrUnsupported(column, type, annotation);
      return { kind: 'bool', width: 0, map: null };
    case ParquetType.INT32:
      return resolveInt32(column, annotation);
    case ParquetType.INT64:
      return resolveInt64(column, annotation);
    case ParquetType.FLOAT:
    case ParquetType.DOUBLE:
      if (annotation.tag !== 'none') return incompatibleOrUnsupported(column, type, annotation);
      return { kind: type === ParquetType.FLOAT ? 'f32' : 'f64', width: 0, map: null };
    case ParquetType.BYTE_ARRAY:
      return resolveByteArray(column, annotation, 0);
    case ParquetType.FIXED_LEN_BYTE_ARRAY:
      if (typeLength < 1) {
        throw new ParquetFormatError(`Corrupted Parquet metadata: fixed-length column '${column}' has no type_length`);
      }
      if (annotation.tag === 'uuid' && typeLength !== UUID_BYTES) return incompatible(column, type, annotation);
      return resolveByteArray(column, annotation, typeLength);
    default:
      throw new ParquetUnsupportedError(`Unsupported Parquet physical type ${ParquetType[type] ?? type} in column '${column}'`);
  }
}

/** Exact value of an unsigned 64-bit pattern. */
export function unsignedInteger(signed: bigint): number | string {
  return exactInteger(BigInt.asUintN(UINT64_MODULUS_BITS, signed));
}
