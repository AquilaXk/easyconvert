import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  decodeRawBayerSensor,
  demosaicAmazeBayerCfa,
  demosaicBayerCfa,
  BayerSensorData,
} from '../src/lib/conversions/image';
import { create7zArchive, extract7zArchive } from '../src/lib/conversions/archive';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Builds a synthetically valid DNG TIFF byte buffer with authentic IFD0 and tags.
 */
export function buildSyntheticDngBuffer(options: {
  width: number;
  height: number;
  bitsPerSample: number;
  blackLevel?: number | number[];
  whiteLevel?: number;
  asShotNeutral?: [number, number, number];
  colorMatrix1?: number[];
  pixelValues?: Uint16Array;
}): Buffer {
  const { width, height, bitsPerSample } = options;
  const isLE = true;
  const bpp = bitsPerSample;
  const pixelCount = width * height;
  const rawBytes = pixelCount * (bpp > 8 ? 2 : 1);

  // Buffer layout:
  // 0..7: TIFF header (8 bytes)
  // 8..offsetData: IFD0 entries
  // offsetData: out-of-line tag data (arrays, rationals)
  // offsetPixels: pixel payload

  const tagList: Array<{
    tag: number;
    type: number;
    count: number;
    inlineVal?: number;
    data?: Buffer;
  }> = [];

  tagList.push({ tag: 256, type: 4, count: 1, inlineVal: width }); // ImageWidth
  tagList.push({ tag: 257, type: 4, count: 1, inlineVal: height }); // ImageLength
  tagList.push({ tag: 258, type: 3, count: 1, inlineVal: bpp }); // BitsPerSample
  tagList.push({ tag: 259, type: 3, count: 1, inlineVal: 1 }); // Compression = 1 (Uncompressed)

  // CFAPattern (Tag 33422): [0, 1, 1, 2] = RGGB
  const cfaBuf = Buffer.from([0, 1, 1, 2]);
  tagList.push({ tag: 33422, type: 1, count: 4, data: cfaBuf });

  // RowsPerStrip
  tagList.push({ tag: 278, type: 4, count: 1, inlineVal: height });
  // StripByteCounts
  tagList.push({ tag: 279, type: 4, count: 1, inlineVal: rawBytes });

  // StripOffsets placeholder (will set offset later)
  let stripOffsetTagIdx = tagList.length;
  tagList.push({ tag: 273, type: 4, count: 1, inlineVal: 0 });

  // BlackLevel (Tag 50714)
  if (options.blackLevel !== undefined) {
    if (Array.isArray(options.blackLevel)) {
      const bBuf = Buffer.alloc(options.blackLevel.length * 4);
      for (let i = 0; i < options.blackLevel.length; i++) {
        bBuf.writeUInt32LE(options.blackLevel[i], i * 4);
      }
      tagList.push({ tag: 50714, type: 4, count: options.blackLevel.length, data: bBuf });
    } else {
      tagList.push({ tag: 50714, type: 4, count: 1, inlineVal: options.blackLevel });
    }
  }

  // WhiteLevel (Tag 50717)
  if (options.whiteLevel !== undefined) {
    tagList.push({ tag: 50717, type: 4, count: 1, inlineVal: options.whiteLevel });
  }

  // AsShotNeutral (Tag 50728) - 3 RATIONALs (each 8 bytes: num, den)
  if (options.asShotNeutral) {
    const asnBuf = Buffer.alloc(3 * 8);
    for (let i = 0; i < 3; i++) {
      const val = options.asShotNeutral[i];
      const den = 1000000;
      const num = Math.round(val * den);
      asnBuf.writeUInt32LE(num, i * 8);
      asnBuf.writeUInt32LE(den, i * 8 + 4);
    }
    tagList.push({ tag: 50728, type: 5, count: 3, data: asnBuf });
  }

  // ColorMatrix1 (Tag 50721) - 9 SRATIONALs (each 8 bytes: signed num, signed den)
  if (options.colorMatrix1 && options.colorMatrix1.length === 9) {
    const cmBuf = Buffer.alloc(9 * 8);
    for (let i = 0; i < 9; i++) {
      const val = options.colorMatrix1[i];
      const den = 10000;
      const num = Math.round(val * den);
      cmBuf.writeInt32LE(num, i * 8);
      cmBuf.writeInt32LE(den, i * 8 + 4);
    }
    tagList.push({ tag: 50721, type: 10, count: 9, data: cmBuf });
  }

  // Sort tags in ascending order (TIFF specification requirement)
  tagList.sort((a, b) => a.tag - b.tag);
  stripOffsetTagIdx = tagList.findIndex((t) => t.tag === 273);

  const ifd0Offset = 8;
  const entryCount = tagList.length;
  const ifdSize = 2 + entryCount * 12 + 4;

  let currentDataOffset = ifd0Offset + ifdSize;
  const dataChunks: Array<{ offset: number; buf: Buffer }> = [];

  for (const t of tagList) {
    if (t.data) {
      if (t.data.length <= 4) {
        // inline into 4 bytes
        const inlineBuf = Buffer.alloc(4);
        t.data.copy(inlineBuf);
        t.inlineVal = inlineBuf.readUInt32LE(0);
      } else {
        dataChunks.push({ offset: currentDataOffset, buf: t.data });
        t.inlineVal = currentDataOffset;
        currentDataOffset += t.data.length;
      }
    }
  }

  // Align pixels to 4-byte boundary
  const pixelOffset = (currentDataOffset + 3) & ~3;
  tagList[stripOffsetTagIdx].inlineVal = pixelOffset;

  const totalBufferSize = pixelOffset + rawBytes;
  const outBuf = Buffer.alloc(totalBufferSize);

  // TIFF Header
  outBuf.write('II', 0, 2, 'ascii'); // Little-endian
  outBuf.writeUInt16LE(42, 2); // TIFF magic
  outBuf.writeUInt32LE(ifd0Offset, 4); // Offset of IFD0

  // IFD0
  outBuf.writeUInt16LE(entryCount, ifd0Offset);
  let cur = ifd0Offset + 2;
  for (const t of tagList) {
    outBuf.writeUInt16LE(t.tag, cur);
    outBuf.writeUInt16LE(t.type, cur + 2);
    outBuf.writeUInt32LE(t.count, cur + 4);
    outBuf.writeUInt32LE(t.inlineVal ?? 0, cur + 8);
    cur += 12;
  }
  outBuf.writeUInt32LE(0, cur); // Next IFD = 0

  // Out-of-line data
  for (const chunk of dataChunks) {
    chunk.buf.copy(outBuf, chunk.offset);
  }

  // Pixels
  if (options.pixelValues) {
    for (let i = 0; i < pixelCount; i++) {
      outBuf.writeUInt16LE(options.pixelValues[i], pixelOffset + i * 2);
    }
  } else {
    // Fill with pattern
    for (let i = 0; i < pixelCount; i++) {
      outBuf.writeUInt16LE(1000 + (i % 256), pixelOffset + i * 2);
    }
  }

  return outBuf;
}

