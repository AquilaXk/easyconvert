import { describe, it, expect } from 'vitest';
import {
  coxDeBoorBasis,
  coxDeBoorBasisDerivative,
  evaluateBSplineCurve,
  tessellateSvgArc,
  BSplineCurve,
} from '../src/lib/conversions/cad-nurbs';

describe('CAD curve mathematics (de Boor-Cox basis, NURBS curves, SVG arcs)', () => {
  describe('Mathematical de Boor-Cox Basis Algorithm', () => {
    it('satisfies partition of unity: sum of basis functions equals 1.0', () => {
      // Clamped cubic B-spline knot vector with 4 control points (n=3, p=3, m=7)
      const knots = [0, 0, 0, 0, 1, 1, 1, 1];
      const p = 3;
      const n = 3;

      const testUValues = [0.0, 0.25, 0.5, 0.75, 1.0];
      for (const u of testUValues) {
        let sum = 0.0;
        for (let i = 0; i <= n; i++) {
          const val = coxDeBoorBasis(i, p, u, knots);
          expect(val).toBeGreaterThanOrEqual(0.0);
          sum += val;
        }
        expect(sum).toBeCloseTo(1.0, 8);
      }
    });

    it('correctly calculates basis function derivatives N\'_{i,p}(u)', () => {
      const knots = [0, 0, 0, 1, 2, 2, 2]; // Quadratic B-spline
      const p = 2;
      const u = 0.5;

      // Numerical finite difference comparison
      const eps = 1e-6;
      for (let i = 0; i <= 3; i++) {
        const analytical = coxDeBoorBasisDerivative(i, p, u, knots);
        const numerical = (coxDeBoorBasis(i, p, u + eps, knots) - coxDeBoorBasis(i, p, u - eps, knots)) / (2 * eps);
        expect(analytical).toBeCloseTo(numerical, 4);
      }
    });
  });

  describe('B-Spline & NURBS Curve Evaluation', () => {
    it('evaluates the exact rational quadratic quarter circle: every point lies on the unit circle', () => {
      // The classic NURBS quarter circle (The NURBS Book, 7.3): control points on the square corners, middle weight cos(45 deg).
      const quarter: BSplineCurve = {
        degree: 2,
        controlPoints: [{ x: 1, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }],
        weights: [1, Math.SQRT1_2, 1],
        knots: [0, 0, 0, 1, 1, 1],
      };
      for (const u of [0, 0.1, 0.25, 0.5, 0.8, 1]) {
        const point = evaluateBSplineCurve(quarter, u);
        expect(Math.hypot(point.x, point.y)).toBeCloseTo(1, 12);
        expect(point.z).toBe(0);
      }
      expect(evaluateBSplineCurve(quarter, 0).x).toBeCloseTo(1, 12);
      expect(evaluateBSplineCurve(quarter, 1).y).toBeCloseTo(1, 12);
    });

    it('refuses a knot vector no curve can be evaluated on instead of returning a number', () => {
      const broken: BSplineCurve = {
        degree: 2,
        controlPoints: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 2, y: 0, z: 0 }],
        knots: [0, 0, 1, 1],
      };
      expect(() => evaluateBSplineCurve(broken, 0.5)).toThrow(/knots, 6 needed/);
    });
  });

  describe('SVG elliptical arcs', () => {
    it('accurately tessellates SVG elliptical arcs using W3C endpoint-to-center parameterization', () => {
      // 90-degree circular arc from (10, 0) to (0, 10) with radius 10
      const arcPts = tessellateSvgArc(10, 0, 10, 10, 0, 0, 1, 0, 10);
      expect(arcPts.length).toBeGreaterThan(2);

      // Verify that intermediate points lie on the circle x^2 + y^2 = 100
      for (const pt of arcPts) {
        const radius = Math.sqrt(pt.x * pt.x + pt.y * pt.y);
        expect(radius).toBeCloseTo(10, 1);
      }

      // Final point must match (0, 10)
      const last = arcPts[arcPts.length - 1];
      expect(last.x).toBeCloseTo(0, 1);
      expect(last.y).toBeCloseTo(10, 1);
    });
  });
});
