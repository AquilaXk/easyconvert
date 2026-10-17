import { describe, it, expect } from 'vitest';
import {
  encodeWoff2,
  decodeWoff2,
  encodeUIntBase128,
  decodeUIntBase128,
  parseFontToSfnt,
  createCanonicalFont,
  WOFF2_KNOWN_TAGS,
} from '../src/lib/conversions/font';

import { convertVectorCad } from '../src/lib/conversions/vector-cad';
import { convertImage } from '../src/lib/conversions/image';
import {
  applyRgbaGrayscale,
  applyRgbaBrightness,
  applyRgbaInvert,
} from '../src/lib/edge/workers/wasm-engine.worker';
import sharp from 'sharp';

describe('Phase 2: Commercial-grade Engine Stack Integration', () => {
  describe('2. Level 2 Wasm SIMD Pixel Manipulation', () => {
    it('applies fixed-point integer RGBA grayscale with alpha channel preservation', () => {
      // 4 pixels: Red, Green, Blue, White with various alphas
      const rgba = new Uint8Array([
        255, 0, 0, 255,   // Pure Red
        0, 255, 0, 200,   // Pure Green
        0, 0, 255, 128,   // Pure Blue
        255, 255, 255, 64 // White
      ]);

      const gray = applyRgbaGrayscale(rgba);
      expect(gray).toHaveLength(16);

      // Y = (77*R + 150*G + 29*B) >> 8
      expect(gray[0]).toBe((77 * 255) >> 8); // 76
      expect(gray[1]).toBe(gray[0]);
      expect(gray[2]).toBe(gray[0]);
      expect(gray[3]).toBe(255); // Alpha preserved

      expect(gray[4]).toBe((150 * 255) >> 8); // 149
      expect(gray[7]).toBe(200);

      expect(gray[8]).toBe((29 * 255) >> 8); // 28
      expect(gray[11]).toBe(128);

      expect(gray[12]).toBe(255); // (77*255 + 150*255 + 29*255) >> 8
      expect(gray[15]).toBe(64);
    });

    it('inverts and adjusts brightness within [0, 255] bounds', () => {
      const rgba = new Uint8Array([10, 20, 250, 255]);
      const inverted = applyRgbaInvert(rgba);
      expect(inverted[0]).toBe(245);
      expect(inverted[1]).toBe(235);
      expect(inverted[2]).toBe(5);
      expect(inverted[3]).toBe(255);

      const brightened = applyRgbaBrightness(rgba, 30);
      expect(brightened[0]).toBe(40);
      expect(brightened[1]).toBe(50);
      expect(brightened[2]).toBe(255); // Clamped
      expect(brightened[3]).toBe(255);
    });
  });

  describe('3. W3C Compliant WOFF2 Table Directory and UIntBase128', () => {
    it('encodes and decodes variable-length UIntBase128 values correctly', () => {
      const testCases = [0, 1, 63, 127, 128, 255, 256, 16383, 16384, 65535, 1048576];
      for (const val of testCases) {
        const encoded = encodeUIntBase128(val);
        expect(encoded.length).toBeGreaterThanOrEqual(1);
        expect(encoded.length).toBeLessThanOrEqual(5);

        const decoded = decodeUIntBase128(Buffer.from(encoded), { offset: 0 });
        expect(decoded).toBe(val);
      }
    });

    it('encodes WOFF2 with standard Table Directory and roundtrips with decodeWoff2', () => {
      const canonical = createCanonicalFont(Buffer.alloc(0), 'SampleFont');
      expect(Object.keys(canonical.tables).length).toBeGreaterThan(0);

      const woff2Buffer = encodeWoff2(canonical);

      // Verify WOFF2 header
      expect(woff2Buffer.toString('ascii', 0, 4)).toBe('wOF2');
      expect(woff2Buffer.readUInt32BE(4)).toBe(0x00010000); // flavor
      expect(woff2Buffer.readUInt32BE(8)).toBe(woff2Buffer.length); // total length
      expect(woff2Buffer.readUInt16BE(12)).toBe(Object.keys(canonical.tables).length);

      // Roundtrip decode
      const decodedFont = decodeWoff2(woff2Buffer, 'SampleFont');
      expect(decodedFont.numTables).toBe(Object.keys(canonical.tables).length);
      expect(decodedFont.tables['head']).toBeDefined();
    });
  });

  describe('5. Camera RAW Engine & Metadata Integrity', () => {
    it('extracts embedded high-resolution JPEG preview from camera RAW files (CR2, NEF, ARW, DNG)', async () => {
      // Create a valid 100x100 JPEG to simulate camera embedded preview stream
      const sampleJpeg = await sharp({
        create: {
          width: 100,
          height: 100,
          channels: 3,
          background: { r: 120, g: 150, b: 200 },
        },
      })
        .jpeg({ quality: 90 })
        .toBuffer();

      // Wrap sample JPEG inside mock CR2/DNG raw container payload with raw header
      const rawHeader = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x10, 0x00, 0x00, 0x00]); // TIFF LE header
      const mockRawPayload = Buffer.concat([rawHeader, Buffer.alloc(64, 0), sampleJpeg]);

      const rawFormats = ['cr2', 'nef', 'arw', 'dng'];

      for (const fmt of rawFormats) {
        const res = await convertImage(mockRawPayload, 'png', { allowEmbeddedPreview: true }, `photo.${fmt}`, fmt);
        expect(res.isEmbeddedPreview).toBe(true);
        expect(res.filename).toBe('photo.png');
        expect(res.mimeType).toBe('image/png');
        expect(res.size).toBeGreaterThan(0);

        // Verify the output image dimensions match the extracted embedded JPEG
        const metadata = await sharp(res.buffer).metadata();
        expect(metadata.width).toBe(100);
        expect(metadata.height).toBe(100);
      }
    });

    it('fails closed when camera RAW stream is corrupted or truncated without decoder', async () => {
      const corruptedRaw = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x00, 0x00]); // Truncated TIFF
      await expect(
        convertImage(corruptedRaw, 'png', {}, 'corrupted.cr2', 'cr2')
      ).rejects.toThrow(/Unable to decode RAW camera sensor data|Unsupported camera RAW format/);
    });
  });
});
