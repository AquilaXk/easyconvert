import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decodeRawBayerSensor,
  demosaicAmazeBayerCfa,
  demosaicBayerCfa,
  BayerSensorData,
} from '../src/lib/conversions/image';
import { create7zArchive, extract7zArchive } from '../src/lib/conversions/archive';
import { requireOracleTool } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { readTiff16 } from './raw-demosaic/tiff16';

const FRAME_SIZE = 64;
const CENTRE = FRAME_SIZE / 2;
const RGB_CHANNELS = 3;
const FULL_SCALE = 65535;
/** Pixels left out of the PSNR at each edge, where interpolators differ in how they treat the border. */
const BORDER_PIXELS = 6;
/** The linear output must be at least this close to the reference decoder's (dB). */
const MIN_PSNR_DB = 40;
const DCRAW_TIMEOUT_MS = 60_000;
/**
 * DNG ColorMatrix1 (XYZ D50 to camera) of a camera whose native space is linear sRGB: the IEC 61966-2-1 XYZ(D65) to
 * sRGB matrix times the Bradford D50 to D65 adaptation. A decoder that applies the profile then returns the sensor
 * values unchanged, which is also what dcraw_emu -o 0 writes.
 */
const SRGB_CAMERA_COLOR_MATRIX = [
  3.2404542 * 0.9555766 + -1.5371385 * -0.0282895 + -0.4985314 * 0.0122982,
  3.2404542 * -0.0230393 + -1.5371385 * 1.0099416 + -0.4985314 * -0.020483,
  3.2404542 * 0.0631636 + -1.5371385 * 0.0210077 + -0.4985314 * 1.3299098,
  -0.969266 * 0.9555766 + 1.8760108 * -0.0282895 + 0.041556 * 0.0122982,
  -0.969266 * -0.0230393 + 1.8760108 * 1.0099416 + 0.041556 * -0.020483,
  -0.969266 * 0.0631636 + 1.8760108 * 0.0210077 + 0.041556 * 1.3299098,
  0.0556434 * 0.9555766 + -0.2040259 * -0.0282895 + 1.0572252 * 0.0122982,
  0.0556434 * -0.0230393 + -0.2040259 * 1.0099416 + 1.0572252 * -0.020483,
  0.0556434 * 0.0631636 + -0.2040259 * 0.0210077 + 1.0572252 * 1.3299098,
];

