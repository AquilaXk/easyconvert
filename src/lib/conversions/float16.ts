/**
 * IEEE 754-2008 binary16 ("half") conversions. Float to half rounds to nearest, ties to even, handles the
 * subnormal range of half (2^-24 to 2^-14) and overflows to infinity; NaN stays NaN (its payload is truncated to
 * the top ten bits, with the quiet bit set).
 *
 * The 65,536-entry half-to-float lookup table (`getFloat16DecodeTable`) follows `AcademySoftwareFoundation/Imath`
 * (`src/Imath/half.h`, commit `5b39e4699b028b3bdd5b9712be2fdc24ab0efcb1`,
 * SHA-256 `381a0b232bec740db2fa3a8855381deaf1115dbdc65e3bbf56d50f0a3b4d134d`, BSD-3-Clause):
 *
 * Copyright Contributors to the OpenEXR Project. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification, are permitted provided that the
 * following conditions are met:
 * 1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following
 *    disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the
 *    following disclaimer in the documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote
 *    products derived from this software without specific prior written permission.
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES,
 * INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 * WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE
 * USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
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

const HALF_TABLE_SIZE = 65_536;
const HALF_WORD_MASK = 0xffff;
const HALF_EXPONENT_MASK = 0x1f;
const HALF_MANTISSA_MASK = 0x03ff;
const HALF_IMPLICIT_BIT = 0x0400;
const SINGLE_INFINITY_BITS = 0x7f800000;
const SINGLE_QUIET_NAN_BITS = 0x7fc00000;

let halfDecodeTable: Float32Array | null = null;

/** Shared 65,536-entry IEEE 754 binary16-to-binary32 lookup table (`±0`, subnormals, normals, `±Infinity`, `NaN`). */
export function getFloat16DecodeTable(): Float32Array {
  if (halfDecodeTable !== null) return halfDecodeTable;
  const table = new Float32Array(HALF_TABLE_SIZE);
  const outBits = new Uint32Array(table.buffer);
  const expBiasDelta = SINGLE_EXPONENT_BIAS - HALF_EXPONENT_BIAS;
  for (let h = 0; h < HALF_TABLE_SIZE; h++) {
    const signBit = (h & HALF_SIGN) << 16;
    const exp = (h >>> 10) & HALF_EXPONENT_MASK;
    const mant = h & HALF_MANTISSA_MASK;
    if (exp === 0) {
      if (mant === 0) {
        outBits[h] = signBit >>> 0;
      } else {
        let m = mant;
        let e = expBiasDelta + 1;
        while ((m & HALF_IMPLICIT_BIT) === 0) {
          m <<= 1;
          e -= 1;
        }
        outBits[h] = (signBit | (e << 23) | ((m & HALF_MANTISSA_MASK) << MANTISSA_SHIFT)) >>> 0;
      }
    } else if (exp === HALF_EXPONENT_MASK) {
      outBits[h] = (mant === 0 ? signBit | SINGLE_INFINITY_BITS : signBit | SINGLE_QUIET_NAN_BITS | (mant << MANTISSA_SHIFT)) >>> 0;
    } else {
      outBits[h] = (signBit | ((exp + expBiasDelta) << 23) | (mant << MANTISSA_SHIFT)) >>> 0;
    }
  }
  halfDecodeTable = table;
  return table;
}

/** Converts half bits to the number they stand for. */
export function float16ToFloat32(h: number): number {
  return getFloat16DecodeTable()[h & HALF_WORD_MASK];
}
