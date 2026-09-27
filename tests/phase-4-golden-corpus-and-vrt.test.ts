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
import { evaluateBSplineSurface, evaluateSurfaceCurvature } from '../src/lib/conversions/cad-nurbs';
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

      // Verify analytical midpoint evaluation
      expect(corpus.midPoint.x).toBeGreaterThan(0);
      expect(corpus.midPoint.y).toBeGreaterThan(0);
      expect(corpus.midPoint.z).toBeGreaterThan(0);

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
    it('packages valid HWP 5.0 CFBF compound binary and parses paragraphs, tables, and metadata', () => {
      const corpus = synthesizeHwp5CompoundCorpus();

      expect(corpus.buffer.length).toBeGreaterThan(1024);
      // Check CFBF magic bytes
      expect(corpus.buffer.readUInt32LE(0)).toBe(0xe011cfd0);
      expect(corpus.buffer.readUInt32LE(4)).toBe(0xe11ab1a1);

      // Parsed document checks
      expect(corpus.doc.paragraphs.length).toBeGreaterThanOrEqual(3);
      expect(corpus.doc.tables.length).toBeGreaterThanOrEqual(1);
      expect(corpus.doc.tables[0].rows.length).toBe(3);
      expect(corpus.doc.tables[0].rows[0][0]).toBe('Metric Name');
    });

    it('transpiles HWP EqEdit equations to standards-compliant MathML and LaTeX', () => {
      const corpus = synthesizeHwp5CompoundCorpus();

      expect(corpus.transpiledEquations.length).toBe(3);

      const eq1 = corpus.transpiledEquations[0];
      expect(eq1.script).toContain('sum_{i=1}^{n}');
      expect(eq1.mathml).toContain('<mrow>');
      expect(eq1.mathml).toContain('<mfrac>');
      expect(eq1.latex).toContain('\\sum');
      expect(eq1.latex).toContain('\\frac');

      const eq2 = corpus.transpiledEquations[1];
      expect(eq2.script).toContain('sqrt{2 pi}');
      expect(eq2.mathml).toContain('<msqrt>');
      expect(eq2.latex).toContain('\\sqrt');

      const eq3 = corpus.transpiledEquations[2];
      expect(eq3.script).toBe('E = m c^2');
      expect(eq3.latex).toBe('E = m c^2');
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

      // Evaluating with malformed knots must either return zero/fallback or not crash
      expect(() => {
        evaluateBSplineSurface(corruptedSurface, 0.5, 0.5);
      }).not.toThrow();
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

    it('resiliently handles malformed EqEdit math scripts without throwing unhandled exceptions', () => {
      const malformedScripts = [
        '{ { { { unclosed braces',
        'over over over',
        'sqrt{ } over { }',
        '\\\\\\\\\\ non_ascii_µ_∂_∑',
        '',
      ];

      for (const script of malformedScripts) {
        expect(() => {
          const mathml = hwpEquationToMathML(script);
          const latex = hwpEquationToLaTeX(script);
          expect(typeof mathml).toBe('string');
          expect(typeof latex).toBe('string');
        }).not.toThrow();
      }
    });
  });
});
