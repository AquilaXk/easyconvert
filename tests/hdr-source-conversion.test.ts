import { describe, it, expect, beforeAll } from 'vitest';
import sharp from 'sharp';
import { convertFile } from '../src/lib/conversions';
import { decodeUltraHdrJpeg } from '../src/lib/conversions/raw-hdr';
import { ConversionFailedError } from '../src/lib/types';
import { decodeExrWithFfmpeg, HAS_FFMPEG_EXR, probeExr } from './helpers/ffmpeg-exr';
import { floatToHalfBits, halfBitsToFloat } from './helpers/openexr-writer';
import { parseUltraHdrStructure, readHdrgmAttribute, walkJpeg, type UltraHdrGainMapMetadata } from './helpers/ultrahdr-builder';
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

  /** Builds the patch file with one gain map XMP attribute replaced by raw text. */
  const withAttribute = (name: string, raw: string) =>
    buildPatchUltraHdr(false, ULTRA_HDR_METADATA, (xmp) => {
      const pattern = new RegExp(`hdrgm:${name}="[^"]*"`);
      if (!pattern.test(xmp)) throw new Error(`the builder wrote no hdrgm:${name}`);
      return xmp.replace(pattern, raw);
    });

  it.each([
    ['an out-of-range GainMapMax', 'GainMapMax', 'hdrgm:GainMapMax="1e308"', /GainMapMax/],
    ['GainMapMin above GainMapMax', 'GainMapMin', 'hdrgm:GainMapMin="5.0"', /GainMapMin.*GainMapMax/],
    ['a Gamma too close to zero', 'Gamma', 'hdrgm:Gamma="1e-300"', /Gamma/],
    ['an OffsetSDR above 1', 'OffsetSDR', 'hdrgm:OffsetSDR="4.0"', /OffsetSDR/],
    ['a number with trailing text', 'GainMapMax', 'hdrgm:GainMapMax="2abc"', /GainMapMax/],
    ['a NaN value', 'GainMapMax', 'hdrgm:GainMapMax="NaN"', /GainMapMax/],
    ['per-channel values', 'GainMapMax', '', /per-channel|GainMapMax/],
    ['an HDR base rendition', 'BaseRenditionIsHDR', 'hdrgm:BaseRenditionIsHDR="True"', /BaseRenditionIsHDR/],
  ])('rejects gain map metadata with %s', async (_label, name, raw, message) => {
    const source = raw === ''
      ? await buildPatchUltraHdr(false, ULTRA_HDR_METADATA, (xmp) =>
          xmp
            .replace(/ hdrgm:GainMapMax="[^"]*"/, '')
            .replace('/>', '><hdrgm:GainMapMax><rdf:Seq><rdf:li>1</rdf:li><rdf:li>2</rdf:li><rdf:li>3</rdf:li></rdf:Seq></hdrgm:GainMapMax></rdf:Description>'))
      : await withAttribute(name, raw);
    const run = convertFile(source, 'ultrahdr', 'exr', {}, 'bad.jpg');
    await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(run).rejects.toThrow(message);
  });

  it.skipIf(!HAS_FFMPEG_EXR).each([
    ['single-quoted attributes', (xmp: string) => xmp.replace(/hdrgm:(\w+)="([^"]*)"/g, "hdrgm:$1='$2'")],
    ['element-form values', (xmp: string) => {
      const max = /hdrgm:GainMapMax="([^"]*)"/.exec(xmp)![1];
      return xmp.replace(/ hdrgm:GainMapMax="[^"]*"/, '').replace('/>', `><hdrgm:GainMapMax>${max}</hdrgm:GainMapMax></rdf:Description>`);
    }],
    ['another namespace prefix', (xmp: string) => xmp.replace(/hdrgm:/g, 'gm:').replace('xmlns:hdrgm=', 'xmlns:gm=')],
  ])('reads gain map metadata written as %s', async (_label, edit) => {
    const source = await buildPatchUltraHdr(false, ULTRA_HDR_METADATA, edit);
    const result = await convertFile(source, 'ultrahdr', 'exr', {}, 'patches.jpg');
    expectHdrReconstruction(result.buffer, ULTRA_HDR_METADATA);
  });

  it('rejects an OpenEXR file that does not start with the EXR magic number', async () => {
    const source = buildPatchExr('half');
    source[0] = 0x00;
    await expect(convertFile(source, 'exr', 'png', {}, 'bad.exr')).rejects.toThrow(/Invalid OpenEXR magic header/);
  });
});

