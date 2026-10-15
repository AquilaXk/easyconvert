import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { floatToHalfBits, halfBitsToFloat, writeOpenExr, writeRgbOpenExr } from './helpers/openexr-writer';
import { decodeExrWithFfmpeg, probeExr, probeStill } from './helpers/ffmpeg-exr';
import { skipWithoutTools } from './helpers/strict-skip';
import { parseUltraHdrStructure, readHdrgmAttribute } from './helpers/ultrahdr-builder';
import {
  buildPatchExr,
  buildPatchUltraHdr,
  HDR_IMAGE_HEIGHT,
  HDR_IMAGE_WIDTH,
  PATCHES,
  patchCentreMean,
  ULTRA_HDR_GAIN_BYTES,
  ULTRA_HDR_METADATA,
  ultraHdrSdrPatch,
} from './helpers/hdr-test-images';

/** FFmpeg decodes the OpenEXR files these suites write; both tools are needed. */
const SKIP_WITHOUT_FFMPEG_EXR = skipWithoutTools('ffmpeg', 'ffprobe');

/**
 * Validates the independent EXR writer and Ultra HDR builder that feed the HDR conversion suites.
 * The EXR writer is checked against the FFmpeg exr decoder and the IEEE 754 binary16 table; the
 * Ultra HDR builder against a separate marker/MPF parse and sharp's JPEG decoder. Neither check
 * uses the conversion engine.
 */

const HALF_TABLE: readonly [number, number][] = [
  [0, 0x0000],
  [1, 0x3c00],
  [-2, 0xc000],
  [0.5, 0x3800],
  [65504, 0x7bff],
  [65520, 0x7c00], // rounds up to infinity
  [Number.POSITIVE_INFINITY, 0x7c00],
  [2 ** -14, 0x0400], // smallest normal
  [2 ** -24, 0x0001], // smallest subnormal
  [2 ** -25, 0x0000], // halfway to the smallest subnormal rounds to even (zero)
  [1.5 * 2 ** -25, 0x0001],
  [0.1, 0x2e66],
  [1 + 2 ** -11, 0x3c00], // tie rounds to even mantissa
  [1 + 3 * 2 ** -11, 0x3c02], // tie rounds to even mantissa
  [3.14159274, 0x4248],
];

const TWO_BYTES = 2;
const FFPROBE_FLOAT_PIX_FMT = 'gbrpf32le';

describe('floatToHalfBits', () => {
  it.each(HALF_TABLE)('encodes %s as 0x%s bits', (value, bits) => {
    expect(floatToHalfBits(value)).toBe(bits);
  });

  it('encodes NaN with the exponent field all ones and a non-zero mantissa', () => {
    const bits = floatToHalfBits(Number.NaN);
    expect(bits & 0x7c00).toBe(0x7c00);
    expect(bits & 0x03ff).not.toBe(0);
  });

  it('round-trips every finite binary16 bit pattern', () => {
    for (let bits = 0; bits <= 0xffff; bits++) {
      const exponentField = (bits >>> 10) & 0x1f;
      if (exponentField === 0x1f) continue;
      expect(floatToHalfBits(halfBitsToFloat(bits))).toBe(bits);
    }
  });
});

