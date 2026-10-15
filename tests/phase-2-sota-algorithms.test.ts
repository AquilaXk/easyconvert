import { describe, it, expect } from 'vitest';
import { oracleTest } from './helpers/oracle-test';
import { xmlWellFormed, xpathString } from './helpers/xml-oracle';
import {
  evaluateSurfaceCurvature,
  tessellateBSplineSurfaceAdaptive,
  tessellateTrimmedFaceCDT,
  BSplineSurface,
} from '../src/lib/conversions/cad-nurbs';
import {
  quantizeXiaolinWu,
  applyBlueNoiseDither,
} from '../src/lib/conversions/quantize';
import {
  hwpEquationToMathML,
  hwpEquationToLaTeX,
  buildHwpCompoundFile,
  parseHwpDocument,
} from '../src/lib/conversions/hwp';

describe('Phase 2: Core Engine SOTA Algorithms & High-Fidelity Domain Engines (#66)', () => {
  // =========================================================================
  // 3. CAD NURBS Curvature-Adaptive Subdivision & 2D CDT Face Trimming
  // =========================================================================
  describe('3. CAD NURBS Curvature & 2D CDT Face Trimming', () => {
    const flatPlaneSurface: BSplineSurface = {
      uDegree: 1,
      vDegree: 1,
      controlPoints: [
        [
          { x: 0, y: 0, z: 0 },
          { x: 0, y: 10, z: 0 },
        ],
        [
          { x: 10, y: 0, z: 0 },
          { x: 10, y: 10, z: 0 },
        ],
      ],
      uKnots: [0, 0, 1, 1],
      vKnots: [0, 0, 1, 1],
    };

    const curvedParaboloidSurface: BSplineSurface = {
      uDegree: 2,
      vDegree: 2,
      controlPoints: [
        [
          { x: 0, y: 0, z: 0 },
          { x: 0, y: 5, z: 5 },
          { x: 0, y: 10, z: 0 },
        ],
        [
          { x: 5, y: 0, z: 5 },
          { x: 5, y: 5, z: 15 },
          { x: 5, y: 10, z: 5 },
        ],
        [
          { x: 10, y: 0, z: 0 },
          { x: 10, y: 5, z: 5 },
          { x: 10, y: 10, z: 0 },
        ],
      ],
      uKnots: [0, 0, 0, 1, 1, 1],
      vKnots: [0, 0, 0, 1, 1, 1],
    };

    it('evaluates zero Gaussian and Mean curvature on flat planar surface', () => {
      const curv = evaluateSurfaceCurvature(flatPlaneSurface, 0.5, 0.5);
      expect(Math.abs(curv.gaussianCurvature)).toBeLessThan(1e-5);
      expect(Math.abs(curv.meanCurvature)).toBeLessThan(1e-5);
      expect(curv.normal.z).toBeCloseTo(1, 4);
    });

    it('evaluates non-zero Gaussian curvature on curved bicubic paraboloid surface', () => {
      const curv = evaluateSurfaceCurvature(curvedParaboloidSurface, 0.5, 0.5);
      expect(curv.maxPrincipalCurvature).toBeGreaterThan(0.01);
      expect(Math.abs(curv.normal.z)).toBeGreaterThan(0.5);
    });

    it('tessellateBSplineSurfaceAdaptive adapts grid density based on curvature deflection', () => {
      const flatMesh = tessellateBSplineSurfaceAdaptive(flatPlaneSurface, { chordalTolerance: 0.01 });
      const curvedMesh = tessellateBSplineSurfaceAdaptive(curvedParaboloidSurface, { chordalTolerance: 0.005 });

      expect(flatMesh.vertices.length).toBeGreaterThanOrEqual(9);
      expect(curvedMesh.vertices.length).toBeGreaterThan(flatMesh.vertices.length);
      expect(curvedMesh.faces.length).toBeGreaterThan(0);
    });

    it('tessellateTrimmedFaceCDT triangulates trimmed face boundary loop with analytical normals', () => {
      // Outer loop in (u, v) parameter space: triangle (0.1, 0.1) -> (0.9, 0.1) -> (0.5, 0.9)
      const outerLoop = [
        { u: 0.1, v: 0.1 },
        { u: 0.9, v: 0.1 },
        { u: 0.5, v: 0.9 },
      ];

      const mesh = tessellateTrimmedFaceCDT({
        surface: flatPlaneSurface,
        outerLoop,
      });

      expect(mesh.vertices.length).toBe(3);
      expect(mesh.faces.length).toBe(1);
      expect(mesh.faces[0]).toEqual([0, 1, 2]);
      expect(mesh.normals[0][2]).toBeCloseTo(1, 4);
    });
  });

  // =========================================================================
  // 4. Xiaolin Wu 3D Moment Quantization & Blue Noise Dithering
  // =========================================================================
  describe('4. Xiaolin Wu 3D Moment Quantization & Blue Noise Dithering', () => {
    it('quantizes 24-bit RGB buffer with Xiaolin Wu minimum-variance algorithm', () => {
      // 8x8 gradient image with 64 distinct colors
      const width = 8;
      const height = 8;
      const rgb = Buffer.alloc(width * height * 3);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * 3;
          rgb[idx] = x * 32;
          rgb[idx + 1] = y * 32;
          rgb[idx + 2] = (x + y) * 16;
        }
      }

      const res = quantizeXiaolinWu(rgb, width, height, 8);
      expect(res.palette.length).toBeLessThanOrEqual(8);
      expect(res.palette.length).toBeGreaterThanOrEqual(2);
      expect(res.indexedPixels.length).toBe(64);
      expect(res.paletteBuffer.length).toBe(res.palette.length * 3);

      // Verify all indices are valid
      for (let i = 0; i < 64; i++) {
        expect(res.indexedPixels[i]).toBeLessThan(res.palette.length);
        expect(res.indexedPixels[i]).toBeGreaterThanOrEqual(0);
      }
    });

    it('applies isotropic void-and-cluster Blue Noise dithering', () => {
      const width = 16;
      const height = 16;
      const rgb = Buffer.alloc(width * height * 3, 128); // Mid-gray

      const palette = [
        { r: 0, g: 0, b: 0 },
        { r: 255, g: 255, b: 255 },
      ];

      const dithered = applyBlueNoiseDither(rgb, width, height, palette, 1.0);
      expect(dithered.length).toBe(width * height);

      // Mid-gray with blue noise dither must produce both black (0) and white (1) pixels
      const counts = [0, 0];
      for (let i = 0; i < dithered.length; i++) {
        counts[dithered[i]]++;
      }
      expect(counts[0]).toBeGreaterThan(0);
      expect(counts[1]).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 5. HWP 5.0 CFBF EqEdit MathML / LaTeX Transpilation
  // =========================================================================
  describe('5. HWP 5.0 CFBF EqEdit MathML / LaTeX Transpilation', () => {
    it('transpiles HWP fraction syntax {A} over {B} to MathML and LaTeX', () => {
      const script = '{d y} over {d x}';
      const mathml = hwpEquationToMathML(script);
      const latex = hwpEquationToLaTeX(script);

      expect(mathml).toContain('<mfrac>');
      expect(mathml).toContain('<mrow>');
      expect(mathml).toContain('d');
      expect(mathml).toContain('y');
      expect(mathml).toContain('x');
      expect(latex).toBe('\\frac{d y}{d x}');
    });

    it('transpiles HWP square roots and nth roots', () => {
      const sqrtScript = 'sqrt {x + 1}';
      expect(hwpEquationToMathML(sqrtScript)).toContain('<msqrt>');
      expect(hwpEquationToLaTeX(sqrtScript)).toBe('\\sqrt{x + 1}');

      const rootScript = 'root {3} of {x^2}';
      expect(hwpEquationToMathML(rootScript)).toContain('<mroot>');
      expect(hwpEquationToLaTeX(rootScript)).toBe('\\sqrt[3]{x^2}');
    });

    oracleTest('transpiles HWP big operators and Greek symbols', ['xmllint'], () => {
      const sumScript = 'sum_{i=1}^{n} {alpha + beta}';
      const mathml = hwpEquationToMathML(sumScript);
      const latex = hwpEquationToLaTeX(sumScript);

      // LaTeX: the summation with its limits, then the Greek letters as control sequences.
      expect(latex).toBe('\\sum_{i=1}^{n} {\\alpha + \\beta}');

      // MathML, read with XPath: well-formed, and the structure of a sum with limits (MathML 3, 3.4.5 munderover:
      // base, underscript, overscript) followed by the braced group alpha + beta (one row of three, no stray
      // spacing operators between them).
      expect(xmlWellFormed(mathml).ok).toBe(true);
      expect(xpathString(mathml, 'name(/math/*[1])')).toBe('munderover');
      expect(xpathString(mathml, 'string(/math/munderover/*[1])')).toBe('∑');
      expect(xpathString(mathml, 'string(/math/munderover/*[2])')).toBe('i=1');
      expect(xpathString(mathml, 'string(/math/munderover/*[3])')).toBe('n');
      expect(xpathString(mathml, 'count(/math/*)')).toBe('2');
      expect(xpathString(mathml, 'name(/math/*[2])')).toBe('mrow');
      expect([1, 2, 3].map((position) => xpathString(mathml, `string(/math/mrow/*[${position}])`))).toEqual(['α', '+', 'β']);
    });

    it('serializes and parses HWP 5.0 CFBF document with embedded EQEDIT records', () => {
      const eqScript = '{a} over {b} + sqrt {c}';
      const hwpBuf = buildHwpCompoundFile({
        paragraphs: [{ text: 'Calculus and Analysis Section' }],
        equations: [eqScript],
        compressed: true,
      });

      const parsed = parseHwpDocument(hwpBuf);
      expect(parsed.paragraphs.length).toBeGreaterThanOrEqual(1);
      expect(parsed.equations).toBeDefined();
      expect(parsed.equations?.length).toBe(1);
      expect(parsed.equations![0].script).toBe(eqScript);
      expect(parsed.equations![0].mathml).toContain('<mfrac>');
      expect(parsed.equations![0].latex).toContain('\\frac{a}{b}');
    });
  });
});
