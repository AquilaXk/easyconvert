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
  | { tag: 'float16' }
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
  /** Fixed byte width for FIXED_LEN_BYTE_ARRAY or INT96 values; 0 means length-prefixed BYTE_ARRAY. */
  width: number;
  map: ((raw: number | bigint | Buffer) => ColumnValue) | null;
  /** Optional fast path for INT64 values that fit in a safe JS integer. */
  mapNumber?: (raw: number) => ColumnValue;
  /** Direct range reader on a page buffer, avoiding per-value Buffer.subarray allocations. */
  readSlice?: (page: Buffer, start: number, end: number) => ColumnValue;
  /** True when every decoded string has UTF-8 byte length equal to its source slice length. */
  sliceByteLengthExact?: boolean;
}

const SECONDS_PER_DAY = 86_400;
const SECONDS_PER_HOUR = 3_600;
const SECONDS_PER_MINUTE = 60;
const MILLIS_PER_SECOND = 1_000;
const MICROS_PER_SECOND = 1_000_000;
const NANOS_PER_SECOND = 1_000_000_000;
const NANOS_PER_MILLI = 1_000_000n;
const NANOS_PER_MICRO = 1_000n;
const NANOS_PER_DAY = 86_400_000_000_000n;
const JULIAN_EPOCH_DAY = 2_440_588n;
const INT96_BYTES = 12;
const INT96_JULIAN_DAY_OFFSET = 8;
const FLOAT16_BYTES = 2;
const FLOAT16_SIGN_MASK = 0x8000;
const FLOAT16_EXP_SHIFT = 10;
const FLOAT16_EXP_MASK = 0x1f;
const FLOAT16_FRAC_MASK = 0x03ff;
const FLOAT16_EXP_BIAS = 15;
const FLOAT16_FRAC_SCALE = 1024;
const FLOAT16_SUBNORMAL_SCALE = 2 ** -24;
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
const REPLACEMENT_CHARACTER = '\ufffd';

const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true });
const TWO_DIGITS: readonly string[] = Array.from({ length: 100 }, (_, i) => (i < 10 ? `0${i}` : `${i}`));
const THREE_DIGITS: readonly string[] = Array.from({ length: 1000 }, (_, i) => String(i).padStart(3, '0'));
const DOT_THREE_DIGITS: readonly string[] = Array.from({ length: 1000 }, (_, i) => (i === 0 ? '' : `.${THREE_DIGITS[i]}`));
const DOT_THREE_DIGITS_Z: readonly string[] = Array.from({ length: 1000 }, (_, i) => (i === 0 ? 'Z' : `.${THREE_DIGITS[i]}Z`));
const HOURS_PER_DAY = 24;
const MIN_SEC_STRINGS: readonly string[] = Array.from({ length: SECONDS_PER_HOUR }, (_, i) => {
  const m = Math.trunc(i / SECONDS_PER_MINUTE);
  const s = i - m * SECONDS_PER_MINUTE;
  return `${TWO_DIGITS[m]}:${TWO_DIGITS[s]}`;
});
let cachedDayCount = Number.NaN;
let cachedDayText = '';
let cachedDayPrefix = '';
let cachedHourKey = Number.NaN;
let cachedHourPrefix = '';