describe('writeOpenExr', () => {
  it('lays out magic, version, attributes, offset table and scanline blocks per the specification', () => {
    const rgb = new Float32Array([0.5, 0.25, 4, 1, 0, 0.1]);
    const file = writeRgbOpenExr(rgb, 2, 1, 'half');
    expect([...file.subarray(0, 4)]).toEqual([0x76, 0x2f, 0x31, 0x01]);
    expect(file.readUInt32LE(4)).toBe(2);

    const headerText = file.toString('latin1', 0, 400);
    for (const attr of ['channels', 'compression', 'dataWindow', 'displayWindow', 'lineOrder', 'pixelAspectRatio', 'screenWindowCenter', 'screenWindowWidth']) {
      expect(headerText).toContain(`${attr}\0`);
    }
    // Channel list names are stored in alphabetical order: B, G, R.
    const chlistAt = file.indexOf('chlist\0');
    const sizeAt = chlistAt + 'chlist\0'.length;
    const chlist = file.subarray(sizeAt + 4, sizeAt + 4 + file.readUInt32LE(sizeAt));
    expect(chlist.toString('latin1').replace(/[^A-Z]/g, '')).toBe('BGR');

    // One offset (uint64) per scanline, pointing at a block that starts with its y coordinate.
    const blockBytes = 4 + 4 + 2 * 3 * TWO_BYTES;
    const blockOffset = Number(file.readBigUInt64LE(file.length - blockBytes - 8));
    expect(blockOffset).toBe(file.length - blockBytes);
    expect(file.readInt32LE(blockOffset)).toBe(0);
    expect(file.readInt32LE(blockOffset + 4)).toBe(2 * 3 * TWO_BYTES);
    // B plane first (4 -> 0x4400, 0.1 -> 0x2e66), then G, then R.
    expect(file.readUInt16LE(blockOffset + 8)).toBe(0x4400);
    expect(file.readUInt16LE(blockOffset + 8 + TWO_BYTES)).toBe(0x2e66);
  });

  it('rejects channels whose length disagrees with the data window', () => {
    expect(() =>
      writeOpenExr({ width: 2, height: 2, channels: { R: new Float32Array(3) }, sampleType: 'half' })
    ).toThrow(/expected 4/);
  });

  it.skipIf(SKIP_WITHOUT_FFMPEG_EXR)('decodes in FFmpeg with the written dimensions, pixel format and half-quantised values', () => {
    const rgb = new Float32Array([0.5, 0.25, 4, 1, 0, 0.1, 0.0, 0.2, 0.3, 8, 8, 8]);
    const file = writeRgbOpenExr(rgb, 2, 2, 'half');
    const info = probeExr(file);
    expect(info).toMatchObject({ codec: 'exr', width: 2, height: 2, pixFmt: FFPROBE_FLOAT_PIX_FMT });
    const decoded = decodeExrWithFfmpeg(file);
    const expected = Array.from(rgb, (v) => halfBitsToFloat(floatToHalfBits(v)));
    expect(Array.from(decoded.rgb)).toEqual(expected);
    // Half quantisation is visible: 0.2 is not representable exactly.
    expect(decoded.rgb[7]).toBeCloseTo(0.19995117, 7);
  });

  it.skipIf(SKIP_WITHOUT_FFMPEG_EXR)('decodes FLOAT channels bit-exactly in FFmpeg', () => {
    const rgb = new Float32Array([0.5, 0.2, 4, 1, 0, 0.1, 1e-3, 0.2, 0.3, 8, 8, 1234.5]);
    const decoded = decodeExrWithFfmpeg(writeRgbOpenExr(rgb, 2, 2, 'float'));
    expect(Array.from(decoded.rgb)).toEqual(Array.from(rgb));
  });

  it.skipIf(SKIP_WITHOUT_FFMPEG_EXR)('decodes the patch image with every patch at its linear colour', () => {
    const decoded = decodeExrWithFfmpeg(buildPatchExr('half'));
    expect(decoded.width).toBe(HDR_IMAGE_WIDTH);
    expect(decoded.height).toBe(HDR_IMAGE_HEIGHT);
    PATCHES.forEach((patch, index) => {
      const mean = patchCentreMean(decoded.rgb, 3, decoded.width, index);
      patch.linear.forEach((expected, channel) => {
        expect(mean[channel]).toBeCloseTo(halfBitsToFloat(floatToHalfBits(expected)), 6);
      });
    });
  });
});

