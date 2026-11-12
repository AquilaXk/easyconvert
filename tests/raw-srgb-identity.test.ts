import { describe, expect, it } from 'vitest';
import { applyMatrixAndSrgbEncode, type Matrix3x3 } from '../src/lib/conversions/raw-srgb';

/** The IEC 61966-2-1 curve on a 16-bit level, written out here instead of read from the code under test. */
function encoded(level: number): number {
  const linear = level / 65535;
  const curve = linear <= 0.0031308 ? 12.92 * linear : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
  return Math.round(curve * 65535);
}

describe('applyMatrixAndSrgbEncode with the identity matrix', () => {
  const identity: Matrix3x3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

  it('gives the curve of every sample, as the full product does', () => {
    const samples = new Uint16Array(3 * 5000);
    let state = 7;
    for (let i = 0; i < samples.length; i += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      samples[i] = state >>> 16;
    }
    samples.set([0, 0, 0, 65535, 65535, 65535, 1, 2, 3], 0);
    const expected = Uint16Array.from(samples, (level) => encoded(level));
    applyMatrixAndSrgbEncode(samples, identity);
    expect(Array.from(samples)).toEqual(Array.from(expected));
  });

  it('leaves the samples past the last whole pixel as they were', () => {
    const samples = Uint16Array.of(100, 200, 300, 400, 500);
    applyMatrixAndSrgbEncode(samples, identity);
    expect(samples[3]).toBe(400);
    expect(samples[4]).toBe(500);
    expect(samples[0]).toBe(encoded(100));
  });

  it('still mixes the channels for any other matrix', () => {
    const samples = Uint16Array.of(1000, 2000, 3000);
    applyMatrixAndSrgbEncode(samples, [0, 1, 0, 0, 0, 1, 1, 0, 0]);
    expect(Array.from(samples)).toEqual([encoded(2000), encoded(3000), encoded(1000)]);
  });
});