// ----------------------------------------------------------------------------
// Ultra HDR container split: the MPF index decides where the gain map starts.
// ----------------------------------------------------------------------------

const JPEG_EOI_SOI = Buffer.from([0xff, 0xd9, 0xff, 0xd8]);
const MPF_TIFF_HEADER_BYTES = 8;
const MPF_SEGMENT_HEADER_BYTES = 8;
const MPF_IFD_ENTRY_BYTES = 12;
const MPF_TAG_NUMBER_OF_IMAGES = 0xb001;
const MPF_TAG_ENTRIES = 0xb002;
const MP_ENTRY_BYTES = 16;
const SEGMENT_HEADER_BYTES = 4;
const UINT32_MAX = 0xffffffff;
const UINT16_MAX = 0xffff;
const HOSTILE_DECODE_BUDGET_MS = 2000;
const HUGE_OFFSET = 0xfffffff0;

interface MpfLayout {
  /** Absolute offset of the MPF TIFF header. */
  tiff: number;
  /** Absolute offset of the IFD entry-count field. */
  ifd: number;
  /** Absolute offset of the 0xB001 and 0xB002 IFD entries. */
  numberOfImagesEntry: number;
  entriesEntry: number;
  /** Absolute offset of the first MP Entry (the primary image); the gain map entry follows. */
  firstMpEntry: number;
  bigEndian: boolean;
}

/** Locates the MPF fields to corrupt using the independent structural parser, not the engine. */
function locateMpf(file: Buffer): MpfLayout {
  const parsed = parseUltraHdrStructure(file);
  const segment = parsed.primary.segments.find((s) => s.marker === 0xe2)!;
  const tiff = segment.offset + MPF_SEGMENT_HEADER_BYTES;
  const bigEndian = file.toString('ascii', tiff, tiff + 2) === 'MM';
  const u16 = (at: number) => (bigEndian ? file.readUInt16BE(at) : file.readUInt16LE(at));
  const u32 = (at: number) => (bigEndian ? file.readUInt32BE(at) : file.readUInt32LE(at));
  const ifd = tiff + u32(tiff + 4);
  let numberOfImagesEntry = -1;
  let entriesEntry = -1;
  for (let i = 0; i < u16(ifd); i++) {
    const at = ifd + 2 + i * MPF_IFD_ENTRY_BYTES;
    if (u16(at) === MPF_TAG_NUMBER_OF_IMAGES) numberOfImagesEntry = at;
    if (u16(at) === MPF_TAG_ENTRIES) entriesEntry = at;
  }
  expect(numberOfImagesEntry).toBeGreaterThan(0);
  expect(entriesEntry).toBeGreaterThan(0);
  return { tiff, ifd, numberOfImagesEntry, entriesEntry, firstMpEntry: tiff + u32(entriesEntry + 8), bigEndian };
}

function writeU32(file: Buffer, layout: MpfLayout, at: number, value: number): void {
  if (layout.bigEndian) file.writeUInt32BE(value, at);
  else file.writeUInt32LE(value, at);
}

function writeU16(file: Buffer, layout: MpfLayout, at: number, value: number): void {
  if (layout.bigEndian) file.writeUInt16BE(value, at);
  else file.writeUInt16LE(value, at);
}

