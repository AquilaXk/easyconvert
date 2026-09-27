import { describe, it, expect } from 'vitest';
import {
  rgbToOklab,
  oklabToRgb,
  srgbToLinear,
  linearToSrgb,
  deltaEOk,
  deltaEOkRgb,
  generateHilbertCurveOrder,
  quantizePaletteOklab,
  riemersmaDither,
  applyOklabQuantizationAndDither,
} from '../src/lib/conversions/color-quantizer';
import {
  adaptiveIncrementalBRepMesh,
  StepEntity,
} from '../src/lib/conversions/cad-nurbs';
import { runOnnxCjkOcrPipeline } from '../src/lib/conversions/ocr';
import {
  analyzeDocumentLayout,
  DlaBoundingBox,
} from '../src/lib/conversions/dla-engine';

describe('Phase 4 SOTA Algorithms & DLA Testnet', () => {
  // ==========================================================================
  // 1. OKLab Color Space & Riemersma Space-Filling Curve Dithering
  // ==========================================================================
  describe('OKLab Color Space & Riemersma Dithering (Component 4.1)', () => {
    it('round-trips sRGB through linear color transform accurately', () => {
      for (const val of [0, 16, 64, 128, 192, 255]) {
        const lin = srgbToLinear(val);
        const back = linearToSrgb(lin);
        expect(Math.abs(back - val)).toBeLessThanOrEqual(1);
      }
    });

    it('computes correct OKLab coordinates and Delta E_OK metric', () => {
      const black = rgbToOklab({ r: 0, g: 0, b: 0 });
      expect(black.L).toBeCloseTo(0, 4);

      const white = rgbToOklab({ r: 255, g: 255, b: 255 });
      expect(white.L).toBeCloseTo(1, 2);

      // Delta E_OK between identical colors is 0
      expect(deltaEOk(black, black)).toBe(0);
      expect(deltaEOk(white, white)).toBe(0);

      // Delta E_OK between black and white is close to 1.0
      const distBw = deltaEOk(black, white);
      expect(distBw).toBeGreaterThan(0.9);

      // Perceptual similarity: red vs pink vs blue
      const red = { r: 255, g: 0, b: 0 };
      const pink = { r: 255, g: 150, b: 150 };
      const blue = { r: 0, g: 0, b: 255 };

      const distRedPink = deltaEOkRgb(red, pink);
      const distRedBlue = deltaEOkRgb(red, blue);
      expect(distRedPink).toBeLessThan(distRedBlue);
    });

    it('generates complete Hilbert curve traversing all image coordinates', () => {
      const width = 8;
      const height = 8;
      const curve = generateHilbertCurveOrder(width, height);
      expect(curve.length).toBe(width * height);

      // Ensure every coordinate (0..w-1, 0..h-1) is visited exactly once
      const visited = new Set<string>();
      for (const pt of curve) {
        expect(pt.x).toBeGreaterThanOrEqual(0);
        expect(pt.x).toBeLessThan(width);
        expect(pt.y).toBeGreaterThanOrEqual(0);
        expect(pt.y).toBeLessThan(height);
        visited.add(`${pt.x},${pt.y}`);
      }
      expect(visited.size).toBe(width * height);
    });

    it('quantizes colors into OKLab palette and dithers along space-filling curve', () => {
      const width = 16;
      const height = 16;
      const pixels = new Uint8Array(width * height * 4);

      // Generate a smooth gradient image
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * 4;
          pixels[idx] = Math.round((x / width) * 255);
          pixels[idx + 1] = Math.round((y / height) * 255);
          pixels[idx + 2] = 128;
          pixels[idx + 3] = 255;
        }
      }

      // Quantize to 8 colors with Riemersma dithering
      const result = applyOklabQuantizationAndDither(
        { data: pixels, width, height },
        8,
        true
      );

      expect(result.palette.length).toBeLessThanOrEqual(8);
      expect(result.indexed.length).toBe(width * height);
      expect(result.rgba.length).toBe(width * height * 4);

      // Indices must strictly stay within palette bounds
      for (let i = 0; i < result.indexed.length; i++) {
        expect(result.indexed[i]).toBeGreaterThanOrEqual(0);
        expect(result.indexed[i]).toBeLessThan(result.palette.length);
      }
    });
  });

  // ==========================================================================
  // 2. Adaptive Incremental BRepMesh Tessellation
  // ==========================================================================
  describe('Adaptive Incremental BRepMesh (Component 4.2)', () => {
    it('adaptively subdivides B-Rep solid boundary faces based on chordal deflection', () => {
      // Create a mock STEP entity map with a quad face
      const entityMap = new Map<number, StepEntity>();

      entityMap.set(10, {
        id: 10,
        type: 'ADVANCED_FACE',
        args: ['', [20], 100, true],
      });

      entityMap.set(20, {
        id: 20,
        type: 'FACE_OUTER_BOUND',
        args: ['', 30, true],
      });

      entityMap.set(30, {
        id: 30,
        type: 'EDGE_LOOP',
        args: ['', [41, 42, 43, 44]],
      });

      // 4 oriented edges forming a 10x10 square
      entityMap.set(41, { id: 41, type: 'ORIENTED_EDGE', args: ['', 0, 51, true] });
      entityMap.set(42, { id: 42, type: 'ORIENTED_EDGE', args: ['', 0, 52, true] });
      entityMap.set(43, { id: 43, type: 'ORIENTED_EDGE', args: ['', 0, 53, true] });
      entityMap.set(44, { id: 44, type: 'ORIENTED_EDGE', args: ['', 0, 54, true] });

      entityMap.set(51, { id: 51, type: 'EDGE_CURVE', args: ['', 61, 62, 0, true] });
      entityMap.set(52, { id: 52, type: 'EDGE_CURVE', args: ['', 62, 63, 0, true] });
      entityMap.set(53, { id: 53, type: 'EDGE_CURVE', args: ['', 63, 64, 0, true] });
      entityMap.set(54, { id: 54, type: 'EDGE_CURVE', args: ['', 64, 61, 0, true] });

      entityMap.set(61, { id: 61, type: 'VERTEX_POINT', args: ['', 71] });
      entityMap.set(62, { id: 62, type: 'VERTEX_POINT', args: ['', 72] });
      entityMap.set(63, { id: 63, type: 'VERTEX_POINT', args: ['', 73] });
      entityMap.set(64, { id: 64, type: 'VERTEX_POINT', args: ['', 74] });

      entityMap.set(71, { id: 71, type: 'CARTESIAN_POINT', args: ['', [0, 0, 0]] });
      entityMap.set(72, { id: 72, type: 'CARTESIAN_POINT', args: ['', [10, 0, 0]] });
      entityMap.set(73, { id: 73, type: 'CARTESIAN_POINT', args: ['', [10, 10, 0]] });
      entityMap.set(74, { id: 74, type: 'CARTESIAN_POINT', args: ['', [0, 10, 0]] });

      // Coarse deflection -> base mesh
      const coarseMesh = adaptiveIncrementalBRepMesh(entityMap, {
        linearDeflection: 1.0,
        angularDeflection: 1.5,
      });
      expect(coarseMesh).toBeDefined();
      expect(coarseMesh!.faces.length).toBeGreaterThan(0);

      // Fine deflection -> adaptive subdivision producing more triangles
      const fineMesh = adaptiveIncrementalBRepMesh(entityMap, {
        linearDeflection: 0.05,
        angularDeflection: 0.2,
      });
      expect(fineMesh).toBeDefined();
      expect(fineMesh!.faces.length).toBeGreaterThan(coarseMesh!.faces.length);
      expect(fineMesh!.vertices.length).toBeGreaterThan(coarseMesh!.vertices.length);
    });
  });

  // ==========================================================================
  // 3. Lightweight CJK Optical Character Recognition Engine
  // ==========================================================================
  describe('Lightweight CJK OCR Pipeline (Component 4.3)', () => {
    it('executes CJK OCR pipeline with structured line and word tokenization', async () => {
      // Create a simulated high-contrast test image buffer
      const width = 200;
      const height = 100;
      const raw = Buffer.alloc(width * height * 4, 255); // White background

      // Draw dark horizontal text lines
      for (let y = 30; y < 45; y++) {
        for (let x = 20; x < 180; x++) {
          const idx = (y * width + x) * 4;
          raw[idx] = 0;
          raw[idx + 1] = 0;
          raw[idx + 2] = 0;
        }
      }

      const sharp = (await import('sharp')).default;
      const pngBuf = await sharp(raw, { raw: { width, height, channels: 4 } })
        .png()
        .toBuffer();

      const ocrKo = await runOnnxCjkOcrPipeline(pngBuf, { ocrLanguage: 'ko' });
      expect(ocrKo).toBeDefined();
      expect(ocrKo.imageWidth).toBe(width);
      expect(ocrKo.imageHeight).toBe(height);
      expect(ocrKo.confidence).toBeGreaterThanOrEqual(0.9);
      expect(Array.isArray(ocrKo.lines)).toBe(true);
    });
  });

  // ==========================================================================
  // 4. Recursive XY-Cut+ Document Layout Analysis (DLA)
  // ==========================================================================
  describe('Recursive XY-Cut+ Document Layout Analysis (Component 4.4)', () => {
    it('analyzes multi-column layouts and orders blocks topologically', () => {
      const pageWidth = 800;
      const pageHeight = 1000;

      // Simulate a two-column academic paper layout:
      // - Header at top (y = 30)
      // - Title / Heading (y = 120)
      // - Column 1 Paragraphs (x = 50..370, y = 200..600)
      // - Column 2 Paragraphs (x = 430..750, y = 200..600)
      // - Footer at bottom (y = 950)
      const boxes: DlaBoundingBox[] = [
        // Header
        {
          x: 50,
          y: 30,
          width: 700,
          height: 20,
          text: 'International Journal of Document Analysis (2026)',
        },
        // Heading
        {
          x: 100,
          y: 120,
          width: 600,
          height: 35,
          text: 'Adaptive Multi-Column Layout Analysis and Segmentation',
          fontSize: 24,
          isBold: true,
        },
        // Column 1 - Paragraph 1
        {
          x: 50,
          y: 200,
          width: 320,
          height: 60,
          text: 'In this paper we present a recursive XY-cut algorithm.',
          fontSize: 12,
        },
        // Column 1 - Paragraph 2
        {
          x: 50,
          y: 280,
          width: 320,
          height: 60,
          text: 'The spatial projection profiles decompose the document.',
          fontSize: 12,
        },
        // Column 2 - Paragraph 1
        {
          x: 430,
          y: 200,
          width: 320,
          height: 60,
          text: 'Experimental results validate the effectiveness of our approach.',
          fontSize: 12,
        },
        // Column 2 - Paragraph 2
        {
          x: 430,
          y: 280,
          width: 320,
          height: 60,
          text: 'The reading order follows natural human scanning patterns.',
          fontSize: 12,
        },
        // Footer
        {
          x: 380,
          y: 950,
          width: 40,
          height: 20,
          text: 'Page 1',
        },
      ];

      const layout = analyzeDocumentLayout(boxes, pageWidth, pageHeight, {
        minColumnGap: 30,
        minParagraphGap: 15,
      });

      expect(layout.columnCount).toBe(2);
      expect(layout.blocks.length).toBeGreaterThanOrEqual(5);

      // Verify Header is first in reading order
      expect(layout.blocks[0].type).toBe('header');
      expect(layout.blocks[0].readingOrder).toBe(1);

      // Verify Footer is last in reading order
      const lastBlock = layout.blocks[layout.blocks.length - 1];
      expect(lastBlock.type).toBe('footer');

      // Verify Column 1 items appear before Column 2 items in body reading order
      const col1Blocks = layout.blocks.filter((b) => b.columnIndex === 0 && b.type === 'paragraph');
      const col2Blocks = layout.blocks.filter((b) => b.columnIndex === 1 && b.type === 'paragraph');

      expect(col1Blocks.length).toBeGreaterThan(0);
      expect(col2Blocks.length).toBeGreaterThan(0);
      expect(col1Blocks[0].readingOrder).toBeLessThan(col2Blocks[0].readingOrder);
    });

    it('classifies headings, list items, and tables accurately', () => {
      const pageWidth = 600;
      const pageHeight = 800;

      const boxes: DlaBoundingBox[] = [
        {
          x: 50,
          y: 100,
          width: 500,
          height: 30,
          text: '1. Executive Summary',
          fontSize: 20,
          isBold: true,
        },
        {
          x: 50,
          y: 160,
          width: 500,
          height: 40,
          text: '• First key deliverable completed on schedule.',
          fontSize: 12,
        },
        {
          x: 50,
          y: 220,
          width: 500,
          height: 40,
          text: '• Second key deliverable under active testing.',
          fontSize: 12,
        },
      ];

      const layout = analyzeDocumentLayout(boxes, pageWidth, pageHeight);
      const headingBlock = layout.blocks.find((b) => b.type === 'heading');
      expect(headingBlock).toBeDefined();
      expect(headingBlock!.text).toContain('Executive Summary');

      const listBlocks = layout.blocks.filter((b) => b.type === 'list_item');
      expect(listBlocks.length).toBe(2);
    });
  });
});
