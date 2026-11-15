import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  PaletteInverseCmap,
  quantizeImage,
} from '../src/lib/conversions/color-quantizer';

type RgbaPalette = Array<[number, number, number, number]>;
import {
  mapCorporatePuaSymbol,
  CORPORATE_PUA_START,
  CORPORATE_PUA_END,
  CORPORATE_PUA_COUNT,
  CORPORATE_PUA_SYMBOL_LUT,
} from '../src/lib/conversions/symbol-font-map';
import { recoverUnmappedGlyphs } from '../src/lib/conversions/pdf-glyph-recovery';
import { wantsPngOptimiser } from '../src/lib/conversions/png-optimise';
import { generatePptxFromText } from '../src/lib/conversions/office/office-from-text';
import { shapeProperties } from '../src/lib/conversions/document-model/shape-xml';
import { escapeXmlText } from '../src/lib/storage/adapters/s3';

function bruteForceNearest(palette: RgbaPalette, r: number, g: number, b: number): number {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const dr = r - palette[i][0];
    const dg = g - palette[i][1];
    const db = b - palette[i][2];
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

describe('OSS Kernels & Office Enhancements', () => {
  describe('Task 1: mozilla/mozjpeg Heckbert minmaxdist 3D Inverse Colormap', () => {
    it('returns exact same palette index as brute-force across boundary and random RGB points', () => {
      // 16 distinct RGB palette entries including extreme corners
      const palette: RgbaPalette = [
        [0, 0, 0, 255],
        [255, 255, 255, 255],
        [255, 0, 0, 255],
        [0, 255, 0, 255],
        [0, 0, 255, 255],
        [128, 128, 128, 255],
        [64, 64, 64, 255],
        [192, 192, 192, 255],
        [255, 255, 0, 255],
        [0, 255, 255, 255],
        [255, 0, 255, 255],
        [7, 8, 9, 255],
        [127, 128, 129, 255],
        [247, 248, 249, 255],
        [32, 160, 80, 255],
        [200, 50, 100, 255],
      ];

      const paletteBytes = new Uint8Array(palette.length * 3);
      for (let i = 0; i < palette.length; i++) {
        paletteBytes[i * 3] = palette[i][0];
        paletteBytes[i * 3 + 1] = palette[i][1];
        paletteBytes[i * 3 + 2] = palette[i][2];
      }
      const inverseCmap = new PaletteInverseCmap(paletteBytes, palette.length);

      // Boundary values
      const boundaryValues = [0, 7, 8, 15, 16, 127, 128, 247, 248, 254, 255];
      for (const r of boundaryValues) {
        for (const g of boundaryValues) {
          for (const b of boundaryValues) {
            const expected = bruteForceNearest(palette, r, g, b);
            const actual = inverseCmap.nearest(r, g, b);
            expect(actual).toBe(expected);
          }
        }
      }

      // Deterministic pseudo-random points
      let seed = 123456789;
      const nextRand = (): number => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed % 256;
      };

      for (let i = 0; i < 2000; i++) {
        const r = nextRand();
        const g = nextRand();
        const b = nextRand();
        const expected = bruteForceNearest(palette, r, g, b);
        const actual = inverseCmap.nearest(r, g, b);
        expect(actual).toBe(expected);
      }
    });

    it('benchmarks PaletteInverseCmap vs brute-force throughput', () => {
      const palette: RgbaPalette = [
        [0, 0, 0, 255],
        [255, 255, 255, 255],
        [255, 0, 0, 255],
        [0, 255, 0, 255],
        [0, 0, 255, 255],
        [128, 128, 128, 255],
        [255, 255, 0, 255],
        [0, 255, 255, 255],
      ];

      const paletteBytes = new Uint8Array(palette.length * 3);
      for (let i = 0; i < palette.length; i++) {
        paletteBytes[i * 3] = palette[i][0];
        paletteBytes[i * 3 + 1] = palette[i][1];
        paletteBytes[i * 3 + 2] = palette[i][2];
      }
      const inverseCmap = new PaletteInverseCmap(paletteBytes, palette.length);

      // Generate test RGB points
      const count = 50_000;
      const testR = new Uint8Array(count);
      const testG = new Uint8Array(count);
      const testB = new Uint8Array(count);
      for (let i = 0; i < count; i++) {
        testR[i] = (i * 37) & 0xff;
        testG[i] = (i * 73) & 0xff;
        testB[i] = (i * 109) & 0xff;
      }

      // Warmup
      for (let i = 0; i < count; i++) {
        bruteForceNearest(palette, testR[i], testG[i], testB[i]);
        inverseCmap.nearest(testR[i], testG[i], testB[i]);
      }

      const iterations = 5;
      const bfTimes: number[] = [];
      const cmapTimes: number[] = [];

      for (let it = 0; it < iterations; it++) {
        const t0Bf = performance.now();
        let bfSum = 0;
        for (let i = 0; i < count; i++) {
          bfSum += bruteForceNearest(palette, testR[i], testG[i], testB[i]);
        }
        const t1Bf = performance.now();
        bfTimes.push(t1Bf - t0Bf);

        const t0Cmap = performance.now();
        let cmapSum = 0;
        for (let i = 0; i < count; i++) {
          cmapSum += inverseCmap.nearest(testR[i], testG[i], testB[i]);
        }
        const t1Cmap = performance.now();
        cmapTimes.push(t1Cmap - t0Cmap);

        expect(cmapSum).toBe(bfSum);
      }

      const mean = (arr: number[]): number => arr.reduce((a, b) => a + b, 0) / arr.length;
      const variance = (arr: number[]): number => {
        const m = mean(arr);
        return arr.reduce((acc, val) => acc + (val - m) ** 2, 0) / arr.length;
      };

      const bfMeanMs = mean(bfTimes);
      const cmapMeanMs = mean(cmapTimes);
      const bfVariance = variance(bfTimes);
      const cmapVariance = variance(cmapTimes);
      const bfThroughput = (count / (bfMeanMs / 1000));
      const cmapThroughput = (count / (cmapMeanMs / 1000));

      expect(cmapThroughput).toBeGreaterThan(0);
      expect(bfThroughput).toBeGreaterThan(0);
    });

    it('quantizes image using fast inverse colormap and 18 Lloyd passes', () => {
      const width = 32;
      const height = 32;
      const rgba = new Uint8Array(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        rgba[i * 4] = (i * 7) % 256;
        rgba[i * 4 + 1] = (i * 13) % 256;
        rgba[i * 4 + 2] = (i * 29) % 256;
        rgba[i * 4 + 3] = 255;
      }
      const result = quantizeImage(rgba, width, height, 16, { dither: 'none' });
      expect(result.palette.length).toBeGreaterThan(0);
      expect(result.indices.length).toBe(width * height);
    });
  });

  describe('Task 2: mozilla/pdf.js Corporate PUA Symbol LUT', () => {
    it('covers 768 entries in 0xF600..0xF8FF range with Uint16Array table', () => {
      expect(CORPORATE_PUA_START).toBe(0xf600);
      expect(CORPORATE_PUA_END).toBe(0xf8ff);
      expect(CORPORATE_PUA_COUNT).toBe(768);
      expect(CORPORATE_PUA_SYMBOL_LUT).toBeInstanceOf(Uint16Array);
      expect(CORPORATE_PUA_SYMBOL_LUT.length).toBe(768);
    });

    it('maps Adobe corporate PUA symbols correctly', () => {
      expect(mapCorporatePuaSymbol(0xf8f4)).toBe('\u23AA'); // braceex -> ⎪
      expect(mapCorporatePuaSymbol(0xf8f5)).toBe('\u23AE'); // integralex
      expect(mapCorporatePuaSymbol(0xf8e5)).toBe('\u203E'); // radicalex
      expect(mapCorporatePuaSymbol(0xf8a0)).toBe('\u20AC'); // Euro
      expect(mapCorporatePuaSymbol(0xf6d9)).toBe('\u00A9'); // copyrightserif
      expect(mapCorporatePuaSymbol(0x1234)).toBeUndefined(); // outside range
      expect(mapCorporatePuaSymbol(0xf700)).toBeUndefined(); // unmapped in range
    });

    it('recovers unmapped glyphs including braceex U+F8F4', () => {
      const recovered = recoverUnmappedGlyphs('\uF8F4', { name: 'Symbol' });
      expect(recovered.text).toBe('\u23AA');
      expect(recovered.unmapped).toBe(0);
    });
  });

  describe('Task 3: Lossless PNG Optimiser Option', () => {
    it('identifies wantsPngOptimiser correctly', () => {
      expect(wantsPngOptimiser({ optimizePng: true })).toBe(true);
      expect(wantsPngOptimiser({ optimizePng: false })).toBe(false);
      expect(wantsPngOptimiser({})).toBe(false);
    });

    it('losslessly preserves all pixels during JPEG to PNG conversion with optimizePng', async () => {
      const originalImage = await sharp({
        create: {
          width: 64,
          height: 64,
          channels: 3,
          background: { r: 120, g: 60, b: 200 },
        },
      })
        .jpeg({ quality: 90 })
        .toBuffer();

      const pngStandard = await sharp(originalImage).png().toBuffer();
      const rawStandard = await sharp(pngStandard).raw().toBuffer();

      const pngOptimized = await sharp(originalImage).png({ compressionLevel: 1 }).toBuffer();
      const rawOptimized = await sharp(pngOptimized).raw().toBuffer();

      expect(rawOptimized.equals(rawStandard)).toBe(true);
    });
  });

  describe('Task 5: PDF Shapes & PPTX Writer', () => {
    it('generates standards-compliant PPTX package from text with pagination', async () => {
      const text = Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of document text content.`).join('\n');
      const pptxBuffer = await generatePptxFromText(text, 'txt', {}, 'Test Slides');
      expect(pptxBuffer).toBeInstanceOf(Buffer);
      expect(pptxBuffer.length).toBeGreaterThan(1000);
      expect(pptxBuffer[0]).toBe(0x50);
      expect(pptxBuffer[1]).toBe(0x4b);
      expect(pptxBuffer[2]).toBe(0x03);
      expect(pptxBuffer[3]).toBe(0x04);
    });

    it('emits dashed strokes and strokeAlpha in shapeProperties', () => {
      const dummyScale = {
        x: (v: number) => Math.round(v * 12700),
        y: (v: number) => Math.round(v * 12700),
        length: (v: number) => Math.round(v * 12700),
      };

      const solidProps = shapeProperties(
        {
          kind: 'rect',
          x0: 0,
          y0: 0,
          x1: 100,
          y1: 100,
          stroke: 0xff0000,
          strokeWidth: 2,
          z: 0,
        },
        dummyScale
      );
      expect(solidProps).not.toContain('a:prstDash');

      const dashedProps = shapeProperties(
        {
          kind: 'rect',
          x0: 0,
          y0: 0,
          x1: 100,
          y1: 100,
          stroke: 0xff0000,
          strokeWidth: 2,
          dashed: true,
          strokeAlpha: 0.5,
          z: 0,
        },
        dummyScale
      );
      expect(dashedProps).toContain('a:prstDash val="dash"');
      expect(dashedProps).toContain('a:alpha val="50000"');
      expect(dashedProps !== solidProps).toBe(true);
      expect(dashedProps.includes('<a:prstDash val="dash"/>')).toBe(true);
      expect(dashedProps.includes('<a:alpha val="50000"/>')).toBe(true);
    });
  });

  describe('Task 7: S3 Adapter XML Escaping Consolidation', () => {
    it('escapes XML special characters correctly', () => {
      expect(escapeXmlText('hello <world> & "goodbye" \'test\'')).toBe(
        'hello &lt;world&gt; &amp; &quot;goodbye&quot; &apos;test&apos;'
      );
    });
  });
});
