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

describe('Shewchuk Exact Robust Geometric Predicates', () => {
  describe('Exact Arithmetic Foundations', () => {
    it('computes exact twoSum and twoDiff without precision loss', () => {
      const a = 1.0;
      const b = 1e-16;
      const [sum, sumErr] = twoSum(a, b);
      expect(sum + sumErr).toBe(a + b);
      expect(sumErr).not.toBe(0);

      const [diff, diffErr] = twoDiff(a, b);
      expect(diff + diffErr).toBe(a - b);
    });

    it('computes exact twoProduct using Veltkamp-Dekker splitting', () => {
      const a = 1e8 + 0.123456789;
      const b = 1e8 - 0.987654321;
      const [prod, prodErr] = twoProduct(a, b);
      expect(Number.isFinite(prod)).toBe(true);
      expect(Number.isFinite(prodErr)).toBe(true);
      const [hi, lo] = split(a);
      expect(hi + lo).toBe(a);
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
