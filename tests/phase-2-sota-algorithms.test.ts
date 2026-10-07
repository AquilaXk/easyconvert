import { describe, it, expect } from 'vitest';
import { oracleTest } from './helpers/oracle-test';
import { xmlWellFormed, xpathString } from './helpers/xml-oracle';
import {
  parseToUnicodeCMap,
  extractPdfFontCMaps,
  recursiveXyCut,
  extractStructuredTextFromPdf,
  PdfTextBlock,
} from '../src/lib/conversions/pdf-utils';
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
  // 1. PDF ISO 32000-1 /ToUnicode CMap Parsing
  // =========================================================================
  describe('1. PDF ISO 32000-1 /ToUnicode CMap Parsing', () => {
    it('parses beginbfchar mapping single and multi-character Unicode glyphs', () => {
      const cmapData = `
/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CMapName /Custom-ToUnicode def
/CMapType 2 def
3 beginbfchar
  <0001> <0041>
  <0002> <0042>
  <0003> <00660069>
endbfchar
endcmap
`;
      const cmap = parseToUnicodeCMap(cmapData);
      expect(cmap.name).toBe('Custom-ToUnicode');
      expect(cmap.charMap.get(1)).toBe('A');
      expect(cmap.charMap.get(2)).toBe('B');
      expect(cmap.charMap.get(3)).toBe('fi'); // ligature
    });

    it('parses beginbfrange sequential range and bracketed array forms', () => {
      const cmapData = `
begincmap
2 beginbfrange
  <0010> <0013> <0061>
  <0020> <0022> [ <0058> <0059> <005A> ]
endbfrange
endcmap
`;
      const cmap = parseToUnicodeCMap(cmapData);
      // Sequential: 0x10 -> 'a', 0x11 -> 'b', 0x12 -> 'c', 0x13 -> 'd'
      expect(cmap.charMap.get(0x10)).toBe('a');
      expect(cmap.charMap.get(0x11)).toBe('b');
      expect(cmap.charMap.get(0x12)).toBe('c');
      expect(cmap.charMap.get(0x13)).toBe('d');

      // Array form: 0x20 -> 'X', 0x21 -> 'Y', 0x22 -> 'Z'
      expect(cmap.charMap.get(0x20)).toBe('X');
      expect(cmap.charMap.get(0x21)).toBe('Y');
      expect(cmap.charMap.get(0x22)).toBe('Z');
    });

    it('parses begincidchar mappings for CID-keyed fonts', () => {
      const cmapData = `
begincmap
2 begincidchar
  <0064> 100
  <0065> 101
endcidchar
endcmap
`;
      const cmap = parseToUnicodeCMap(cmapData);
      expect(cmap.charMap.get(0x64)).toBe('d'); // ASCII 100
      expect(cmap.charMap.get(0x65)).toBe('e'); // ASCII 101
    });
  });

  // =========================================================================
  // 2. Recursive XY-Cut++ Reading Order Layout Segmentation
  // =========================================================================
  describe('2. Recursive XY-Cut++ Reading Order Layout Segmentation', () => {
    it('orders multi-column document blocks column-by-column rather than interleaved lines', () => {
      // Simulate two-column layout on 600x800 page
      // Left Column (x ~ 50, width ~ 200)
      const leftCol1: PdfTextBlock = { text: 'Left Col Line 1', x: 50, y: 700, width: 180, height: 12 };
      const leftCol2: PdfTextBlock = { text: 'Left Col Line 2', x: 50, y: 650, width: 180, height: 12 };
      const leftCol3: PdfTextBlock = { text: 'Left Col Line 3', x: 50, y: 600, width: 180, height: 12 };

      // Right Column (x ~ 350, width ~ 200, gap = 100 points)
      const rightCol1: PdfTextBlock = { text: 'Right Col Line 1', x: 350, y: 700, width: 180, height: 12 };
      const rightCol2: PdfTextBlock = { text: 'Right Col Line 2', x: 350, y: 650, width: 180, height: 12 };
      const rightCol3: PdfTextBlock = { text: 'Right Col Line 3', x: 350, y: 600, width: 180, height: 12 };

      // Input blocks in arbitrary shuffled order
      const shuffled = [rightCol2, leftCol3, rightCol1, leftCol1, rightCol3, leftCol2];

      const ordered = recursiveXyCut(shuffled, { minGapX: 30, minGapY: 10 });
      const orderedTexts = ordered.map((b) => b.text);

      // Must read entire left column first, then entire right column
      expect(orderedTexts).toEqual([
        'Left Col Line 1',
        'Left Col Line 2',
        'Left Col Line 3',
        'Right Col Line 1',
        'Right Col Line 2',
        'Right Col Line 3',
      ]);
    });

    it('correctly splits paragraphs with horizontal projection profile valleys', () => {
      const p1Line1: PdfTextBlock = { text: 'P1 Line 1', x: 50, y: 750, width: 200, height: 12 };
      const p1Line2: PdfTextBlock = { text: 'P1 Line 2', x: 50, y: 735, width: 200, height: 12 };

      // Large paragraph gap (y from 735 down to 680)
      const p2Line1: PdfTextBlock = { text: 'P2 Line 1', x: 50, y: 680, width: 200, height: 12 };
      const p2Line2: PdfTextBlock = { text: 'P2 Line 2', x: 50, y: 665, width: 200, height: 12 };

      const ordered = recursiveXyCut([p2Line2, p1Line1, p2Line1, p1Line2]);
      expect(ordered.map((b) => b.text)).toEqual([
        'P1 Line 1',
        'P1 Line 2',
        'P2 Line 1',
        'P2 Line 2',
      ]);
    });
  });

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
      // base, underscript, overscript) followed by alpha + beta.
      expect(xmlWellFormed(mathml).ok).toBe(true);
      expect(xpathString(mathml, 'name(/math/*[1])')).toBe('munderover');
      expect(xpathString(mathml, 'string(/math/munderover/*[1])')).toBe('∑');
      expect(xpathString(mathml, 'string(/math/munderover/*[2])')).toBe('i=1');
      expect(xpathString(mathml, 'string(/math/munderover/*[3])')).toBe('n');
      // After the limits: alpha, plus, beta, with no stray spacing operators between them.
      expect(xpathString(mathml, 'count(/math/*)')).toBe('4');
      expect([2, 3, 4].map((position) => xpathString(mathml, `string(/math/*[${position}])`))).toEqual(['α', '+', 'β']);
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