/** Removes the first APP2 MPF segment from the primary image. */
function withoutMpfSegment(file: Buffer): Buffer {
  const segment = parseUltraHdrStructure(file).primary.segments.find((s) => s.marker === 0xe2)!;
  const end = segment.offset + SEGMENT_HEADER_BYTES + segment.payload.length;
  return Buffer.concat([file.subarray(0, segment.offset), file.subarray(end)]);
}

describe('Ultra HDR container split follows the MPF index', () => {
  let trapFile: Buffer;

  beforeAll(async () => {
    trapFile = await buildPatchUltraHdr(false, ULTRA_HDR_METADATA, undefined, { exifThumbnailTrap: true });
  }, 60_000);

  it('builds a primary whose EXIF thumbnail puts an EOI+SOI pair before the real end of the primary image', () => {
    const parsed = parseUltraHdrStructure(trapFile);
    const decoy = trapFile.indexOf(JPEG_EOI_SOI, 2);
    expect(decoy).toBeGreaterThan(0);
    expect(decoy).toBeLessThan(parsed.primary.end - JPEG_EOI_SOI.length);
    const exif = parsed.primary.segments.find((s) => s.marker === 0xe1 && s.payload.toString('latin1', 0, 4) === 'Exif')!;
    expect(decoy).toBeGreaterThan(exif.offset);
    expect(decoy).toBeLessThan(exif.offset + SEGMENT_HEADER_BYTES + exif.payload.length);
    expect(parsed.mpf.entries[1].absoluteOffset).toBe(parsed.primary.end);
  });

  it('splits at the gain map entry of the MPF index, not at an EOI+SOI pair inside EXIF', () => {
    const parsed = parseUltraHdrStructure(trapFile);
    const decoded = decodeUltraHdrJpeg(trapFile);
    expect(decoded.primaryJpeg.length).toBe(parsed.primary.end);
    expect(decoded.primaryJpeg.equals(parsed.primaryJpeg)).toBe(true);
    expect(decoded.secondaryJpeg.equals(parsed.gainMapJpeg)).toBe(true);
    expect(decoded.gainMapParams).toMatchObject(ULTRA_HDR_METADATA);
  });

  it.skipIf(!HAS_FFMPEG_EXR)('ultrahdr -> exr reconstructs the spec formula for a primary with an EXIF thumbnail', async () => {
    const result = await convertFile(trapFile, 'ultrahdr', 'exr', {}, 'patches.jpg');
    expectHdrReconstruction(result.buffer, ULTRA_HDR_METADATA);
  });

  it('falls back to the XMP container directory (gain map length from the end) when there is no MPF index', () => {
    const parsed = parseUltraHdrStructure(trapFile);
    const stripped = withoutMpfSegment(trapFile);
    expect(stripped.includes(Buffer.from('MPF\0', 'ascii'))).toBe(false);
    const decoded = decodeUltraHdrJpeg(stripped);
    expect(decoded.secondaryJpeg.equals(parsed.gainMapJpeg)).toBe(true);
    expect(decoded.primaryJpeg.length).toBe(stripped.length - parsed.gainMapJpeg.length);
    expect(decoded.gainMapParams).toMatchObject(ULTRA_HDR_METADATA);
  });

  it('falls back to the legacy EOI+SOI scan when neither MPF nor a container directory is present', async () => {
    const plain = await buildPatchUltraHdr();
    const parsed = parseUltraHdrStructure(plain);
    // Same-length rename keeps every segment length valid while hiding the GainMap item.
    const noDirectory = Buffer.from(withoutMpfSegment(plain).toString('latin1').replace('Item:Semantic="GainMap"', 'Item:Semantic="Gainmap"'), 'latin1');
    const decoded = decodeUltraHdrJpeg(noDirectory);
    expect(decoded.secondaryJpeg.equals(parsed.gainMapJpeg)).toBe(true);
  });

  it('rejects a container directory whose GainMap length does not fit the file', () => {
    const stripped = withoutMpfSegment(trapFile);
    const length = parseUltraHdrStructure(trapFile).gainMapJpeg.length;
    const text = stripped.toString('latin1').replace(`Item:Length="${length}"`, `Item:Length="${stripped.length * 4}"`);
    expect(() => decodeUltraHdrJpeg(Buffer.from(text, 'latin1'))).toThrow(ConversionFailedError);
  });

  describe('hostile MPF indexes fail closed with a typed error', () => {
    const corruptions: ReadonlyArray<[string, (file: Buffer, layout: MpfLayout) => void, RegExp]> = [
      ['a gain map offset past the end of the file', (f, l) => writeU32(f, l, l.firstMpEntry + MP_ENTRY_BYTES + 8, f.length), /offset/i],
      ['a gain map offset of 0xFFFFFFF0', (f, l) => writeU32(f, l, l.firstMpEntry + MP_ENTRY_BYTES + 8, HUGE_OFFSET), /offset/i],
      ['a gain map size of 0xFFFFFFFF', (f, l) => writeU32(f, l, l.firstMpEntry + MP_ENTRY_BYTES + 4, UINT32_MAX), /size/i],
      ['a gain map offset that does not land on an SOI', (f, l) => {
        // Shift the start by one byte and shrink the size so the range still fits inside the file.
        const entry = l.firstMpEntry + MP_ENTRY_BYTES;
        const read = (at: number) => (l.bigEndian ? f.readUInt32BE(at) : f.readUInt32LE(at));
        writeU32(f, l, entry + 8, read(entry + 8) + 1);
        writeU32(f, l, entry + 4, read(entry + 4) - 1);
      }, /SOI/],
      ['a zero gain map size', (f, l) => writeU32(f, l, l.firstMpEntry + MP_ENTRY_BYTES + 4, 0), /size/i],
      ['a primary size beyond the gain map offset', (f, l) => writeU32(f, l, l.firstMpEntry + 4, UINT32_MAX), /primary/i],
      ['a huge MP Entry table length', (f, l) => writeU32(f, l, l.entriesEntry + 4, HUGE_OFFSET), /entr/i],
      ['an MP Entry table placed past the segment', (f, l) => writeU32(f, l, l.entriesEntry + 8, HUGE_OFFSET), /entr/i],
      ['a huge IFD entry count', (f, l) => writeU16(f, l, l.ifd, UINT16_MAX), /IFD/i],
      ['an NumberOfImages that disagrees with the entry table', (f, l) => writeU32(f, l, l.numberOfImagesEntry + 8, 7), /NumberOfImages|images/i],
      ['a wrong byte order marker', (f, l) => f.write('XX', l.tiff, 'ascii'), /byte order/i],
      ['a wrong TIFF magic', (f, l) => writeU16(f, l, l.tiff + 2, 43), /magic|TIFF/i],
    ];

    it.each(corruptions)('rejects %s', (_label, corrupt, message) => {
      const file = Buffer.from(trapFile);
      corrupt(file, locateMpf(trapFile));
      const started = performance.now();
      let thrown: unknown;
      try {
        decodeUltraHdrJpeg(file);
      } catch (error) {
        thrown = error;
      }
      expect(performance.now() - started).toBeLessThan(HOSTILE_DECODE_BUDGET_MS);
      expect(thrown).toBeInstanceOf(ConversionFailedError);
      expect((thrown as Error).message).toMatch(/MPF/);
      expect((thrown as Error).message).toMatch(message);
    });

    it('surfaces the typed error through convertFile', async () => {
      const file = Buffer.from(trapFile);
      const layout = locateMpf(trapFile);
      writeU32(file, layout, layout.firstMpEntry + MP_ENTRY_BYTES + 8, file.length);
      const run = convertFile(file, 'ultrahdr', 'exr', {}, 'bad.jpg');
      await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
      await expect(run).rejects.toThrow(/MPF image 1 offset \d+ with size \d+ lies outside the \d+-byte file/);
    });
  });
});

