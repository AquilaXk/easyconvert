import { describe, it, expect } from 'vitest';
import { performOcr } from '../src/lib/conversions/ocr';

import sharp from 'sharp';

describe('Phase 2: State-of-the-Art Algorithms & Edge Acceleration', () => {
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
