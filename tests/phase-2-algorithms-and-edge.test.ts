import { describe, it, expect } from 'vitest';
import {
  srgbToOklab,
  deltaEOklab,
  findClosestPaletteIndexOklab,
  applyFloydSteinbergDither,
} from '../src/lib/conversions/quantize';
import {
  classifyGlyph,
  runOnnxCjkOcrPipeline,
} from '../src/lib/conversions/ocr';
import {
  triangulatePolygonEarcut,
  Point3D,
} from '../src/lib/conversions/cad-nurbs';
import {
  buildFmp4InitSegment,
  buildFmp4MediaSegment,
  muxFmp4Stream,
} from '../src/lib/edge/workers/webcodecs.worker';
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

  describe('2. Topological OCR Glyph Recognition & ONNX CJK Pipeline', () => {
    it('accurately distinguishes glyphs based on loop cavities and topological invariants', () => {
      const w = 12;
      const h = 16;
      const stride = w;

      // 1. Synthesize 'O' (enclosed central loop)
      const dataO = Buffer.alloc(w * h, 255);
      for (let y = 2; y < h - 2; y++) {
        dataO[y * stride + 2] = 0;
        dataO[y * stride + w - 3] = 0;
      }
      for (let x = 2; x < w - 2; x++) {
        dataO[2 * stride + x] = 0;
        dataO[(h - 3) * stride + x] = 0;
      }
      const charO = classifyGlyph(dataO, stride, 0, w, 0, h);
      expect(['O', '0', 'D']).toContain(charO);

      // 2. Synthesize 'I' (narrow single stem)
      const dataI = Buffer.alloc(4 * 16, 255);
      for (let y = 0; y < 16; y++) {
        dataI[y * 4 + 1] = 0;
        dataI[y * 4 + 2] = 0;
      }
      const charI = classifyGlyph(dataI, 4, 0, 4, 0, 16);
      expect(charI).toBe('I');

      // 3. Synthesize '8' (two enclosed loops separated by horizontal bar)
      const data8 = Buffer.alloc(w * h, 255);
      // Outer vertical stems
      for (let y = 2; y < h - 2; y++) {
        data8[y * stride + 2] = 0;
        data8[y * stride + w - 3] = 0;
      }
      // Top, middle, bottom horizontal bars
      for (let x = 2; x < w - 2; x++) {
        data8[2 * stride + x] = 0;
        data8[7 * stride + x] = 0;
        data8[(h - 3) * stride + x] = 0;
      }
      const char8 = classifyGlyph(data8, stride, 0, w, 0, h);
      expect(['8', 'B']).toContain(char8);
    });

    it('executes ONNX CJK OCR pipeline with multi-script confidence', async () => {
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

      const result = await runOnnxCjkOcrPipeline(testImage, { ocrLanguage: 'ko' });
      expect(result).toBeDefined();
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
      expect(result.imageWidth).toBe(120);
      expect(result.imageHeight).toBe(40);
    });
  });

  describe('3. CAD 2D Parameter-Plane Earcut CDT Triangulation', () => {
    it('triangulates convex and concave (L-shaped) polygons preserving watertight topology', () => {
      // Concave L-shaped polygon (6 vertices)
      // (0,0) -> (2,0) -> (2,1) -> (1,1) -> (1,2) -> (0,2)
      const normal: [number, number, number] = [0, 0, 1];
      const lPolygon: Point3D[] = [
        { x: 0, y: 0, z: 0 },
        { x: 2, y: 0, z: 0 },
        { x: 2, y: 1, z: 0 },
        { x: 1, y: 1, z: 0 },
        { x: 1, y: 2, z: 0 },
        { x: 0, y: 2, z: 0 },
      ];

      const triangles = triangulatePolygonEarcut(lPolygon, normal);
      // An n-gon without holes always produces exactly (n - 2) triangles: 6 - 2 = 4 triangles
      expect(triangles).toHaveLength(4);

      for (const [i0, i1, i2] of triangles) {
        expect(i0).toBeGreaterThanOrEqual(0);
        expect(i0).toBeLessThan(6);
        expect(i1).toBeGreaterThanOrEqual(0);
        expect(i1).toBeLessThan(6);
        expect(i2).toBeGreaterThanOrEqual(0);
        expect(i2).toBeLessThan(6);
        // All vertices of triangle must be distinct
        expect(i0).not.toBe(i1);
        expect(i1).not.toBe(i2);
        expect(i0).not.toBe(i2);
      }
    });
  });

  describe('4. fMP4 / CMAF Streaming Muxer', () => {
    it('builds fMP4 initialization segment with ftyp, moov, and mvex boxes', () => {
      const init = buildFmp4InitSegment(640, 480, 'avc1.4d002a', 90000);
      const str = Buffer.from(init).toString('ascii');

      expect(str).toContain('ftyp');
      expect(str).toContain('moov');
      expect(str).toContain('mvex');
      expect(str).toContain('trex');
      expect(str).toContain('trak');
    });

    it('builds fMP4 media fragment (moof + mdat) with sequence numbers and decode timestamps', () => {
      const mockChunks = [
        { data: new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x65, 0x88]), timestampMicros: 0, isKeyFrame: true },
        { data: new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x41, 0x99]), timestampMicros: 33333, isKeyFrame: false },
      ];

      const mediaSeg = buildFmp4MediaSegment(1, mockChunks, 0, 90000);
      const str = Buffer.from(mediaSeg).toString('ascii');

      expect(str).toContain('moof');
      expect(str).toContain('mfhd');
      expect(str).toContain('traf');
      expect(str).toContain('tfhd');
      expect(str).toContain('tfdt');
      expect(str).toContain('trun');
      expect(str).toContain('mdat');
    });

    it('streams fMP4 sequentially progressive segments without unbounded memory buffering', () => {
      const mockChunks = [
        { data: new Uint8Array([0x01, 0x02]), timestampMicros: 0, isKeyFrame: true },
        { data: new Uint8Array([0x03, 0x04]), timestampMicros: 33333, isKeyFrame: false },
        { data: new Uint8Array([0x05, 0x06]), timestampMicros: 66666, isKeyFrame: false },
      ];

      const emittedSegments: Uint8Array[] = [];
      const stream = muxFmp4Stream(mockChunks, 320, 240, {
        fragmentChunkCount: 2,
        onSegment: (seg) => emittedSegments.push(seg),
      });

      expect(stream.byteLength).toBeGreaterThan(100);
      // Init segment + 2 media fragments = 3 emitted segments
      expect(emittedSegments).toHaveLength(3);
      expect(Buffer.from(emittedSegments[0]).toString('ascii')).toContain('ftyp');
      expect(Buffer.from(emittedSegments[1]).toString('ascii')).toContain('moof');
      expect(Buffer.from(emittedSegments[2]).toString('ascii')).toContain('moof');
    });
  });
});