describe('buildUltraHdrJpeg', () => {
  it('writes an MPF index whose entries resolve to the SOI and size of each JPEG', async () => {
    const file = await buildPatchUltraHdr();
    const parsed = parseUltraHdrStructure(file);

    expect(parsed.mpf.version).toBe('0100');
    expect(parsed.mpf.numberOfImages).toBe(2);
    expect(parsed.mpf.entries).toHaveLength(2);

    const [primaryEntry, gainEntry] = parsed.mpf.entries;
    expect(primaryEntry.dataOffset).toBe(0);
    expect(primaryEntry.size).toBe(parsed.primary.end);
    expect(gainEntry.absoluteOffset).toBe(parsed.primary.end);
    expect(gainEntry.size).toBe(file.length - parsed.primary.end);
    expect(parsed.secondary.end).toBe(file.length);
    expect([...file.subarray(gainEntry.absoluteOffset, gainEntry.absoluteOffset + 2)]).toEqual([0xff, 0xd8]);
  });

  it('carries the container directory in the primary XMP and hdrgm metadata in the gain map XMP', async () => {
    const file = await buildPatchUltraHdr();
    const parsed = parseUltraHdrStructure(file);

    expect(parsed.primaryXmp).toContain('Item:Semantic="GainMap"');
    expect(parsed.primaryXmp).toContain(`Item:Length="${parsed.gainMapJpeg.length}"`);
    expect(readHdrgmAttribute(parsed.primaryXmp, 'Version')).toBe('1.0');

    expect(readHdrgmAttribute(parsed.gainMapXmp, 'Version')).toBe('1.0');
    expect(Number(readHdrgmAttribute(parsed.gainMapXmp, 'GainMapMin'))).toBe(ULTRA_HDR_METADATA.gainMapMin);
    expect(Number(readHdrgmAttribute(parsed.gainMapXmp, 'GainMapMax'))).toBe(ULTRA_HDR_METADATA.gainMapMax);
    expect(Number(readHdrgmAttribute(parsed.gainMapXmp, 'Gamma'))).toBe(ULTRA_HDR_METADATA.gamma);
    expect(Number(readHdrgmAttribute(parsed.gainMapXmp, 'OffsetSDR'))).toBeCloseTo(ULTRA_HDR_METADATA.offsetSdr, 6);
    expect(readHdrgmAttribute(parsed.gainMapXmp, 'BaseRenditionIsHDR')).toBe('False');
  });

  it('embeds an SDR primary and a grayscale gain map that both decode with the patch values', async () => {
    const file = await buildPatchUltraHdr();
    const parsed = parseUltraHdrStructure(file);

    const primary = await sharp(parsed.primaryJpeg).raw().toBuffer({ resolveWithObject: true });
    expect(primary.info).toMatchObject({ width: HDR_IMAGE_WIDTH, height: HDR_IMAGE_HEIGHT, channels: 3, format: 'raw' });
    const gainMeta = await sharp(parsed.gainMapJpeg).metadata();
    expect(gainMeta).toMatchObject({ format: 'jpeg', width: HDR_IMAGE_WIDTH, height: HDR_IMAGE_HEIGHT, channels: 1, space: 'b-w' });
    const gain = await sharp(parsed.gainMapJpeg).toColourspace('b-w').raw().toBuffer({ resolveWithObject: true });
    expect(gain.info.channels).toBe(1);

    const JPEG_TOLERANCE = 6;
    PATCHES.forEach((_, index) => {
      const sdr = patchCentreMean(primary.data, 3, HDR_IMAGE_WIDTH, index);
      ultraHdrSdrPatch(index).forEach((expected, channel) => {
        expect(Math.abs(sdr[channel] - expected)).toBeLessThanOrEqual(JPEG_TOLERANCE);
      });
      const gm = patchCentreMean(gain.data, 1, HDR_IMAGE_WIDTH, index)[0];
      expect(Math.abs(gm - ULTRA_HDR_GAIN_BYTES[index])).toBeLessThanOrEqual(JPEG_TOLERANCE);
    });
  });

  it.skipIf(SKIP_WITHOUT_FFMPEG_EXR)('is read by ffprobe as a JPEG whose first image has the patch dimensions', async () => {
    const file = await buildPatchUltraHdr();
    expect(probeStill(file, 'jpg')).toMatchObject({ codec: 'mjpeg', width: HDR_IMAGE_WIDTH, height: HDR_IMAGE_HEIGHT });
  });
});
