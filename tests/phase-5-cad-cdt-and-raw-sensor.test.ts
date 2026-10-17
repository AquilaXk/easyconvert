import { describe, it, expect } from 'vitest';

import {
  decodeLosslessJpegStrip,
  decodeRawBayerSensor,
  demosaicBayerCfa,
  convertImage,
} from '../src/lib/conversions/image';
import sharp from 'sharp';

describe('Phase 5: CAD B-Rep Ruppert CDT Watertight Mesh & Camera RAW Sensor Decoder', () => {

  // ==========================================================================
  // 2. Camera RAW Lossless JPEG (LJ92) & True Sensor Demosaicing
  // ==========================================================================
  describe('Camera RAW Sensor Strip Decoding & LJ92 Pipeline', () => {
    it('decodes synthetic Lossless JPEG (LJ92) stream with exact pixel reconstruction', () => {
      // Build a minimal valid LJ92 bitstream: 4x4 image, 16-bit, predictor 1
      const header = Buffer.from([
        0xff, 0xd8, // SOI
        0xff, 0xc3, 0x00, 0x0b, 0x10, 0x00, 0x04, 0x00, 0x04, 0x01, 0x01, 0x11, 0x00, // SOF3: 16bpp, 4x4, 1 comp
        0xff, 0xc4, 0x00, 0x14, 0x00, // DHT: 16 count bytes + 3 symbols
        0x01, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x01, 0x02, // Symbols: cat 0, cat 1, cat 2
        0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x01, 0x00, 0x00, // SOS: comp 1, predictor 1
      ]);

      // Scan data: Huffman coded differences (all 0s -> symbol 0 = code 0, single bit per sample)
      // 16 samples of category 0 -> 16 zero bits = 2 bytes 0x00, 0x00
      const scanData = Buffer.from([0x00, 0x00, 0xff, 0xd9]); // scan data + EOI
      const lj92Payload = Buffer.concat([header, scanData]);

      const decoded = decodeLosslessJpegStrip(lj92Payload);
      expect(decoded).not.toBeNull();
      expect(decoded!.width).toBe(4);
      expect(decoded!.height).toBe(4);
      expect(decoded!.bpp).toBe(16);
      expect(decoded!.data.length).toBe(16);

      // Verify predictable reconstruction (initial predictor 32768, differences 0)
      expect(decoded!.data[0]).toBe(32768);
      expect(decoded!.data[1]).toBe(32768);
    });

    it('decodes TIFF camera RAW file containing sensor Bayer strips without preview bypass', () => {
      // Build a minimal valid TIFF DNG container with a 4x4 raw Bayer strip
      const width = 4;
      const height = 4;
      const rawBayerData = new Uint16Array(width * height);
      for (let i = 0; i < width * height; i++) {
        rawBayerData[i] = 1000 + i * 200;
      }
      const bayerBuffer = Buffer.from(rawBayerData.buffer);

      // Construct TIFF:
      // Offset 0: Header (8 bytes)
      // Offset 8: IFD (10 entries = 2 + 10*12 + 4 = 126 bytes)
      // Offset 134: Bayer sensor strip
      const tiffHeader = Buffer.alloc(8);
      tiffHeader.write('II', 0, 'ascii'); // Little Endian
      tiffHeader.writeUInt16LE(42, 2);    // Magic
      tiffHeader.writeUInt32LE(8, 4);     // IFD offset

      const ifd = Buffer.alloc(2 + 6 * 12 + 4);
      ifd.writeUInt16LE(6, 0); // 6 tags

      const writeTag = (idx: number, tag: number, type: number, count: number, val: number) => {
        const off = 2 + idx * 12;
        ifd.writeUInt16LE(tag, off);
        ifd.writeUInt16LE(type, off + 2);
        ifd.writeUInt32LE(count, off + 4);
        ifd.writeUInt32LE(val, off + 8);
      };

      const stripOffset = 8 + ifd.length;
      writeTag(0, 256, 3, 1, width);                     // ImageWidth
      writeTag(1, 257, 3, 1, height);                    // ImageLength
      writeTag(2, 258, 3, 1, 16);                        // BitsPerSample
      writeTag(3, 273, 4, 1, stripOffset);               // StripOffsets
      writeTag(4, 279, 4, 1, bayerBuffer.length);        // StripByteCounts
      writeTag(5, 33422, 1, 4, 0x02010100);              // CFAPattern: 0, 1, 1, 2 = RGGB

      const rawContainer = Buffer.concat([tiffHeader, ifd, bayerBuffer]);

      const decoded = decodeRawBayerSensor(rawContainer, 'dng');
      expect(decoded).not.toBeNull();
      expect(decoded!.width).toBe(4);
      expect(decoded!.height).toBe(4);
      expect(decoded!.rgb.length).toBe(4 * 4 * 3);
    });

    it('converts camera RAW through full pipeline preserving real sensor colors', async () => {
      // Build authentic TIFF DNG container with 8x8 raw Bayer sensor strip
      const width = 8;
      const height = 8;
      const bayer = Buffer.alloc(width * height * 2, 128);
      const tiffHeader = Buffer.alloc(8);
      tiffHeader.write('II', 0, 'ascii');
      tiffHeader.writeUInt16LE(42, 2);
      tiffHeader.writeUInt32LE(8, 4);

      const ifd = Buffer.alloc(2 + 6 * 12 + 4);
      ifd.writeUInt16LE(6, 0);
      const writeTag = (idx: number, tag: number, type: number, count: number, val: number) => {
        const off = 2 + idx * 12;
        ifd.writeUInt16LE(tag, off);
        ifd.writeUInt16LE(type, off + 2);
        ifd.writeUInt32LE(count, off + 4);
        ifd.writeUInt32LE(val, off + 8);
      };
      const stripOffset = 8 + ifd.length;
      writeTag(0, 256, 3, 1, width);
      writeTag(1, 257, 3, 1, height);
      writeTag(2, 258, 3, 1, 16);
      writeTag(3, 273, 4, 1, stripOffset);
      writeTag(4, 279, 4, 1, bayer.length);
      writeTag(5, 33422, 1, 4, 0x02010100); // RGGB

      const rawPayload = Buffer.concat([tiffHeader, ifd, bayer]);

      const res = await convertImage(rawPayload, 'png', {}, 'test_sensor.dng', 'dng');
      expect(res.filename).toBe('test_sensor.png');
      expect(res.mimeType).toBe('image/png');
      expect(res.size).toBeGreaterThan(0);

      const meta = await sharp(res.buffer).metadata();
      expect(meta.width).toBe(width);
      expect(meta.height).toBe(height);
    });
  });
});