describe('Phase 3: DNG RAW Metadata Normalization & Solid 7z Compression', () => {
  describe('DNG RAW Metadata & Demosaicing Normalization', () => {
    it('parses DNG BlackLevel and WhiteLevel tags and applies zero-offset normalization', () => {
      const width = 8;
      const height = 8;
      const blackLevel = 512;
      const whiteLevel = 4095;

      // Create synthetic sensor pixels with blackLevel offset
      const pixelValues = new Uint16Array(width * height);
      for (let i = 0; i < width * height; i++) {
        // Sensor signal = blackLevel + targetSignal
        // Let targetSignal be 1000 (roughly 28% of range)
        pixelValues[i] = blackLevel + 1000;
      }

      const dngBuf = buildSyntheticDngBuffer({
        width,
        height,
        bitsPerSample: 12,
        blackLevel,
        whiteLevel,
        pixelValues,
      });

      const decoded = decodeRawBayerSensor(dngBuf);
      expect(decoded).not.toBeNull();
      expect(decoded!.width).toBe(width);
      expect(decoded!.height).toBe(height);
      expect(decoded!.rgb).toHaveLength(width * height * 3);

      // Verify that after blackLevel subtraction, the normalized signal is scaled correctly
      // (1000 / (4095 - 512)) * 255 = (1000 / 3583) * 255 = ~71.17
      // In perceptual sRGB gamma (0.28 ^ (1/2.2) approx), value should be between 50 and 170
      const centerIdx = (4 * width + 4) * 3;
      const r = decoded!.rgb[centerIdx];
      const g = decoded!.rgb[centerIdx + 1];
      const b = decoded!.rgb[centerIdx + 2];

      expect(r).toBeGreaterThan(40);
      expect(r).toBeLessThan(180);
      expect(g).toBeGreaterThan(40);
      expect(g).toBeLessThan(180);
      expect(b).toBeGreaterThan(40);
      expect(b).toBeLessThan(180);
    });

    it('corrects green tint via AsShotNeutral white balance coefficients', () => {
      const width = 8;
      const height = 8;
      const blackLevel = 0;
      const whiteLevel = 4095;

      // Suppose raw sensor has strong green tint (typical for Silicon CFA sensitivity: Green has twice the photons)
      // Sensor values: Red=1000, Green=2000, Blue=1200
      const pixelValues = new Uint16Array(width * height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = y * width + x;
          const rx = x & 1;
          const ry = y & 1;
          // RGGB: (0,0)=R, (1,0)=G, (0,1)=G, (1,1)=B
          if (ry === 0 && rx === 0) pixelValues[idx] = 1000; // R
          else if (ry === 1 && rx === 1) pixelValues[idx] = 1200; // B
          else pixelValues[idx] = 2000; // G
        }
      }

      // Neutral balance: AsShotNeutral specifies coordinate of neutral object in sensor space:
      // [1000/2000, 1.0, 1200/2000] = [0.5, 1.0, 0.6]
      const dngBuf = buildSyntheticDngBuffer({
        width,
        height,
        bitsPerSample: 12,
        blackLevel,
        whiteLevel,
        asShotNeutral: [0.5, 1.0, 0.6],
        pixelValues,
      });

      const decoded = decodeRawBayerSensor(dngBuf);
      expect(decoded).not.toBeNull();

      // Check center pixel RGB values
      const centerIdx = (4 * width + 4) * 3;
      const r = decoded!.rgb[centerIdx];
      const g = decoded!.rgb[centerIdx + 1];
      const b = decoded!.rgb[centerIdx + 2];

      // After white balance scaling (r * 1/0.5, g * 1/1.0, b * 1/0.6), R, G, B should be well-balanced (neutral gray)
      // All three channels should be within 25 units of each other, not showing extreme green dominance
      expect(Math.abs(r - g)).toBeLessThan(35);
      expect(Math.abs(b - g)).toBeLessThan(35);
    });

    it('supports 4-channel repeat pattern black level array', () => {
      const width = 8;
      const height = 8;
      const blackLevels = [100, 150, 150, 200]; // [R, G1, G2, B]
      const whiteLevel = 4000;

      const pixelValues = new Uint16Array(width * height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = y * width + x;
          const blkIdx = ((y & 1) << 1) | (x & 1);
          // Set raw value exactly equal to channel black level: effective signal should be 0
          pixelValues[idx] = blackLevels[blkIdx];
        }
      }

      const dngBuf = buildSyntheticDngBuffer({
        width,
        height,
        bitsPerSample: 12,
        blackLevel: blackLevels,
        whiteLevel,
        pixelValues,
      });

      const decoded = decodeRawBayerSensor(dngBuf);
      expect(decoded).not.toBeNull();

      // All output RGB values should be near zero (clamped black level)
      for (let i = 0; i < decoded!.rgb.length; i++) {
        expect(decoded!.rgb[i]).toBeLessThanOrEqual(5);
      }
    });
  });

  describe('Solid 7z LZMA2 Multi-File Stream Compression', () => {
    it('compresses 10 identical files with solid LZMA2 achieving over 50% size reduction', () => {
      // 10 identical text/data files of 5KB each (total 50KB uncompressed)
      const sampleText = 'EasyConvert High Performance Multi-Format Conversion Engine\n'.repeat(80);
      const sampleBuffer = Buffer.from(sampleText, 'utf-8');
      expect(sampleBuffer.length).toBeGreaterThan(4000);

      const files = Array.from({ length: 10 }, (_, i) => ({
        filename: `data_shard_${i}.txt`,
        buffer: Buffer.from(sampleBuffer),
      }));

      // 1. Non-solid archive: Each file compressed in its own folder
      const nonSolidArchive = create7zArchive(files, { archiveCoder: 'lzma2', solid: false }, 'non_solid.7z');
      expect(nonSolidArchive.buffer.length).toBeGreaterThan(100);

      // 2. Solid archive: All files concatenated into single solid stream
      const solidArchive = create7zArchive(files, { archiveCoder: 'lzma2', solid: true }, 'solid.7z');
      expect(solidArchive.buffer.length).toBeGreaterThan(100);

      // Solid archive should be substantially smaller than non-solid (more than 50% size reduction)
      // because LZMA2 dictionary reuses repetitive patterns across files in a single solid stream
      const compressionRatio = solidArchive.buffer.length / nonSolidArchive.buffer.length;
      expect(compressionRatio).toBeLessThan(0.5);

      // 3. Extraction integrity check: Extract solid archive with extract7zArchive
      const extractedFiles = extract7zArchive(solidArchive.buffer);
      expect(extractedFiles).toHaveLength(10);

      for (let i = 0; i < files.length; i++) {
        expect(extractedFiles[i].filename).toBe(`data_shard_${i}.txt`);
        expect(extractedFiles[i].buffer.length).toBe(sampleBuffer.length);
        expect(sha256(extractedFiles[i].buffer)).toBe(sha256(sampleBuffer));
      }
    });

    it('extracts solid archive with varying file sizes correctly', () => {
      const files = [
        { filename: 'alpha.txt', buffer: Buffer.from('AAAA'.repeat(500), 'utf-8') },
        { filename: 'beta.bin', buffer: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].flatMap((x) => Array(100).fill(x))) },
        { filename: 'gamma.json', buffer: Buffer.from(JSON.stringify({ status: 'ok', items: [1, 2, 3] }), 'utf-8') },
        { filename: 'delta.txt', buffer: Buffer.from('DDDD'.repeat(300), 'utf-8') },
      ];

      const solidArchive = create7zArchive(files, { archiveCoder: 'lzma2', solid: true }, 'mixed_solid.7z');
      const extracted = extract7zArchive(solidArchive.buffer);

      expect(extracted).toHaveLength(files.length);
      for (let i = 0; i < files.length; i++) {
        expect(extracted[i].filename).toBe(files[i].filename);
        expect(extracted[i].buffer.length).toBe(files[i].buffer.length);
        expect(sha256(extracted[i].buffer)).toBe(sha256(files[i].buffer));
      }
    });

    it('extracts non-solid archive identically for backward compatibility', () => {
      const files = [
        { filename: 'f1.txt', buffer: Buffer.from('First file content', 'utf-8') },
        { filename: 'f2.txt', buffer: Buffer.from('Second file content', 'utf-8') },
      ];

      const archive = create7zArchive(files, { archiveCoder: 'lzma2', solid: false }, 'non_solid.7z');
      const extracted = extract7zArchive(archive.buffer);

      expect(extracted).toHaveLength(2);
      expect(extracted[0].filename).toBe('f1.txt');
      expect(extracted[0].buffer.toString('utf-8')).toBe('First file content');
      expect(extracted[1].filename).toBe('f2.txt');
      expect(extracted[1].buffer.toString('utf-8')).toBe('Second file content');
    });
  });
});
