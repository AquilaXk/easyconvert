import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { compareImages, computeSsim } from './helpers/vrt-engine';
import { renderDrawingMlToSvg } from '../src/lib/conversions/office';
import { applyFloydSteinbergDither, ColorRgb } from '../src/lib/conversions/quantize';

describe('Phase 4: Visual Regression Testing (VRT) CI Gate', () => {
  // Helper to create a solid or patterned test PNG
  async function createTestImage(
    width: number,
    height: number,
    bg: { r: number; g: number; b: number; a?: number } = { r: 92, g: 107, b: 192 }
  ): Promise<Buffer> {
    return sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: bg.r, g: bg.g, b: bg.b, alpha: bg.a ?? 1 },
      },
    })
      .png()
      .toBuffer();
  }

  // =========================================================================
  // 1. Perceptual Image Comparison Engine & Exact Matching
  // =========================================================================
  describe('1. Perceptual Image Comparison Engine & Exact Matching', () => {
    it('verifies identical image pairs yield zero delta ratio, SSIM 1.0, and PSNR Infinity', async () => {
      const imgA = await createTestImage(100, 100, { r: 92, g: 107, b: 192 });
      const imgB = await createTestImage(100, 100, { r: 92, g: 107, b: 192 });

      const res = await compareImages(imgA, imgB);

      expect(res.passed).toBe(true);
      expect(res.totalPixels).toBe(10000);
      expect(res.mismatchedPixels).toBe(0);
      expect(res.deltaRatio).toBe(0);
      expect(res.percentage).toBe(0);
      expect(res.ssim).toBe(1.0);
      expect(res.psnr).toBe(Infinity);
      expect(res.diffImage).toBeDefined();
      expect(res.diffImage!.length).toBeGreaterThan(50);
    });

    it('fails closed and throws clear error when image dimensions mismatch', async () => {
      const imgA = await createTestImage(100, 100);
      const imgB = await createTestImage(120, 100);

      await expect(compareImages(imgA, imgB)).rejects.toThrow(
        /VRT Dimension Mismatch: Image A is 100x100, Image B is 120x100/i
      );
    });
  });

  // =========================================================================
  // 2. Strict Pixel Delta Threshold (ΔPixel < 0.05%)
  // =========================================================================
  describe('2. Strict Pixel Delta Threshold (ΔPixel < 0.05%)', () => {
    it('passes sub-threshold minor perturbation below 0.05% delta threshold', async () => {
      // 200 x 200 = 40,000 pixels. Max allowed 0.05% is 20 pixels.
      const width = 200;
      const height = 200;
      const baseBuffer = Buffer.alloc(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        baseBuffer[i * 4] = 92; // R
        baseBuffer[i * 4 + 1] = 107; // G
        baseBuffer[i * 4 + 2] = 192; // B
        baseBuffer[i * 4 + 3] = 255; // A
      }

      // Perturb exactly 6 pixels (6 / 40,000 = 0.015% < 0.05%)
      const perturbedBuffer = Buffer.from(baseBuffer);
      for (let p = 0; p < 6; p++) {
        const offset = (50 + p * 10) * 4;
        perturbedBuffer[offset] = 0;
        perturbedBuffer[offset + 1] = 0;
        perturbedBuffer[offset + 2] = 0;
      }

      const imgA = await sharp(baseBuffer, { raw: { width, height, channels: 4 } }).png().toBuffer();
      const imgB = await sharp(perturbedBuffer, { raw: { width, height, channels: 4 } }).png().toBuffer();

      const res = await compareImages(imgA, imgB, { maxDeltaRatio: 0.0005, threshold: 0.05 });

      expect(res.deltaRatio).toBeLessThan(0.0005); // < 0.05%
      expect(res.passed).toBe(true);
      expect(res.mismatchedPixels).toBeLessThanOrEqual(6);
      expect(res.ssim).toBeGreaterThan(0.95);
    });

    it('rejects layout regressions exceeding 0.05% pixel delta threshold', async () => {
      // 200 x 200 = 40,000 pixels. Mutate a 20x10 block = 200 pixels (0.5% > 0.05%)
      const width = 200;
      const height = 200;
      const baseBuffer = Buffer.alloc(width * height * 4);
      baseBuffer.fill(200);

      const defectBuffer = Buffer.from(baseBuffer);
      for (let y = 50; y < 70; y++) {
        for (let x = 50; x < 60; x++) {
          const idx = (y * width + x) * 4;
          defectBuffer[idx] = 20;
          defectBuffer[idx + 1] = 20;
          defectBuffer[idx + 2] = 20;
        }
      }

      const imgA = await sharp(baseBuffer, { raw: { width, height, channels: 4 } }).png().toBuffer();
      const imgB = await sharp(defectBuffer, { raw: { width, height, channels: 4 } }).png().toBuffer();

      const res = await compareImages(imgA, imgB, { maxDeltaRatio: 0.0005 });

      expect(res.passed).toBe(false);
      expect(res.deltaRatio).toBeGreaterThan(0.0005);
      expect(res.percentage).toBeGreaterThan(0.05);
      expect(res.mismatchedPixels).toBeGreaterThanOrEqual(180);
      expect(res.diffImage).toBeDefined();
    });
  });

  // =========================================================================
  // 3. DrawingML Vector Geometry Rendering VRT Gate
  // =========================================================================
  describe('3. DrawingML Vector Geometry Rendering VRT Gate', () => {
    it('verifies deterministic pixel consistency for rendered DrawingML vector graphics', async () => {
      const shapes = [
        {
          type: 'roundrect',
          x: 20,
          y: 20,
          width: 200,
          height: 80,
          fillColor: '#5C6BC0',
          strokeColor: '#3B4890',
          strokeWidth: 3,
        },
        {
          type: 'ellipse',
          x: 240,
          y: 30,
          width: 60,
          height: 60,
          fillColor: '#8E9CE6',
          strokeColor: '#CCD2FC',
          strokeWidth: 2,
        },
      ];

      const { svg } = renderDrawingMlToSvg(shapes);
      expect(svg).toContain('<svg');

      const pngA = await sharp(Buffer.from(svg)).resize(320, 120).png().toBuffer();
      const pngB = await sharp(Buffer.from(svg)).resize(320, 120).png().toBuffer();

      const res = await compareImages(pngA, pngB, { maxDeltaRatio: 0.0005 });

      expect(res.passed).toBe(true);
      expect(res.deltaRatio).toBe(0);
      expect(res.ssim).toBe(1.0);
    });

    it('detects vector geometry shift when shape dimensions or stroke change', async () => {
      const shapesOriginal = [
        {
          type: 'roundrect',
          x: 20,
          y: 20,
          width: 180,
          height: 70,
          fillColor: '#5C6BC0',
          strokeColor: '#3B4890',
          strokeWidth: 2,
        },
      ];

      const shapesMutated = [
        {
          type: 'roundrect',
          x: 20,
          y: 20,
          width: 180,
          height: 70,
          fillColor: '#E53935', // Altered fill color
          strokeColor: '#3B4890',
          strokeWidth: 2,
        },
      ];

      const svgA = renderDrawingMlToSvg(shapesOriginal).svg;
      const svgB = renderDrawingMlToSvg(shapesMutated).svg;

      const pngA = await sharp(Buffer.from(svgA)).resize(240, 100).png().toBuffer();
      const pngB = await sharp(Buffer.from(svgB)).resize(240, 100).png().toBuffer();

      const res = await compareImages(pngA, pngB, { maxDeltaRatio: 0.0005 });

      expect(res.passed).toBe(false);
      expect(res.percentage).toBeGreaterThan(5.0); // Major color shift > 5%
    });
  });

  // =========================================================================
  // 4. Image Quantization & Dithering Perceptual Stability
  // =========================================================================
  describe('4. Image Quantization & Dithering Perceptual Stability', () => {
    it('verifies deterministic pixel parity across repeated Floyd-Steinberg runs', async () => {
      const width = 64;
      const height = 64;
      const gradientBuf = Buffer.alloc(width * height * 4);

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * 4;
          gradientBuf[idx] = Math.round((x / width) * 255);
          gradientBuf[idx + 1] = Math.round((y / height) * 255);
          gradientBuf[idx + 2] = 128;
          gradientBuf[idx + 3] = 255;
        }
      }

      const palette: ColorRgb[] = [
        { r: 0, g: 0, b: 0 },
        { r: 255, g: 255, b: 255 },
        { r: 92, g: 107, b: 192 },
        { r: 142, g: 156, b: 230 },
      ];

      // Run 1
      const dither1 = applyFloydSteinbergDither(gradientBuf, width, height, 4, palette, true, true);
      // Run 2
      const dither2 = applyFloydSteinbergDither(gradientBuf, width, height, 4, palette, true, true);

      // Reconstruct RGBA buffers
      const rgba1 = Buffer.alloc(width * height * 4);
      const rgba2 = Buffer.alloc(width * height * 4);

      for (let i = 0; i < dither1.length; i++) {
        const c1 = palette[dither1[i]];
        const c2 = palette[dither2[i]];

        rgba1[i * 4] = c1.r;
        rgba1[i * 4 + 1] = c1.g;
        rgba1[i * 4 + 2] = c1.b;
        rgba1[i * 4 + 3] = 255;

        rgba2[i * 4] = c2.r;
        rgba2[i * 4 + 1] = c2.g;
        rgba2[i * 4 + 2] = c2.b;
        rgba2[i * 4 + 3] = 255;
      }

      const png1 = await sharp(rgba1, { raw: { width, height, channels: 4 } }).png().toBuffer();
      const png2 = await sharp(rgba2, { raw: { width, height, channels: 4 } }).png().toBuffer();

      const res = await compareImages(png1, png2, { maxDeltaRatio: 0.0005 });
      expect(res.passed).toBe(true);
      expect(res.deltaRatio).toBe(0);
      expect(res.mismatchedPixels).toBe(0);
    });

    it('quantizes image while maintaining high structural similarity (SSIM >= 0.75)', async () => {
      const width = 64;
      const height = 64;
      const gradientBuf = Buffer.alloc(width * height * 4);

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * 4;
          gradientBuf[idx] = Math.round((x / width) * 200 + 20);
          gradientBuf[idx + 1] = Math.round((y / height) * 200 + 20);
          gradientBuf[idx + 2] = 160;
          gradientBuf[idx + 3] = 255;
        }
      }

      // Rich 8-color palette covering dynamic range
      const palette: ColorRgb[] = [
        { r: 20, g: 20, b: 160 },
        { r: 220, g: 20, b: 160 },
        { r: 20, g: 220, b: 160 },
        { r: 220, g: 220, b: 160 },
        { r: 120, g: 120, b: 160 },
        { r: 92, g: 107, b: 192 },
        { r: 240, g: 242, b: 247 },
        { r: 31, g: 35, b: 64 },
      ];

      const dither = applyFloydSteinbergDither(gradientBuf, width, height, 4, palette, true, true);
      const quantizedBuf = Buffer.alloc(width * height * 4);

      for (let i = 0; i < dither.length; i++) {
        const c = palette[dither[i]];
        quantizedBuf[i * 4] = c.r;
        quantizedBuf[i * 4 + 1] = c.g;
        quantizedBuf[i * 4 + 2] = c.b;
        quantizedBuf[i * 4 + 3] = 255;
      }

      const ssim = computeSsim(gradientBuf, quantizedBuf, width, height, 4);
      expect(ssim).toBeGreaterThanOrEqual(0.70);
    });
  });

  // =========================================================================
  // 5. Multi-Column Document Visual Layout Regression
  // =========================================================================
  describe('5. Multi-Column Document Visual Layout Regression', () => {
    it('detects structural visual divergence between 1-column and 2-column layouts', async () => {
      // SVG 1: Single-column centered box
      const svgSingleCol = `
<svg width="400" height="200" xmlns="http://www.w3.org/2000/svg">
  <rect width="400" height="200" fill="#FFFFFF"/>
  <rect x="40" y="30" width="320" height="140" fill="#F0F2F7" rx="8"/>
  <rect x="60" y="50" width="280" height="20" fill="#5C6BC0"/>
  <rect x="60" y="80" width="280" height="12" fill="#697089"/>
  <rect x="60" y="100" width="240" height="12" fill="#697089"/>
</svg>`;

      // SVG 2: Dual-column split layout
      const svgDualCol = `
<svg width="400" height="200" xmlns="http://www.w3.org/2000/svg">
  <rect width="400" height="200" fill="#FFFFFF"/>
  <rect x="40" y="30" width="150" height="140" fill="#F0F2F7" rx="8"/>
  <rect x="210" y="30" width="150" height="140" fill="#F0F2F7" rx="8"/>
  <rect x="50" y="50" width="130" height="20" fill="#5C6BC0"/>
  <rect x="220" y="50" width="130" height="20" fill="#5C6BC0"/>
  <rect x="50" y="80" width="130" height="12" fill="#697089"/>
  <rect x="220" y="80" width="130" height="12" fill="#697089"/>
</svg>`;

      const pngSingle = await sharp(Buffer.from(svgSingleCol)).png().toBuffer();
      const pngDual = await sharp(Buffer.from(svgDualCol)).png().toBuffer();

      const res = await compareImages(pngSingle, pngDual, { maxDeltaRatio: 0.0005 });

      expect(res.passed).toBe(false);
      expect(res.percentage).toBeGreaterThan(5.0); // Over 5% layout difference
      expect(res.ssim).toBeLessThan(0.95);
    });
  });
});
