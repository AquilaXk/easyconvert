import { describe, it, expect } from 'vitest';
import {
  orient2dExact,
  orient2dPoints,
  incircleExact,
  incirclePoints,
  robustSegmentsIntersect,
  twoSum,
  twoDiff,
  twoProduct,
  split,
} from '../src/lib/conversions/cad-predicates';

/** The exact value of a double as a fraction n / 2^1074, so sums and products of doubles compare without rounding. */
const EXACT_SHIFT = 1074n;
function exact(x: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  const sign = bits >> 63n ? -1n : 1n;
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  const mantissa = exponent === 0 ? fraction : fraction | (1n << 52n);
  const power = BigInt(exponent === 0 ? 1 : exponent) - 1075n + EXACT_SHIFT;
  return sign * (mantissa << power);
}

describe('Shewchuk Exact Robust Geometric Predicates', () => {
  describe('Exact Arithmetic Foundations', () => {
    it('computes exact twoSum and twoDiff without precision loss', () => {
      // Pairs where the rounded result differs from the first operand (0.1 + 0.2 is 0.30000000000000004) and a pair where it equals it (1 + 1e-16 is 1).
      const pairs: Array<[number, number]> = [
        [1.0, 1e-16],
        [0.1, 0.2],
        [1e16, 1.5],
        [-3.3, 1.1],
      ];
      for (const [a, b] of pairs) {
        const [sum, sumErr] = twoSum(a, b);
        // The leading term is the IEEE 754 rounded sum, which the platform computes independently of the module; the pair carries the rest exactly.
        expect(sum).toBe(a + b);
        expect(exact(sum) + exact(sumErr)).toBe(exact(a) + exact(b));

        const [diff, diffErr] = twoDiff(a, b);
        expect(diff).toBe(a - b);
        expect(exact(diff) + exact(diffErr)).toBe(exact(a) - exact(b));
      }
      // Both errors are non-zero where the rounding lost bits.
      expect(twoSum(1.0, 1e-16)[1]).not.toBe(0);
      expect(twoDiff(1.0, 1e-16)[1]).not.toBe(0);
      expect(twoSum(0.1, 0.2)[0]).not.toBe(0.1);
      expect(twoSum(0.1, 0.2)[1]).not.toBe(0);
    });

    it('computes exact twoProduct using Veltkamp-Dekker splitting', () => {
      const a = 1e8 + 0.123456789;
      const b = 1e8 - 0.987654321;
      const [prod, prodErr] = twoProduct(a, b);
      // prod + prodErr equals a * b exactly; the product of two fractions over 2^1074 is over 2^2148.
      expect((exact(prod) + exact(prodErr)) << EXACT_SHIFT).toBe(exact(a) * exact(b));
      expect(prodErr).not.toBe(0);
      const [hi, lo] = split(a);
      expect(exact(hi) + exact(lo)).toBe(exact(a));
      // Each half fits in 26 bits of mantissa, so every product of the halves is exact in a double. A split that returns [0, a] fails on lo * lo,
      // because a has 53 bits and its square does not fit.
      expect(exact(hi * hi) << EXACT_SHIFT).toBe(exact(hi) * exact(hi));
      expect(exact(lo * lo) << EXACT_SHIFT).toBe(exact(lo) * exact(lo));
      expect(exact(hi * lo) << EXACT_SHIFT).toBe(exact(hi) * exact(lo));
      expect(hi).not.toBe(0);
      expect(lo).not.toBe(0);
    });
  });

  describe('Shewchuk orient2dExact', () => {
    it('accurately resolves orientation on standard CCW, CW, and collinear points', () => {
      const ccw = orient2dExact(0, 0, 1, 0, 0, 1);
      expect(ccw).toBeGreaterThan(0);

      const cw = orient2dExact(0, 0, 0, 1, 1, 0);
      expect(cw).toBeLessThan(0);

      const col = orient2dExact(0, 0, 1, 1, 2, 2);
      expect(col).toBe(0);
    });

    it('resolves infamous Shewchuk collinear perturbation where naive float det flips sign or errs', () => {
      const eps = 2 ** -43;
      const ax = 0.5 + eps;
      const ay = 0.5 + eps;
      const bx = 12.0;
      const by = 12.0;
      const cx = 24.0 - eps;
      const cy = 24.0 - eps;

      const sign = orient2dExact(ax, ay, bx, by, cx, cy);
      expect(sign).toBe(0);

      const ccwSign = orient2dExact(ax, ay, bx, by, cx, cy + 1e-13);
      expect(ccwSign).toBeGreaterThan(0);

      const cwSign = orient2dExact(ax, ay, bx, by, cx, cy - 1e-13);
      expect(cwSign).toBeLessThan(0);
    });
  });

  describe('Shewchuk incircleExact', () => {
    it('detects point inside, outside, and on circumcircle', () => {
      const inside = incircleExact(1, 0, 0, 1, -1, 0, 0, 0);
      expect(inside).toBeGreaterThan(0);

      const outside = incircleExact(1, 0, 0, 1, -1, 0, 2, 2);
      expect(outside).toBeLessThan(0);

      const onCircle = incircleExact(1, 0, 0, 1, -1, 0, 0, -1);
      expect(onCircle).toBe(0);
    });
  });

  describe('robustSegmentsIntersect', () => {
    it('detects proper segment intersections', () => {
      const p1 = { u: 0, v: 0 };
      const p2 = { u: 2, v: 2 };
      const p3 = { u: 0, v: 2 };
      const p4 = { u: 2, v: 0 };

      expect(robustSegmentsIntersect(p1, p2, p3, p4)).toBe(true);

      const p5 = { u: 0, v: 1 };
      const p6 = { u: 2, v: 3 };
      expect(robustSegmentsIntersect(p1, p2, p5, p6)).toBe(false);
    });

    it('handles shared endpoints without false positive intersection', () => {
      const p1 = { u: 0, v: 0 };
      const p2 = { u: 1, v: 0 };
      const p3 = { u: 1, v: 0 };
      const p4 = { u: 1, v: 1 };

      expect(robustSegmentsIntersect(p1, p2, p3, p4, true)).toBe(false);
      expect(robustSegmentsIntersect(p1, p2, p3, p4, false)).toBe(true);
    });

    it('detects collinear overlapping segments', () => {
      const p1 = { u: 0, v: 0 };
      const p2 = { u: 3, v: 0 };
      const p3 = { u: 1, v: 0 };
      const p4 = { u: 2, v: 0 };

      expect(robustSegmentsIntersect(p1, p2, p3, p4)).toBe(true);
    });
  });
});
