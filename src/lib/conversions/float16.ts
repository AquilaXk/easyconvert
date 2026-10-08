/**
 * IEEE 754-2008 binary16 ("half") conversions. Float to half rounds to nearest, ties to even, handles the
 * subnormal range of half (2^-24 to 2^-14) and overflows to infinity; NaN stays NaN (its payload is truncated to
 * the top ten bits, with the quiet bit set).
 */

const HALF_SIGN = 0x8000;
const HALF_INFINITY = 0x7c00;
const HALF_QUIET_NAN = 0x0200;
const HALF_EXPONENT_BIAS = 15;
const SINGLE_EXPONENT_BIAS = 127;
/** Mantissa bits dropped when a normal single becomes a normal half (23 - 10). */
const MANTISSA_SHIFT = 13;
const SINGLE_MANTISSA_MASK = 0x7fffff;
const SINGLE_IMPLICIT_ONE = 0x800000;
const HALF_MIN_NORMAL_EXPONENT = -14;
const HALF_MAX_EXPONENT = 15;
/** A single below 2^-25 is under half of the smallest half subnormal (2^-24) and rounds to zero. */
const SUBNORMAL_SHIFT_LIMIT = 24;
const HALF_SUBNORMAL_SHIFT_BASE = -1;

/** Half bits for the IEEE 754 binary32 bit pattern `bits` (an unsigned 32-bit integer). */
export function float32BitsToFloat16(bits: number): number {
  const sign = (bits >>> 16) & HALF_SIGN;
  const exponentField = (bits >>> 23) & 0xff;
  const mantissa = bits & SINGLE_MANTISSA_MASK;
  if (exponentField === 0xff) {
    return mantissa === 0 ? sign | HALF_INFINITY : sign | HALF_INFINITY | HALF_QUIET_NAN | (mantissa >>> MANTISSA_SHIFT);
  }
  // A single subnormal (field 0) is below 2^-126, far under the smallest half subnormal.
  if (exponentField === 0) return sign;
  const exponent = exponentField - SINGLE_EXPONENT_BIAS;
  if (exponent > HALF_MAX_EXPONENT) return sign | HALF_INFINITY;
  if (exponent >= HALF_MIN_NORMAL_EXPONENT) {
    let half = ((exponent + HALF_EXPONENT_BIAS) << 10) | (mantissa >>> MANTISSA_SHIFT);
    const remainder = mantissa & ((1 << MANTISSA_SHIFT) - 1);
    const halfway = 1 << (MANTISSA_SHIFT - 1);
    // A carry out of the mantissa raises the exponent; from the largest finite half it reaches infinity, as it should.
    if (remainder > halfway || (remainder === halfway && (half & 1) === 1)) half += 1;
    return sign | half;
  }
  // Subnormal half: the 24-bit significand scaled so that one unit is 2^-24.
  const shift = HALF_SUBNORMAL_SHIFT_BASE - exponent;
  if (shift > SUBNORMAL_SHIFT_LIMIT) return sign;
  const significand = mantissa | SINGLE_IMPLICIT_ONE;
  let half = significand >>> shift;
  const remainder = significand & ((1 << shift) - 1);
  const halfway = 1 << (shift - 1);
  if (remainder > halfway || (remainder === halfway && (half & 1) === 1)) half += 1;
  return sign | half;
}

const scratchSingle = new Float32Array(1);
const scratchBits = new Uint32Array(scratchSingle.buffer);

/** Converts a number to the nearest half (ties to even) and returns its 16 bits. */
export function float32ToFloat16(value: number): number {
  scratchSingle[0] = value;
  return float32BitsToFloat16(scratchBits[0]);
}

/** Converts half bits to the number they stand for. */
export function float16ToFloat32(h: number): number {
  const sign = (h >> 15) & 0x1;
  const exp = (h >> 10) & 0x1f;
  const mant = h & 0x3ff;
  if (exp === 0) {
    if (mant === 0) return sign ? -0 : 0;
    return (sign ? -1 : 1) * Math.pow(2, -14) * (mant / 1024);
  }
  if (exp === 31) {
    if (mant) return Number.NaN;
    return sign ? -Infinity : Infinity;
  }
  return (sign ? -1 : 1) * Math.pow(2, exp - 15) * (1 + mant / 1024);
}
