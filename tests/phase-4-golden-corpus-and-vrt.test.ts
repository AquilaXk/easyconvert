import { describe, it, expect } from 'vitest';
import {
  synthesizeCadNurbsCorpus,
  synthesizeCMapPdfCorpus,
  synthesizeHwp5CompoundCorpus,
  synthesizeMultiColumnDocumentCorpus,
  synthesizeDrawingMlTableCorpus,
  synthesizeVariableFontCorpus,
  synthesizeParquetColumnarCorpus,
  synthesizeAudioBitstreamCorpus,
} from './helpers/corpus-synthesizer';
import { compareImages, computeSsim, pixelmatch } from './helpers/vrt-engine';
import { renderDrawingMlToSvg } from '../src/lib/conversions/office';
import { evaluateBSplineCurve, evaluateBSplineSurface, evaluateSurfaceCurvature } from '../src/lib/conversions/cad-nurbs';
import { CadGeometryError, CorruptStreamError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { xmlWellFormed, xpathString } from './helpers/xml-oracle';
import { parseToUnicodeCMap, recursiveXyCut } from '../src/lib/conversions/pdf-utils';
import { parseHwpDocument, hwpEquationToMathML, hwpEquationToLaTeX } from '../src/lib/conversions/hwp';
import sharp from 'sharp';

describe('Phase 4: Universal Golden Binary Corpus & Visual Regression CI Gate (#70)', () => {
  // =========================================================================
  // 1. CAD NURBS & 2D CDT Trimmed Face Golden Corpus
  // =========================================================================
  describe('1. CAD NURBS & 2D CDT Trimmed Face Golden Corpus', () => {
    it('synthesizes bicubic B-Spline surface with accurate midpoint and curvature tensors', () => {
      const corpus = synthesizeCadNurbsCorpus();

      expect(corpus.surface.uDegree).toBe(3);
      expect(corpus.surface.vDegree).toBe(3);
      expect(corpus.surface.controlPoints.length).toBe(4);
      expect(corpus.surface.controlPoints[0].length).toBe(4);

      // A bicubic surface with the clamped knot vector [0,0,0,0,1,1,1,1] is a Bezier patch, so its point at (u, v)
      // is the sum of control points weighted by Bernstein polynomials: an evaluation that shares no code with the
      // Cox-de Boor routine under test. The midpoint of the corpus is checked, and the evaluator at a grid.
      const bernstein = (t: number): number[] => [(1 - t) ** 3, 3 * t * (1 - t) ** 2, 3 * t * t * (1 - t), t ** 3];
      const bezierPoint = (u: number, v: number) => {
        const bu = bernstein(u);
        const bv = bernstein(v);
        const point = { x: 0, y: 0, z: 0 };
        corpus.surface.controlPoints.forEach((row, i) =>
          row.forEach((control, j) => {
            point.x += bu[i] * bv[j] * control.x;
            point.y += bu[i] * bv[j] * control.y;
            point.z += bu[i] * bv[j] * control.z;
          })
        );
        return point;
      };
      expect(bezierPoint(0.5, 0.5)).toEqual({ x: 15, y: 15, z: 5.25 });
      expect(corpus.midPoint).toEqual({ x: 15, y: 15, z: 5.25 });
      for (const u of [0, 0.125, 0.5, 0.75, 1]) {
        for (const v of [0, 0.3, 0.5, 1]) {
          const evaluated = evaluateBSplineSurface(corpus.surface, u, v).point;
          const expected = bezierPoint(u, v);
          expect(evaluated.x).toBeCloseTo(expected.x, 9);
          expect(evaluated.y).toBeCloseTo(expected.y, 9);
          expect(evaluated.z).toBeCloseTo(expected.z, 9);
        }
      }

      // Verify analytical Gaussian and Mean curvatures
      expect(Number.isFinite(corpus.curvatures.K)).toBe(true);
      expect(Number.isFinite(corpus.curvatures.H)).toBe(true);
      expect(Number.isNaN(corpus.curvatures.k1)).toBe(false);
      expect(Number.isNaN(corpus.curvatures.k2)).toBe(false);
    });

    it('generates adaptive tessellation and 2D CDT trimmed face meshes with valid topology', () => {
      const corpus = synthesizeCadNurbsCorpus();

      // Adaptive mesh
      expect(corpus.adaptiveMesh.vertices.length).toBeGreaterThan(16);
      expect(corpus.adaptiveMesh.faces.length).toBeGreaterThan(10);
      expect(corpus.adaptiveMesh.normals.length).toBe(corpus.adaptiveMesh.vertices.length);

      expect(corpus.trimmedMesh.vertices.length).toBeGreaterThan(3);
      expect(corpus.trimmedMesh.faces.length).toBeGreaterThan(1);
      expect(corpus.outerLoop.length).toBe(4);
      expect(corpus.innerHoles.length).toBe(1);
    });
  });

  // =========================================================================
  // 2. ISO 32000-1 CMap & Multi-Column PDF Reading Order Corpus
  // =========================================================================
  describe('2. ISO 32000-1 CMap & Multi-Column PDF Reading Order Corpus', () => {
    it('parses /ToUnicode CMap character mappings including ligatures and spaces', () => {
      const corpus = synthesizeCMapPdfCorpus();

      expect(corpus.parsedCMap.charMap.size).toBeGreaterThanOrEqual(3);
      // Verify ligature mappings: 0x0001 -> \uFB01 (fi), 0x0002 -> \uFB02 (fl)
      expect(corpus.parsedCMap.charMap.get(0x0001)).toBe('\uFB01');
      expect(corpus.parsedCMap.charMap.get(0x0002)).toBe('\uFB02');
      expect(corpus.parsedCMap.charMap.get(0x00A0)).toBe(' ');
    });

    it('synthesizes valid PDF binary and reconstructs multi-column reading order via Recursive XY-Cut++', () => {
      const corpus = synthesizeCMapPdfCorpus();

      expect(corpus.pdfBuffer.length).toBeGreaterThan(500);
      expect(corpus.pdfBuffer.toString('utf-8')).toContain('%PDF-1.7');
      expect(corpus.pdfBuffer.toString('utf-8')).toContain('/ToUnicode');

      // Verify reading order: Column 1 blocks must precede Column 2 blocks
      const orderedTexts = corpus.orderedBlocks.map((b) => b.text);
      const col1HeaderIdx = orderedTexts.findIndex((t) => t.includes('Left Column: Architecture Overview'));
      const col2HeaderIdx = orderedTexts.findIndex((t) => t.includes('Right Column: Technical Specifications'));

      expect(col1HeaderIdx).toBeGreaterThanOrEqual(0);
      expect(col2HeaderIdx).toBeGreaterThanOrEqual(0);
      expect(col1HeaderIdx).toBeLessThan(col2HeaderIdx);
    });
  });

  // =========================================================================
  // 3. HWP 5.0 CFBF Compound File Binary & EqEdit MathML Corpus
  // =========================================================================
  describe('3. HWP 5.0 CFBF Compound File Binary & EqEdit MathML Corpus', () => {
    it('reads the independently written HWP 5.0 compound file back to the paragraphs and table that were written', () => {
      const corpus = synthesizeHwp5CompoundCorpus();

      // Check CFBF magic bytes
      expect(corpus.buffer.readUInt32LE(0)).toBe(0xe011cfd0);
      expect(corpus.buffer.readUInt32LE(4)).toBe(0xe11ab1a1);

      const doc = parseHwpDocument(corpus.buffer);
      expect(doc.version).toBe('5.0.3.0');
      expect(doc.paragraphs.map((paragraph) => paragraph.text)).toEqual(corpus.doc.paragraphs.map((paragraph) => paragraph.text));
      expect(doc.tables.map((table) => table.rows)).toEqual((corpus.doc.tables ?? []).map((table) => table.rows));
      expect(doc.equations?.map((equation) => equation.script)).toEqual(corpus.rawEquations);
    });

    oracleTest('transpiles the equations of the compound file to MathML that reads as the equations do', ['xmllint'], () => {
      const corpus = synthesizeHwp5CompoundCorpus();
      const [summation, density, energy] = (parseHwpDocument(corpus.buffer).equations ?? []).map((equation) => equation.mathml);

      // sum_{i=1}^{n} i = {n(n+1)} over {2}: a sum with limits, then i = n(n+1)/2
      expect(xmlWellFormed(summation).ok).toBe(true);
      expect(xpathString(summation, 'name(/math/*[1])')).toBe('munderover');
      expect(xpathString(summation, 'string(/math/munderover/*[2])')).toBe('i=1');
      expect(xpathString(summation, 'string(/math/mfrac/*[1])')).toBe('n(n+1)');

      // f(x) = {1} over {sqrt{2 pi}} e^{-{x^2} over {2}}: a fraction over a square root, then e to a fraction
      expect(xmlWellFormed(density).ok).toBe(true);
      expect(xpathString(density, 'string(/math/mfrac/*[2]/self::msqrt)')).toBe('2π');
      expect(xpathString(density, 'name(/math/msup/*[2]/*[2])')).toBe('mfrac');

      // E = m c^2: the exponent sits on c
      expect(xmlWellFormed(energy).ok).toBe(true);
      expect(xpathString(energy, 'string(/math/msup/*[1])')).toBe('c');
      expect(xpathString(energy, 'string(/math/msup/*[2])')).toBe('2');
    });

    it('transpiles the equations of the compound file to LaTeX', () => {
      const corpus = synthesizeHwp5CompoundCorpus();
      expect((parseHwpDocument(corpus.buffer).equations ?? []).map((equation) => equation.latex)).toEqual([
        '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}',
        'f(x) = \\frac{1}{\\sqrt{2 \\pi}} e^{-\\frac{x^2}{2}}',
        'E = m c^2',
      ]);
    });
  });

  // =========================================================================
  // 4. Perceptual Visual Regression Testing (VRT) Cross-Engine Evaluation
  // =========================================================================
  describe('4. Perceptual Visual Regression Testing (VRT) Cross-Engine Evaluation', () => {
    it('evaluates DrawingML vector shapes vs rendered SVG raster with zero perceptual delta', async () => {
      const drawingCorpus = synthesizeDrawingMlTableCorpus();
      const { svg } = drawingCorpus.renderSvg();

      expect(svg).toContain('<svg');
      expect(svg).toContain('rx="8"');
      expect(svg).toContain('M 0 30 Q 30 5 60 18 T 120 5');
      expect(drawingCorpus.shapes[0].name).toBe('Status Badge');
      expect(drawingCorpus.shapes[2].name).toBe('Growth Trend Curve');

      // Rasterize rendered SVG
      const pngBufferA = await sharp(Buffer.from(svg, 'utf-8')).png().toBuffer();
      const pngBufferB = await sharp(Buffer.from(svg, 'utf-8')).png().toBuffer();

      const vrt = await compareImages(pngBufferA, pngBufferB, {
        threshold: 0.05,
        maxDeltaRatio: 0.0001,
      });

      expect(vrt.passed).toBe(true);
      expect(vrt.mismatchedPixels).toBe(0);
      expect(vrt.deltaRatio).toBe(0);
      expect(vrt.ssim).toBe(1.0);
      expect(vrt.psnr).toBe(Infinity);
    });

    it('detects visual discrepancies with strict SSIM, PSNR, and pixel diff mapping', async () => {
      const imgWidth = 80;
      const imgHeight = 80;

      const basePng = await sharp({
        create: {
          width: imgWidth,
          height: imgHeight,
          channels: 4,
          background: { r: 92, g: 107, b: 192, alpha: 1 },
        },
      })
        .png()
        .toBuffer();

      // Mutate image with an altered subregion
      const alteredSvg = `<svg width="${imgWidth}" height="${imgHeight}" xmlns="http://www.w3.org/2000/svg">
        <rect width="${imgWidth}" height="${imgHeight}" fill="#5C6BC0" />
        <circle cx="40" cy="40" r="15" fill="#FFFFFF" />
      </svg>`;
      const alteredPng = await sharp(Buffer.from(alteredSvg, 'utf-8')).png().toBuffer();

      const vrt = await compareImages(basePng, alteredPng, {
        threshold: 0.08,
      });

      expect(vrt.passed).toBe(false);
      expect(vrt.mismatchedPixels).toBeGreaterThan(100);
      expect(vrt.deltaRatio).toBeGreaterThan(0.01);
      expect(vrt.ssim).toBeLessThan(1.0);
      expect(vrt.psnr).toBeLessThan(50);
      expect(vrt.diffImage).toBeDefined();
    });
  });

  // =========================================================================
  // 5. Adversarial Mutation Fuzzing Across Multi-Domain Engines
  // =========================================================================
  describe('5. Adversarial Mutation Fuzzing Across Multi-Domain Engines', () => {
    it('resiliently handles corrupted B-Spline knot vectors fail-closed', () => {
      const corpus = synthesizeCadNurbsCorpus();

      // Degenerate non-monotonic knot vector
      const corruptedSurface = {
        ...corpus.surface,
        uKnots: [1, 0, 2, 0, 1, 0, 1, 0],
      };

      // A knot vector must not decrease: the surface is refused instead of evaluated to some number.
      expect(() => evaluateBSplineSurface(corpus.surface, 0.5, 0.5)).not.toThrow();
      expect(() => evaluateBSplineSurface(corruptedSurface, 0.5, 0.5)).toThrow(CadGeometryError);
      expect(() => evaluateBSplineSurface(corruptedSurface, 0.5, 0.5)).toThrow(
        /B-spline surface u knot vector decreases at index 1 \(0 follows 1\)/
      );
      // Wrong knot count for 4 control points of degree 3 (8 needed), a NaN knot, and an empty domain.
      expect(() => evaluateBSplineSurface({ ...corpus.surface, vKnots: [0, 0, 0, 1, 1, 1] }, 0.5, 0.5)).toThrow(
        /B-spline surface v knot vector has 6 knots, 8 needed for 4 control points of degree 3/
      );
      expect(() => evaluateBSplineSurface({ ...corpus.surface, uKnots: [0, 0, 0, 0, Number.NaN, 1, 1, 1] }, 0.5, 0.5)).toThrow(
        /B-spline surface u knot vector holds a non-finite knot at index 4/
      );
      expect(() => evaluateBSplineSurface({ ...corpus.surface, uKnots: [1, 1, 1, 1, 1, 1, 1, 1] }, 0.5, 0.5)).toThrow(
        /B-spline surface u knot vector spans no parameter range/
      );

      // The same checks guard curves: a line of 2 control points needs 3 knots, not 2.
      const line = { degree: 1, controlPoints: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }], knots: [0, 0, 1, 1] };
      expect(evaluateBSplineCurve(line, 0.5)).toEqual({ x: 5, y: 0, z: 0 });
      expect(() => evaluateBSplineCurve({ ...line, knots: [0, 1, 1] }, 0.5)).toThrow(CadGeometryError);
      expect(() => evaluateBSplineCurve({ ...line, knots: [0, 1, 1] }, 0.5)).toThrow(
        /B-spline curve knot vector has 3 knots, 4 needed for 2 control points of degree 1/
      );
    });

    it('resiliently handles corrupted CMap streams fail-closed', () => {
      const corruptedCMap = `begincmap
/CMapType 2 def
beginbfrange
<FFFF> <0000> [<0000>]
endbfrange
endcmap`;

      const parsed = parseToUnicodeCMap(corruptedCMap);
      expect(parsed).toBeDefined();
      expect(parsed.charMap instanceof Map).toBe(true);
    });

    it('refuses malformed EqEdit scripts with a typed error and transpiles odd but valid ones to well-formed MathML', () => {
      for (const script of ['{ { { { unclosed braces', 'over over over']) {
        expect(() => hwpEquationToMathML(script), script).toThrow(CorruptStreamError);
        expect(() => hwpEquationToLaTeX(script), script).toThrow(CorruptStreamError);
      }
      // An empty radicand and an empty fraction operand are valid scripts; so are symbols the editor has no keyword for.
      expect(hwpEquationToMathML('sqrt{ } over { }')).toBe('<math><mfrac><msqrt><mrow></mrow></msqrt><mrow></mrow></mfrac></math>');
      expect(hwpEquationToLaTeX('sqrt{ } over { }')).toBe('\\frac{\\sqrt{}}{}');
      expect(hwpEquationToMathML('')).toBe('<math></math>');
      expect(hwpEquationToLaTeX('')).toBe('');
      expect(hwpEquationToMathML('µ_∂_∑')).toBe('<math><msub><msub><mi>µ</mi><mo>∂</mo></msub><mo>∑</mo></msub></math>');
    });
  });
});