/** TIFF PhotometricInterpretation value of a colour filter array image (DNG specification, Chapter 2). */
const PHOTOMETRIC_CFA = 32803;
/** Little-endian inline value of two SHORTs, both 2: the CFA repeats every 2 x 2 pixels. */
const CFA_REPEAT_2X2 = 0x00020002;
/** Little-endian inline value of the four DNGVersion bytes 1, 4, 0, 0. */
const DNG_VERSION_1_4 = 0x00000401;

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
  tagList.push({ tag: 262, type: 3, count: 1, inlineVal: PHOTOMETRIC_CFA }); // PhotometricInterpretation = CFA
  tagList.push({ tag: 277, type: 3, count: 1, inlineVal: 1 }); // SamplesPerPixel
  // CFARepeatPatternDim (Tag 33421): a 2 x 2 repeat, two SHORTs held inline
  tagList.push({ tag: 33421, type: 3, count: 2, inlineVal: CFA_REPEAT_2X2 });
  // DNGVersion (Tag 50706): 1.4.0.0, four BYTEs held inline
  tagList.push({ tag: 50706, type: 1, count: 4, inlineVal: DNG_VERSION_1_4 });

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
      // BlackLevelRepeatDim (Tag 50713): the four levels repeat over a 2 x 2 block
      tagList.push({ tag: 50713, type: 3, count: 2, inlineVal: CFA_REPEAT_2X2 });
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
    /** Writes `dng` to a temporary directory, runs dcraw_emu on it with `args` and reads back its 16-bit linear TIFF. */
    function dcrawEmu(dng: Buffer, args: string[]): { data: Uint16Array; width: number; height: number } {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'dng-oracle-'));
      try {
        const file = path.join(dir, 'frame.dng');
        writeFileSync(file, dng);
        execFileSync(requireOracleTool('dcraw_emu'), [...args, file], { stdio: 'pipe', timeout: DCRAW_TIMEOUT_MS });
        return readTiff16(`${file}.tiff`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    /** PSNR in dB of our 16-bit RGB against the reference over the frame without its border; peak is the brightest reference sample. */
    function interiorPsnr(ours: Uint16Array, reference: Uint16Array, width: number, height: number): number {
      let sum = 0;
      let count = 0;
      let peak = 0;
      for (let y = BORDER_PIXELS; y < height - BORDER_PIXELS; y++) {
        for (let x = BORDER_PIXELS; x < width - BORDER_PIXELS; x++) {
          for (let c = 0; c < RGB_CHANNELS; c++) {
            const at = (y * width + x) * RGB_CHANNELS + c;
            sum += (ours[at] - reference[at]) * (ours[at] - reference[at]);
            peak = Math.max(peak, reference[at]);
            count += 1;
          }
        }
      }
      return sum === 0 ? Infinity : 10 * Math.log10((peak * peak) / (sum / count));
    }

    /** Smooth per-channel gradients: the demosaic error of any sound interpolator stays far below the PSNR floor. */
    function gradientFrame(channelGain: [number, number, number], base: (x: number, y: number) => number, blackOf: (x: number, y: number) => number): Uint16Array {
      const pixels = new Uint16Array(FRAME_SIZE * FRAME_SIZE);
      for (let y = 0; y < FRAME_SIZE; y++) {
        for (let x = 0; x < FRAME_SIZE; x++) {
          // RGGB: (even row, even column) is red, (odd row, odd column) is blue, the other two sites are green.
          let gain = channelGain[1];
          if ((y & 1) === 0 && (x & 1) === 0) gain = channelGain[0];
          if ((y & 1) === 1 && (x & 1) === 1) gain = channelGain[2];
          pixels[y * FRAME_SIZE + x] = blackOf(x, y) + Math.round(base(x, y) * gain);
        }
      }
      return pixels;
    }

    const decodeLinear = (dng: Buffer) => decodeRawBayerSensor(dng, 'dng', { targetColorSpace: 'linear', highlightReconstruction: false })!;

    oracleTest('applies BlackLevel and WhiteLevel like LibRaw: linear output within 40 dB of dcraw_emu -4 -T', ['dcraw_emu'], () => {
      const blackLevel = 512;
      const whiteLevel = 4095;
      const signal = (x: number, y: number) => 400 + 20 * x + 10 * y;
      const dng = buildSyntheticDngBuffer({
        width: FRAME_SIZE,
        height: FRAME_SIZE,
        bitsPerSample: 16,
        blackLevel,
        whiteLevel,
        colorMatrix1: SRGB_CAMERA_COLOR_MATRIX,
        pixelValues: gradientFrame([1, 1, 1], signal, () => blackLevel),
      });

      const decoded = decodeLinear(dng);
      const reference = dcrawEmu(dng, ['-4', '-T', '-o', '0', '-r', '1', '1', '1', '1', '-H', '0', '-t', '0']);
      expect({ width: decoded.width, height: decoded.height }).toEqual({ width: reference.width, height: reference.height });
      expect(interiorPsnr(decoded.rgb16!, reference.data, reference.width, reference.height)).toBeGreaterThanOrEqual(MIN_PSNR_DB);

      // Hand-computed from the DNG linearization formula (raw - black) / (white - black): a pixel with 1000 above black is 1000 / 3583 of full scale.
      const centre = (CENTRE * FRAME_SIZE + CENTRE) * RGB_CHANNELS;
      const expected = (signal(CENTRE, CENTRE) / (whiteLevel - blackLevel)) * FULL_SCALE;
      expect(Math.abs(decoded.rgb16![centre + 1] - expected)).toBeLessThan(expected * 0.02);
    });

    oracleTest('scales channels by AsShotNeutral like LibRaw camera white balance: within 40 dB of dcraw_emu -4 -T -w', ['dcraw_emu'], () => {
      const whiteLevel = 4095;
      // A green-tinted sensor: neutral grey records R : G : B = 0.5 : 1 : 0.6, so the multipliers are 2 : 1 : 1.667.
      const asShotNeutral: [number, number, number] = [0.5, 1.0, 0.6];
      const dng = buildSyntheticDngBuffer({
        width: FRAME_SIZE,
        height: FRAME_SIZE,
        bitsPerSample: 16,
        blackLevel: 0,
        whiteLevel,
        asShotNeutral,
        colorMatrix1: SRGB_CAMERA_COLOR_MATRIX,
        pixelValues: gradientFrame(asShotNeutral, (x, y) => 800 + 15 * x + 8 * y, () => 0),
      });

      const decoded = decodeLinear(dng);
      const reference = dcrawEmu(dng, ['-4', '-T', '-w', '-o', '0', '-H', '0', '-t', '0']);
      expect(interiorPsnr(decoded.rgb16!, reference.data, reference.width, reference.height)).toBeGreaterThanOrEqual(MIN_PSNR_DB);

      // The sensor saw neutral grey, so after white balance the three channels agree: R, G and B of the centre pixel are within 2 % of each other.
      const centre = (CENTRE * FRAME_SIZE + CENTRE) * RGB_CHANNELS;
      const [r, g, b] = [decoded.rgb16![centre], decoded.rgb16![centre + 1], decoded.rgb16![centre + 2]];
      expect(Math.abs(r - g)).toBeLessThan(g * 0.02);
      expect(Math.abs(b - g)).toBeLessThan(g * 0.02);
    });

    oracleTest('subtracts a 4-channel repeating BlackLevel like LibRaw: within 40 dB of dcraw_emu -4 -T, and black is zero', ['dcraw_emu'], () => {
      const blackLevels = [100, 150, 150, 200]; // [R, G1, G2, B]
      const whiteLevel = 4000;
      const blackOf = (x: number, y: number) => blackLevels[((y & 1) << 1) | (x & 1)];
      const dng = buildSyntheticDngBuffer({
        width: FRAME_SIZE,
        height: FRAME_SIZE,
        bitsPerSample: 16,
        blackLevel: blackLevels,
        whiteLevel,
        colorMatrix1: SRGB_CAMERA_COLOR_MATRIX,
        pixelValues: gradientFrame([1, 1, 1], (x, y) => 300 + 18 * x + 9 * y, blackOf),
      });

      const decoded = decodeLinear(dng);
      const reference = dcrawEmu(dng, ['-4', '-T', '-o', '0', '-r', '1', '1', '1', '1', '-H', '0', '-t', '0']);
      // LibRaw divides every channel by the range above the red black level (WhiteLevel - 100); this decoder divides
      // each channel by the range above its own black level. The subtraction is what is under test, so the reference
      // is brought onto the per-channel range before the comparison.
      const channelBlack = [blackLevels[0], blackLevels[1], blackLevels[3]];
      const rescaled = new Uint16Array(reference.data.length);
      for (let i = 0; i < rescaled.length; i++) {
        const c = i % RGB_CHANNELS;
        rescaled[i] = Math.round((reference.data[i] * (whiteLevel - channelBlack[0])) / (whiteLevel - channelBlack[c]));
      }
      expect(interiorPsnr(decoded.rgb16!, rescaled, reference.width, reference.height)).toBeGreaterThanOrEqual(MIN_PSNR_DB);

      // Hand-computed: the ramp is linear, so every channel of the centre pixel is the ramp value over its own range.
      const centre = (CENTRE * FRAME_SIZE + CENTRE) * RGB_CHANNELS;
      const ramp = 300 + 18 * CENTRE + 9 * CENTRE;
      for (let c = 0; c < RGB_CHANNELS; c++) {
        const expected = (ramp / (whiteLevel - channelBlack[c])) * FULL_SCALE;
        expect(Math.abs(decoded.rgb16![centre + c] - expected), `channel ${c}`).toBeLessThan(expected * 0.01);
      }

      // A frame whose every pixel equals its own channel's black level carries no signal: every output sample is zero.
      const dark = buildSyntheticDngBuffer({
        width: FRAME_SIZE,
        height: FRAME_SIZE,
        bitsPerSample: 16,
        blackLevel: blackLevels,
        whiteLevel,
        colorMatrix1: SRGB_CAMERA_COLOR_MATRIX,
        pixelValues: gradientFrame([0, 0, 0], () => 0, blackOf),
      });
      const darkDecoded = decodeLinear(dark);
      expect(Math.max(...darkDecoded.rgb16!)).toBe(0);
      expect(Math.max(...dcrawEmu(dark, ['-4', '-T', '-o', '0', '-r', '1', '1', '1', '1', '-H', '0', '-t', '0']).data)).toBe(0);
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