describe('Ultra HDR gain map selection among several MPF images', () => {
  let depthFile: Buffer;

  beforeAll(async () => {
    depthFile = await buildPatchUltraHdr(false, ULTRA_HDR_METADATA, undefined, { depthMapBeforeGainMap: true });
  }, 60_000);

  it('builds a three-image MPF whose first secondary is a depth map without hdrgm XMP', () => {
    const parsed = parseUltraHdrStructure(depthFile);
    expect(parsed.mpf.numberOfImages).toBe(3);
    expect(parsed.mpf.entries).toHaveLength(3);
    const depth = walkJpeg(depthFile, parsed.mpf.entries[1].absoluteOffset);
    expect(depth.start).toBe(parsed.primary.end);
    expect(depth.end).toBe(parsed.mpf.entries[2].absoluteOffset);
    expect(depthFile.subarray(depth.start, depth.end).includes(Buffer.from('hdrgm', 'ascii'))).toBe(false);
    expect(parsed.secondary.start).toBe(parsed.mpf.entries[2].absoluteOffset);
    expect(parsed.secondary.end).toBe(depthFile.length);
    expect(readHdrgmAttribute(parsed.gainMapXmp, 'Version')).toBe('1.0');
  });

  it('selects the secondary image that carries the hdrgm XMP, not the first secondary', () => {
    const parsed = parseUltraHdrStructure(depthFile);
    const depthBytes = depthFile.subarray(parsed.primary.end, parsed.mpf.entries[2].absoluteOffset);
    const decoded = decodeUltraHdrJpeg(depthFile);
    expect(decoded.secondaryJpeg.equals(parsed.gainMapJpeg)).toBe(true);
    expect(decoded.secondaryJpeg.equals(depthBytes)).toBe(false);
    expect(decoded.primaryJpeg.length).toBe(parsed.primary.end);
    expect(decoded.gainMapParams).toMatchObject(ULTRA_HDR_METADATA);
  });

  it.skipIf(!HAS_FFMPEG_EXR)('ultrahdr -> exr reconstructs the spec formula with a depth map ahead of the gain map', async () => {
    const result = await convertFile(depthFile, 'ultrahdr', 'exr', {}, 'patches.jpg');
    expectHdrReconstruction(result.buffer, ULTRA_HDR_METADATA);
  });

  it('falls back to the first valid secondary when no image carries gain map XMP', () => {
    const parsed = parseUltraHdrStructure(depthFile);
    // Same-length renames hide both the namespace binding and the Version property.
    const hidden = Buffer.from(
      depthFile.toString('latin1').replaceAll('hdr-gain-map/1.0', 'hdr-gain-mop/1.0').replaceAll('hdrgm:Version', 'hdrgm:Versiom'),
      'latin1'
    );
    const decoded = decodeUltraHdrJpeg(hidden);
    expect(decoded.secondaryJpeg.equals(hidden.subarray(parsed.primary.end, parsed.mpf.entries[2].absoluteOffset))).toBe(true);
  });

  it('rejects an auxiliary entry that lies outside the file even when the gain map entry is valid', () => {
    const file = Buffer.from(depthFile);
    const layout = locateMpf(depthFile);
    writeU32(file, layout, layout.firstMpEntry + MP_ENTRY_BYTES + 8, file.length);
    expect(() => decodeUltraHdrJpeg(file)).toThrow(ConversionFailedError);
    expect(() => decodeUltraHdrJpeg(file)).toThrow(/MPF image 1 offset \d+ with size \d+ lies outside/);
  });

  it('rejects an auxiliary entry that does not start with an SOI marker', () => {
    const file = Buffer.from(depthFile);
    const layout = locateMpf(depthFile);
    const depthStart = parseUltraHdrStructure(depthFile).primary.end;
    file[depthStart] = 0x00;
    expect(layout.firstMpEntry).toBeGreaterThan(0);
    expect(() => decodeUltraHdrJpeg(file)).toThrow(/MPF image 1 offset \d+ does not start with an SOI marker/);
  });
});
