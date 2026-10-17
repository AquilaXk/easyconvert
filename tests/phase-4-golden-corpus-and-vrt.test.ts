import { describe, it, expect } from 'vitest';
import {
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

import {
  CorruptStreamError,
} from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { xmlWellFormed, xpathCount, xpathString } from './helpers/xml-oracle';
import { parseHwpDocument, hwpEquationToMathML, hwpEquationToLaTeX } from '../src/lib/conversions/hwp';
import sharp from 'sharp';

type ControlNet = ReadonlyArray<ReadonlyArray<{ x: number; y: number; z: number }>>;
type Vector3 = [number, number, number];
/** EMU (English Metric Units) in one point. */
const EMU_PER_POINT = 12700;

describe('Phase 4: Universal Golden Binary Corpus & Visual Regression CI Gate (#70)', () => {

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
    oracleTest('renders the DrawingML shapes of the document where the document puts them, in the colours it names', ['xmllint'], async () => {
      const drawingCorpus = synthesizeDrawingMlTableCorpus();
      const { svg } = renderDrawingMlToSvg(drawingCorpus.drawingMlXml);

      // The expected values are the numbers of the DrawingML itself (ECMA-376): offsets and extents in EMU, 12700 EMU to the point.
      const spec = [
        { element: 'rect', x: 100000, y: 100000, width: 1400000, height: 360000, fill: '#5C6BC0', stroke: '#4A58A9' },
        { element: 'ellipse', x: 1600000, y: 100000, width: 1200000, height: 360000, fill: '#5C6BC0', stroke: '#1F2340' },
      ];
      expect(xpathCount(svg, '/*/*')).toBe(spec.length);
      for (const shape of spec) {
        const node = `/*/*[local-name()='${shape.element}']`;
        expect(xpathCount(svg, node), shape.element).toBe(1);
        // The renderer rounds to whole points: within one point of the exact value.
        const left = Number.parseFloat(xpathString(svg, `string(${node}/@${shape.element === 'ellipse' ? 'cx' : 'x'})`));
        const width = Number.parseFloat(xpathString(svg, `string(${node}/@${shape.element === 'ellipse' ? 'rx' : 'width'})`)) * (shape.element === 'ellipse' ? 2 : 1);
        const expectedLeft = shape.x / EMU_PER_POINT + (shape.element === 'ellipse' ? shape.width / EMU_PER_POINT / 2 : 0);
        expect(Math.abs(left - expectedLeft), `${shape.element} left`).toBeLessThanOrEqual(1);
        expect(Math.abs(width - shape.width / EMU_PER_POINT), `${shape.element} width`).toBeLessThanOrEqual(1);
        expect(xpathString(svg, `string(${node}/@fill)`)).toBe(shape.fill);
        expect(xpathString(svg, `string(${node}/@stroke)`)).toBe(shape.stroke);
      }

      // Rasterized by an image decoder, the pixels at the shape centres carry the fill colours and the gap between them is empty.
      const raster = await sharp(Buffer.from(svg, 'utf-8')).raw().ensureAlpha().toBuffer({ resolveWithObject: true });
      const viewBox = xpathString(svg, 'string(/*/@viewBox)').split(' ').map(Number);
      const pixelAt = (xPoints: number, yPoints: number): number[] => {
        const x = Math.round((xPoints - viewBox[0]) * (raster.info.width / viewBox[2]));
        const y = Math.round((yPoints - viewBox[1]) * (raster.info.height / viewBox[3]));
        const at = (y * raster.info.width + x) * raster.info.channels;
        return Array.from(raster.data.subarray(at, at + raster.info.channels));
      };
      const centre = (shape: (typeof spec)[number]) => [(shape.x + shape.width / 2) / EMU_PER_POINT, (shape.y + shape.height / 2) / EMU_PER_POINT];
      expect(pixelAt(centre(spec[0])[0], centre(spec[0])[1])).toEqual([0x5c, 0x6b, 0xc0, 255]);
      expect(pixelAt(centre(spec[1])[0], centre(spec[1])[1])).toEqual([0x5c, 0x6b, 0xc0, 255]);
      const gapX = (spec[0].x + spec[0].width + spec[1].x) / 2 / EMU_PER_POINT;
      expect(pixelAt(gapX, centre(spec[0])[1])[3]).toBe(0);
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
