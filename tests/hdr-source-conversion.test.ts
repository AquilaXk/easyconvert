import { describe, it, expect, beforeAll } from 'vitest';
import sharp from 'sharp';
import { convertFile } from '../src/lib/conversions';
import { decodeExrWithFfmpeg, HAS_FFMPEG_EXR, probeExr } from './helpers/ffmpeg-exr';
import { floatToHalfBits, halfBitsToFloat } from './helpers/openexr-writer';
import { parseUltraHdrStructure, readHdrgmAttribute, type UltraHdrGainMapMetadata } from './helpers/ultrahdr-builder';
import {
  buildPatchExr,
  buildPatchUltraHdr,
  HDR_IMAGE_HEIGHT,
  HDR_IMAGE_WIDTH,
  PATCHES,
  patchCentreMean,
  srgbEncode8,
  ULTRA_HDR_GAIN_BYTES,
  ULTRA_HDR_METADATA,
  ultraHdrExpectedLinear,
  ultraHdrSdrPatch,
} from './helpers/hdr-test-images';

/**
 * HDR source conversions: OpenEXR and Ultra HDR JPEG inputs to every advertised target.
 *
 * Inputs come from the independent writers in tests/helpers (not from the engine's encoders) and
 * every output is checked with a decoder the engine does not share: sharp/libvips for the raster
 * formats, a byte-level BMP reader, the FFmpeg exr decoder for OpenEXR, and a separate JPEG/MPF
 * parser for Ultra HDR. The sources are flat colour patches, so a decoded patch must land on the
 * tone-mapped colour the IEC 61966-2-1 formula assigns to it, within the codec's tolerance.
 */

const BYTE_MAX = 255;
const PNG_TIFF_TOLERANCE = 2;
const JPEG_TOLERANCE = 10;
const WEBP_TOLERANCE = 12;
const AVIF_TOLERANCE = 14;
const BMP_FILE_HEADER_BYTES = 14;
const BMP_INFO_HEADER_BYTES = 40;
const BMP_BITS_PER_PIXEL = 24;
const BMP_BYTES_PER_PIXEL = 3;
const BMP_ROW_ALIGNMENT = 4;
const BMP_PIXEL_OFFSET = 54;
const SUPER_WHITE_PATCH = 6;
const FLOAT_TOLERANCE = 1e-6;
const HDR_RELATIVE_TOLERANCE = 0.06;
const HDR_ABSOLUTE_TOLERANCE = 0.01;
const PRIMARY_TOLERANCE = JPEG_TOLERANCE;
const GAIN_MAP_TOLERANCE = 8;

type SdrTarget = 'avif' | 'bmp' | 'jpg' | 'png' | 'tiff' | 'webp';

const SDR_TARGET_CHECKS: Readonly<Record<SdrTarget, { format: string; tolerance: number; magic: Buffer }>> = {
  avif: { format: 'heif', tolerance: AVIF_TOLERANCE, magic: Buffer.from('ftyp') },
  bmp: { format: 'bmp', tolerance: 0, magic: Buffer.from('BM') },
  jpg: { format: 'jpeg', tolerance: JPEG_TOLERANCE, magic: Buffer.from([0xff, 0xd8, 0xff]) },
  png: { format: 'png', tolerance: PNG_TIFF_TOLERANCE, magic: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  tiff: { format: 'tiff', tolerance: PNG_TIFF_TOLERANCE, magic: Buffer.from([0x49, 0x49, 0x2a, 0x00]) },
  webp: { format: 'webp', tolerance: WEBP_TOLERANCE, magic: Buffer.from('WEBP') },
};

/** Byte offset of each container's identifying signature (RIFF....WEBP, ....ftyp). */
const MAGIC_OFFSETS: Readonly<Record<SdrTarget, number>> = { avif: 4, bmp: 0, jpg: 0, png: 0, tiff: 0, webp: 8 };

interface RasterPixels {
  data: Uint8Array;
  channels: number;
  width: number;
  height: number;
}

/** Byte-level reader for uncompressed 24-bit BMP files (BITMAPINFOHEADER, bottom-up rows). */
function readBmp24(buf: Buffer): RasterPixels {
  expect(buf.toString('ascii', 0, 2)).toBe('BM');
  expect(buf.readUInt32LE(2)).toBe(buf.length);
  const pixelOffset = buf.readUInt32LE(10);
  expect(pixelOffset).toBe(BMP_PIXEL_OFFSET);
  expect(buf.readUInt32LE(BMP_FILE_HEADER_BYTES)).toBe(BMP_INFO_HEADER_BYTES);
  const width = buf.readInt32LE(18);
  const signedHeight = buf.readInt32LE(22);
  expect(buf.readUInt16LE(26)).toBe(1);
  expect(buf.readUInt16LE(28)).toBe(BMP_BITS_PER_PIXEL);
  expect(buf.readUInt32LE(30)).toBe(0);
  const height = Math.abs(signedHeight);
  const stride = Math.ceil((width * BMP_BYTES_PER_PIXEL) / BMP_ROW_ALIGNMENT) * BMP_ROW_ALIGNMENT;
  expect(buf.length).toBe(pixelOffset + stride * height);
  const data = new Uint8Array(width * height * BMP_BYTES_PER_PIXEL);
  for (let row = 0; row < height; row++) {
    const y = signedHeight > 0 ? height - 1 - row : row;
    for (let x = 0; x < width; x++) {
      const src = pixelOffset + row * stride + x * BMP_BYTES_PER_PIXEL;
      const dst = (y * width + x) * BMP_BYTES_PER_PIXEL;
      data[dst] = buf[src + 2];
      data[dst + 1] = buf[src + 1];
      data[dst + 2] = buf[src];
    }
  }
  return { data, channels: BMP_BYTES_PER_PIXEL, width, height };
}

async function decodeSdrOutput(target: SdrTarget, output: Buffer): Promise<RasterPixels> {
  const check = SDR_TARGET_CHECKS[target];
  const magicOffset = MAGIC_OFFSETS[target];
  expect(output.subarray(magicOffset, magicOffset + check.magic.length).equals(check.magic)).toBe(true);
  if (target === 'bmp') return readBmp24(output);
  const meta = await sharp(output).metadata();
  expect(meta.format).toBe(check.format);
  const { data, info } = await sharp(output).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, channels: info.channels, width: info.width, height: info.height };
}