/** An exact JSON-safe form of a 64-bit integer: a Number when safe, otherwise its decimal digits. */
export function exactInteger(value: bigint): number | string {
  return value >= MIN_SAFE_BIGINT && value <= MAX_SAFE_BIGINT ? Number(value) : value.toString();
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function formatYear(year: number): string {
  if (year >= 1000 && year <= 9999) return `${year}`;
  if (year >= 0 && year <= 9999) return pad(year, NORMAL_YEAR_DIGITS);
  const sign = year < 0 ? '-' : '+';
  return sign + pad(Math.abs(year), EXPANDED_YEAR_DIGITS);
}

/** Proleptic Gregorian date for a day count since 1970-01-01, as YYYY-MM-DD. */
export function formatDate(days: number): string {
  if (days === cachedDayCount) return cachedDayText;
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
  const text = `${formatYear(year)}-${TWO_DIGITS[month]}-${TWO_DIGITS[day]}`;
  cachedDayCount = days;
  cachedDayText = text;
  cachedDayPrefix = `${text}T`;
  return text;
}

function formatDatePrefix(days: number): string {
  if (days === cachedDayCount) return cachedDayPrefix;
  formatDate(days);
  return cachedDayPrefix;
}

function formatHourPrefix(hourKey: number): string {
  if (hourKey === cachedHourKey) return cachedHourPrefix;
  let hourOfDay = hourKey % HOURS_PER_DAY;
  if (hourOfDay < 0) hourOfDay += HOURS_PER_DAY;
  const days = (hourKey - hourOfDay) / HOURS_PER_DAY;
  const prefix = `${formatDatePrefix(days)}${TWO_DIGITS[hourOfDay]}:`;
  cachedHourKey = hourKey;
  cachedHourPrefix = prefix;
  return prefix;
}

function floorDivide(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

function formatFraction(fraction: bigint, unit: TimeUnit): string {
  if (fraction === 0n) return '';
  if (unit === 'millis') return `.${THREE_DIGITS[Number(fraction)]}`;
  return `.${fraction.toString().padStart(FRACTION_DIGITS[unit], '0')}`;
}

function formatClock(secondOfDay: number): string {
  const hours = Math.trunc(secondOfDay / SECONDS_PER_HOUR);
  const rem = secondOfDay - hours * SECONDS_PER_HOUR;
  return `${TWO_DIGITS[hours]}:${MIN_SEC_STRINGS[rem]}`;
}

const MAX_INT32_SECONDS = 0x7f_ff_ff_ff;
const MAX_FAST_EPOCH_MILLIS = 2_147_483_647_999;

/** The remainder of a safe integer by a positive divisor, in [0, divisor). */
function floorRemainder(value: number, divisor: number): number {
  const remainder = value % divisor;
  return remainder < 0 ? remainder + divisor : remainder;
}

/**
 * ISO-8601 text of a millisecond count since the epoch. `fractions` holds the text of each fraction of a second, with
 * the zone designator when there is one. Counts inside the 32-bit range of seconds are divided without a remainder
 * operation, which is the common case for dates between 1970 and 2038.
 */
function formatTimestampMillis(value: number, fractions: readonly string[]): string {
  let seconds: number;
  let frac: number;
  if (value >= 0 && value <= MAX_FAST_EPOCH_MILLIS) {
    seconds = Math.trunc(value / MILLIS_PER_SECOND);
    frac = value - seconds * MILLIS_PER_SECOND;
  } else {
    frac = floorRemainder(value, MILLIS_PER_SECOND);
    seconds = (value - frac) / MILLIS_PER_SECOND;
  }
  let hourKey: number;
  let secOfHour: number;
  if (seconds >= 0 && seconds <= MAX_INT32_SECONDS) {
    hourKey = Math.trunc(seconds / SECONDS_PER_HOUR);
    secOfHour = seconds - hourKey * SECONDS_PER_HOUR;
  } else {
    secOfHour = floorRemainder(seconds, SECONDS_PER_HOUR);
    hourKey = (seconds - secOfHour) / SECONDS_PER_HOUR;
  }
  const prefix = hourKey === cachedHourKey ? cachedHourPrefix : formatHourPrefix(hourKey);
  return prefix + (MIN_SEC_STRINGS[secOfHour] + fractions[frac]);
}

function formatTimestampMillisUtc(value: number): string {
  return formatTimestampMillis(value, DOT_THREE_DIGITS_Z);
}

function formatTimestampMillisLocal(value: number): string {
  return formatTimestampMillis(value, DOT_THREE_DIGITS);
}

/** Fast ISO-8601 timestamp formatter for safe-integer millis or micros counts since epoch. */
export function formatTimestampNumber(value: number, unit: TimeUnit, adjustedToUtc: boolean): string {
  if (unit === 'millis') {
    return adjustedToUtc ? formatTimestampMillisUtc(value) : formatTimestampMillisLocal(value);
  }
  const zone = adjustedToUtc ? 'Z' : '';
  if (unit === 'micros') {
    let frac = value % MICROS_PER_SECOND;
    if (frac < 0) frac += MICROS_PER_SECOND;
    const seconds = (value - frac) / MICROS_PER_SECOND;
    let secondOfDay = seconds % SECONDS_PER_DAY;
    if (secondOfDay < 0) secondOfDay += SECONDS_PER_DAY;
    const days = (seconds - secondOfDay) / SECONDS_PER_DAY;
    if (frac === 0) return `${formatDatePrefix(days)}${formatClock(secondOfDay)}${zone}`;
    const lo = frac % MILLIS_PER_SECOND;
    const hi = (frac - lo) / MILLIS_PER_SECOND;
    return `${formatDatePrefix(days)}${formatClock(secondOfDay)}.${THREE_DIGITS[hi]}${THREE_DIGITS[lo]}${zone}`;
  }
  return formatTimestamp(BigInt(value), unit, adjustedToUtc);
}

/** ISO-8601 timestamp from an exact integer count of `unit` since the epoch. */
export function formatTimestamp(value: bigint, unit: TimeUnit, adjustedToUtc: boolean): string {
  if (unit !== 'nanos' && value >= MIN_SAFE_BIGINT && value <= MAX_SAFE_BIGINT) {
    return formatTimestampNumber(Number(value), unit, adjustedToUtc);
  }
  const zone = adjustedToUtc ? 'Z' : '';
  const perSecond = BigInt(UNITS_PER_SECOND[unit]);
  const seconds = floorDivide(value, perSecond);
  const fraction = value - seconds * perSecond;
  const days = floorDivide(seconds, BigInt(SECONDS_PER_DAY));
  const secondOfDay = Number(seconds - days * BigInt(SECONDS_PER_DAY));
  return `${formatDate(Number(days))}T${formatClock(secondOfDay)}${formatFraction(fraction, unit)}${zone}`;
}

/** Legacy 12-byte INT96 timestamp: 8-byte little-endian nanoseconds-of-day followed by 4-byte Julian day. */
export function formatInt96Timestamp(bytes: Buffer): string {
  const nanosOfDay = bytes.readBigInt64LE(0);
  const julianDay = BigInt(bytes.readInt32LE(INT96_JULIAN_DAY_OFFSET));
  const totalNanos = (julianDay - JULIAN_EPOCH_DAY) * NANOS_PER_DAY + nanosOfDay;
  if (totalNanos % NANOS_PER_MILLI === 0n) {
    return formatTimestamp(totalNanos / NANOS_PER_MILLI, 'millis', true);
  }
  if (totalNanos % NANOS_PER_MICRO === 0n) {
    return formatTimestamp(totalNanos / NANOS_PER_MICRO, 'micros', true);
  }
  return formatTimestamp(totalNanos, 'nanos', true);
}

/** IEEE 754 binary16 (little-endian 2-byte half-precision float) to IEEE 754 binary64 number. */
export function decodeFloat16(bytes: Buffer): number {
  const bits = bytes.readUInt16LE(0);
  const sign = (bits & FLOAT16_SIGN_MASK) !== 0 ? -1 : 1;
  const exp = (bits >> FLOAT16_EXP_SHIFT) & FLOAT16_EXP_MASK;
  const frac = bits & FLOAT16_FRAC_MASK;
  if (exp === 0) {
    if (frac === 0) return sign < 0 ? -0 : 0;
    return sign * (frac * FLOAT16_SUBNORMAL_SCALE);
  }
  if (exp === FLOAT16_EXP_MASK) {
    return frac === 0 ? (sign < 0 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY) : Number.NaN;
  }
  return sign * 2 ** (exp - FLOAT16_EXP_BIAS) * (1 + frac / FLOAT16_FRAC_SCALE);
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

function bytesReader(
  width: number,
  map: (raw: number | bigint | Buffer) => ColumnValue,
  readSlice?: (page: Buffer, start: number, end: number) => ColumnValue,
  sliceByteLengthExact = false
): ColumnReader {
  return { kind: 'bytes', width, map, readSlice, sliceByteLengthExact };
}

function textOrBinarySlice(page: Buffer, start: number, end: number): ColumnValue {
  const text = page.toString('utf8', start, end);
  if (!text.includes(REPLACEMENT_CHARACTER)) return text;
  const slice = page.subarray(start, end);
  try {
    return UTF8_STRICT.decode(slice);
  } catch {
    return slice.toString('base64');
  }
}

function textOrBinary(): (raw: number | bigint | Buffer) => ColumnValue {
  return (raw) => {
    const bytes = raw as Buffer;
    return decodeUtf8OrNull(bytes) ?? bytes.toString('base64');
  };
}

function strictTextSlice(column: string): (page: Buffer, start: number, end: number) => ColumnValue {
  return (page, start, end) => {
    const text = page.toString('utf8', start, end);
    if (!text.includes(REPLACEMENT_CHARACTER)) return text;
    try {
      return UTF8_STRICT.decode(page.subarray(start, end));
    } catch {
      throw new ParquetFormatError(`Corrupted Parquet file: invalid UTF-8 in text column '${column}'`);
    }
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
      return bytesReader(width, strictText(column), strictTextSlice(column), true);
    case 'none':
      return bytesReader(width, textOrBinary(), textOrBinarySlice);
    case 'bson':
      return bytesReader(width, (raw) => (raw as Buffer).toString('base64'), (page, start, end) => page.toString('base64', start, end));
    case 'decimal':
      validateDecimal(column, annotation);
      return bytesReader(width, (raw) => formatDecimal(signedBigEndian(raw as Buffer, column), annotation.scale));
    case 'uuid':
      return bytesReader(width, (raw) => uuidText(raw as Buffer));
    case 'float16':
      return bytesReader(width, (raw) => decodeFloat16(raw as Buffer));
    default:
      return incompatibleOrUnsupported(column, width > 0 ? ParquetType.FIXED_LEN_BYTE_ARRAY : ParquetType.BYTE_ARRAY, annotation);
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

/** The fast formatter of a timestamp column's safe-integer values; nanosecond counts leave the safe range, so they have none. */
function timestampNumberFormatter(unit: TimeUnit, adjustedToUtc: boolean): ((raw: number) => ColumnValue) | undefined {
  if (unit === 'nanos') return undefined;
  if (unit === 'millis') return adjustedToUtc ? formatTimestampMillisUtc : formatTimestampMillisLocal;
  return (raw) => formatTimestampNumber(raw, unit, adjustedToUtc);
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
        mapNumber: timestampNumberFormatter(annotation.unit, annotation.adjustedToUtc),
      };
    case 'decimal':
      validateDecimal(column, annotation);
      return { kind: 'i64', width: 0, map: (raw) => formatDecimal(raw as bigint, annotation.scale) };
    default:
      return incompatibleOrUnsupported(column, ParquetType.INT64, annotation);
  }
}

/**
 * Chooses how a leaf's values are read. Annotations this engine cannot represent throw
 * ParquetUnsupportedError; an annotation that contradicts the physical type is malformed.
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
    case ParquetType.INT96:
      if (annotation.tag !== 'none') return incompatibleOrUnsupported(column, type, annotation);
      return bytesReader(INT96_BYTES, (raw) => formatInt96Timestamp(raw as Buffer));
    case ParquetType.FLOAT:
    case ParquetType.DOUBLE:
      if (annotation.tag !== 'none') return incompatibleOrUnsupported(column, type, annotation);
      return { kind: type === ParquetType.FLOAT ? 'f32' : 'f64', width: 0, map: null };
    case ParquetType.BYTE_ARRAY:
      if (annotation.tag === 'float16') return incompatible(column, type, annotation);
      return resolveByteArray(column, annotation, 0);
    case ParquetType.FIXED_LEN_BYTE_ARRAY:
      if (typeLength < 1) {
        throw new ParquetFormatError(`Corrupted Parquet metadata: fixed-length column '${column}' has no type_length`);
      }
      if (annotation.tag === 'uuid' && typeLength !== UUID_BYTES) return incompatible(column, type, annotation);
      if (annotation.tag === 'float16' && typeLength !== FLOAT16_BYTES) return incompatible(column, type, annotation);
      return resolveByteArray(column, annotation, typeLength);
    default:
      throw new ParquetUnsupportedError(`Unsupported Parquet physical type ${ParquetType[type] ?? type} in column '${column}'`);
  }
}

/** Exact value of an unsigned 64-bit pattern. */
export function unsignedInteger(signed: bigint): number | string {
  return exactInteger(BigInt.asUintN(UINT64_MODULUS_BITS, signed));
}
