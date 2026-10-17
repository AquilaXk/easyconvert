import { describe, it, expect } from 'vitest';
import {
  srgbToOklab,
  deltaEOklab,
  findClosestPaletteIndexOklab,
  applyFloydSteinbergDither,
} from '../src/lib/conversions/quantize';
import { performOcr } from '../src/lib/conversions/ocr';

import sharp from 'sharp';

describe('Phase 2: State-of-the-Art Algorithms & Edge Acceleration', () => {
  describe('1. OKLab Perceptual Color Quantization & Dithering', () => {
    it('converts sRGB to OKLab and calculates perceptual Euclidean distance', () => {
      const white = srgbToOklab(255, 255, 255);
      const black = srgbToOklab(0, 0, 0);
      const red = srgbToOklab(255, 0, 0);

      expect(white.L).toBeCloseTo(1.0, 1);
      expect(black.L).toBeCloseTo(0.0, 1);
      expect(red.a).toBeGreaterThan(0.1);

      const dWhiteBlack = deltaEOklab(white, black);
      const dWhiteRed = deltaEOklab(white, red);
      expect(dWhiteBlack).toBeGreaterThan(dWhiteRed);
    });

    it('matches palette colors with OKLab perceptual accuracy', () => {
      const palette = [
        { r: 255, g: 255, b: 255 },
        { r: 200, g: 0, b: 0 },
        { r: 0, g: 200, b: 0 },
        { r: 0, g: 0, b: 200 },
        { r: 0, g: 0, b: 0 },
      ];
      const target = { r: 240, g: 20, b: 20 };
      const idx = findClosestPaletteIndexOklab(target, palette);
      expect(idx).toBe(1); // Red
    });

    it('applies Floyd-Steinberg error diffusion dithering with OKLab distance', () => {
      const width = 4;
      const height = 4;
      const rgb = Buffer.alloc(width * height * 3);
      // Fill with a smooth gradient
      for (let i = 0; i < width * height; i++) {
        rgb[i * 3] = i * 16;
        rgb[i * 3 + 1] = i * 16;
        rgb[i * 3 + 2] = i * 16;
      }
      const palette = [
        { r: 0, g: 0, b: 0 },
        { r: 128, g: 128, b: 128 },
        { r: 255, g: 255, b: 255 },
      ];

      const indexed = applyFloydSteinbergDither(rgb, width, height, 3, palette, true, true);
      expect(indexed).toHaveLength(width * height);
      // First pixel near 0 should map to black (0)
      expect(indexed[0]).toBe(0);
      // Last pixel near 255 should map to white (2)
      expect(indexed[width * height - 1]).toBe(2);
    });
  });

  describe('2. Authentic OCR Pipeline Execution', () => {
    it('executes OCR pipeline on CJK image with Korean language', async () => {
      const testImage = await sharp({
        create: { width: 120, height: 40, channels: 3, background: { r: 255, g: 255, b: 255 } },
      })
        .composite([
          {
            input: Buffer.from(
              '<svg width="120" height="40"><text x="10" y="28" font-family="monospace" font-size="20" fill="black">한글</text></svg>'
            ),
            top: 0,
            left: 0,
          },
        ])
        .png()
        .toBuffer();

      const result = await performOcr(testImage, 'ko');
      expect(result).toBeDefined();
      expect(result.imageWidth).toBe(120);
      expect(result.imageHeight).toBe(40);
    });
  });

});