function expectPatchColours(pixels: RasterPixels, expected: (patch: number) => number[], tolerance: number): void {
  PATCHES.forEach((patch, index) => {
    const mean = patchCentreMean(pixels.data, pixels.channels, pixels.width, index);
    expected(index).forEach((value, channel) => {
      const delta = Math.abs(mean[channel] - value);
      expect(delta, `${patch.name} channel ${channel}: decoded ${mean[channel].toFixed(1)}, expected ${value}`).toBeLessThanOrEqual(
        tolerance
      );
    });
  });
}

function luminance(rgb: number[]): number {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function expectToneOrdering(pixels: RasterPixels): void {
  const means = PATCHES.map((_, index) => patchCentreMean(pixels.data, pixels.channels, pixels.width, index));
  const [red, green, blue, nearBlack, midGrey, white, superWhite] = means;
  expect(red[0]).toBeGreaterThan(red[1] + 60);
  expect(red[0]).toBeGreaterThan(red[2] + 60);
  expect(green[1]).toBeGreaterThan(green[0] + 60);
  expect(green[1]).toBeGreaterThan(green[2] + 60);
  expect(blue[2]).toBeGreaterThan(blue[0] + 60);
  expect(blue[2]).toBeGreaterThan(blue[1] + 60);
  expect(luminance(nearBlack)).toBeLessThan(luminance(midGrey));
  expect(luminance(midGrey)).toBeLessThan(luminance(white));
  // Tone mapping to an 8-bit display clips radiance above 1.0, so 4.0 and 1.0 both render white.
  expect(Math.abs(luminance(superWhite) - luminance(white))).toBeLessThanOrEqual(PRIMARY_TOLERANCE);
}

function expectHdrReconstruction(exrOutput: Buffer, meta: UltraHdrGainMapMetadata): void {
  expect(probeExr(exrOutput)).toMatchObject({ codec: 'exr', width: HDR_IMAGE_WIDTH, height: HDR_IMAGE_HEIGHT, pixFmt: 'gbrpf32le' });
  const decoded = decodeExrWithFfmpeg(exrOutput);
  PATCHES.forEach((patch, index) => {
    const mean = patchCentreMean(decoded.rgb, 3, decoded.width, index);
    for (let channel = 0; channel < 3; channel++) {
      const expected = ultraHdrExpectedLinear(index, channel, meta);
      const allowed = Math.max(HDR_ABSOLUTE_TOLERANCE, expected * HDR_RELATIVE_TOLERANCE);
      expect(
        Math.abs(mean[channel] - expected),
        `${patch.name} channel ${channel}: decoded ${mean[channel].toFixed(4)}, expected ${expected.toFixed(4)}`
      ).toBeLessThanOrEqual(allowed);
    }
  });
}

describe('OpenEXR source conversions', () => {
  let exr: Buffer;
  const outputs = new Map<string, Buffer>();

  beforeAll(async () => {
    exr = buildPatchExr('half');
    for (const target of ['avif', 'bmp', 'exr', 'jpg', 'png', 'tiff', 'ultrahdr', 'webp']) {
      const result = await convertFile(exr, 'exr', target, {}, 'patches.exr');
      outputs.set(target, result.buffer);
    }
  }, 120_000);

  it.each(Object.keys(SDR_TARGET_CHECKS) as SdrTarget[])(
    'exr -> %s keeps the dimensions and renders each patch at its sRGB tone-mapped colour',
    async (target) => {
      const pixels = await decodeSdrOutput(target, outputs.get(target)!);
      expect(pixels.width).toBe(HDR_IMAGE_WIDTH);
      expect(pixels.height).toBe(HDR_IMAGE_HEIGHT);
      expectPatchColours(pixels, (patch) => PATCHES[patch].linear.map(srgbEncode8), SDR_TARGET_CHECKS[target].tolerance);
      expectToneOrdering(pixels);
    }
  );

  it.skipIf(!HAS_FFMPEG_EXR)('exr -> exr is a 16-bit float OpenEXR whose decoded samples equal the half-quantised input', () => {
    const output = outputs.get('exr')!;
    expect(output.subarray(0, 4).equals(Buffer.from([0x76, 0x2f, 0x31, 0x01]))).toBe(true);
    expect(probeExr(output)).toMatchObject({ codec: 'exr', width: HDR_IMAGE_WIDTH, height: HDR_IMAGE_HEIGHT, pixFmt: 'gbrpf32le' });
    const decoded = decodeExrWithFfmpeg(output);
    PATCHES.forEach((patch, index) => {
      const mean = patchCentreMean(decoded.rgb, 3, decoded.width, index);
      patch.linear.forEach((value, channel) => {
        const expected = halfBitsToFloat(floatToHalfBits(value));
        expect(Math.abs(mean[channel] - expected)).toBeLessThanOrEqual(FLOAT_TOLERANCE);
      });
    });
    // HDR values above 1.0 survive: the super-white patch is not clipped to display white.
    expect(patchCentreMean(decoded.rgb, 3, decoded.width, SUPER_WHITE_PATCH)[0]).toBeCloseTo(4, 3);
  });

  it.skipIf(!HAS_FFMPEG_EXR)('exr -> exr with outputDepth 32 stores FLOAT samples that decode to the input values', async () => {
    const result = await convertFile(exr, 'exr', 'exr', { outputDepth: 32 }, 'patches.exr');
    const decoded = decodeExrWithFfmpeg(result.buffer);
    expect(decoded.width).toBe(HDR_IMAGE_WIDTH);
    expect(decoded.height).toBe(HDR_IMAGE_HEIGHT);
    PATCHES.forEach((patch, index) => {
      const mean = patchCentreMean(decoded.rgb, 3, decoded.width, index);
      patch.linear.forEach((value, channel) => {
        expect(Math.abs(mean[channel] - halfBitsToFloat(floatToHalfBits(value)))).toBeLessThanOrEqual(FLOAT_TOLERANCE);
      });
    });
  });

  it('exr -> ultrahdr is an MPF container with a decodable SDR primary and gain map that boosts only the HDR patch', async () => {
    const file = outputs.get('ultrahdr')!;
    const parsed = parseUltraHdrStructure(file);

    expect(parsed.mpf.numberOfImages).toBe(2);
    expect(parsed.mpf.entries[0]).toMatchObject({ dataOffset: 0, size: parsed.primary.end });
    expect(parsed.mpf.entries[1].absoluteOffset).toBe(parsed.primary.end);
    expect(parsed.mpf.entries[1].size).toBe(file.length - parsed.primary.end);
    expect(parsed.secondary.end).toBe(file.length);
    expect(parsed.primaryXmp).toContain('Item:Semantic>GainMap<');
    expect(parsed.primaryXmp).toContain(`Item:Length>${parsed.gainMapJpeg.length}<`);

    const xmp = `${parsed.primaryXmp}\n${parsed.gainMapXmp}`;
    const gainMapMax = Number(readHdrgmAttribute(xmp, 'GainMapMax'));
    expect(gainMapMax).toBeGreaterThan(0);
    expect(readHdrgmAttribute(xmp, 'Version')).toBe('1.0');

    const primary = await sharp(parsed.primaryJpeg).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(primary.info).toMatchObject({ width: HDR_IMAGE_WIDTH, height: HDR_IMAGE_HEIGHT });
    expectPatchColours(
      { data: primary.data, channels: primary.info.channels, width: primary.info.width, height: primary.info.height },
      (patch) => PATCHES[patch].linear.map(srgbEncode8),
      PRIMARY_TOLERANCE
    );

    const gainMeta = await sharp(parsed.gainMapJpeg).metadata();
    expect(gainMeta).toMatchObject({ format: 'jpeg', width: HDR_IMAGE_WIDTH, height: HDR_IMAGE_HEIGHT });
    const gain = await sharp(parsed.gainMapJpeg).toColourspace('b-w').raw().toBuffer();
    // log2(4 / 1) = 2 stops, normalised by the advertised range; every patch at or below 1.0 needs no boost.
    PATCHES.forEach((patch, index) => {
      const mean = patchCentreMean(
        Uint8Array.from({ length: gain.length * 3 }, (_, i) => gain[Math.floor(i / 3)]),
        3,
        HDR_IMAGE_WIDTH,
        index
      )[0];
      const expected = index === SUPER_WHITE_PATCH ? (Math.log2(4) / gainMapMax) * BYTE_MAX : 0;
      expect(Math.abs(mean - expected), `${patch.name} gain ${mean.toFixed(1)} vs ${expected.toFixed(1)}`).toBeLessThanOrEqual(
        GAIN_MAP_TOLERANCE
      );
    });
  });
});

/**
 * "standard": the gain map range lives only in the gain map image's XMP, as in Ultra HDR files from
 * cameras. "mirrored": the primary XMP repeats GainMapMax as well.
 */
describe.each([false, true])('Ultra HDR source conversions (GainMapMax mirrored in primary: %s)', (mirrored) => {
  let ultraHdr: Buffer;
  const outputs = new Map<string, Buffer>();

  beforeAll(async () => {
    ultraHdr = await buildPatchUltraHdr(mirrored);
    for (const target of ['exr', 'jpg', 'png', 'tiff', 'webp']) {
      const result = await convertFile(ultraHdr, 'ultrahdr', target, {}, 'patches.jpg');
      outputs.set(target, result.buffer);
    }
  }, 120_000);

  it.each(['jpg', 'png', 'tiff', 'webp'] as SdrTarget[])(
    'ultrahdr -> %s keeps the dimensions and the SDR base rendition colours',
    async (target) => {
      const pixels = await decodeSdrOutput(target, outputs.get(target)!);
      expect(pixels.width).toBe(HDR_IMAGE_WIDTH);
      expect(pixels.height).toBe(HDR_IMAGE_HEIGHT);
      expectPatchColours(pixels, ultraHdrSdrPatch, SDR_TARGET_CHECKS[target].tolerance);
      expectToneOrdering(pixels);
    }
  );

  it.skipIf(!HAS_FFMPEG_EXR)('ultrahdr -> exr reconstructs linear HDR radiance from the gain map', () => {
    expectHdrReconstruction(outputs.get('exr')!, ULTRA_HDR_METADATA);
    // The boosted patch is brighter than the SDR white point, which only the gain map can supply.
    const decoded = decodeExrWithFfmpeg(outputs.get('exr')!);
    expect(patchCentreMean(decoded.rgb, 3, decoded.width, SUPER_WHITE_PATCH)[0]).toBeGreaterThan(1.5);
    expect(ULTRA_HDR_GAIN_BYTES[SUPER_WHITE_PATCH]).toBe(BYTE_MAX);
  });

  it.skipIf(!HAS_FFMPEG_EXR)('ultrahdr -> exr applies GainMapMin, Gamma and the offsets declared in the gain map XMP', async () => {
    const custom: UltraHdrGainMapMetadata = { gainMapMin: -1, gainMapMax: 2.5, gamma: 2, offsetSdr: 0.004, offsetHdr: 0.002 };
    const source = await buildPatchUltraHdr(mirrored, custom);
    const result = await convertFile(source, 'ultrahdr', 'exr', {}, 'patches.jpg');
    expectHdrReconstruction(result.buffer, custom);
  });
});

describe('malformed HDR sources fail closed', () => {
  it('rejects an Ultra HDR JPEG whose gain map declares a non-positive Gamma', async () => {
    const source = await buildPatchUltraHdr(false, { ...ULTRA_HDR_METADATA, gamma: 0 });
    await expect(convertFile(source, 'ultrahdr', 'exr', {}, 'bad.jpg')).rejects.toThrow(/Gamma must be positive/);
  });

  it('rejects an OpenEXR file that does not start with the EXR magic number', async () => {
    const source = buildPatchExr('half');
    source[0] = 0x00;
    await expect(convertFile(source, 'exr', 'png', {}, 'bad.exr')).rejects.toThrow(/Invalid OpenEXR magic header/);
  });
});
