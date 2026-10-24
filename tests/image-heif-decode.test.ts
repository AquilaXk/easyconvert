import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { withUprightExifOrientation } from '../src/lib/conversions/image-external-source';
import { getOracleToolPath } from './helpers/differential-oracle';
import { magickReads } from './helpers/image-decoder-capabilities';
import { decodeRgba, type DecodedRgba, maxSampleDifference } from './helpers/image-pixels';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipUnless } from './helpers/strict-skip';
import { psnrDb } from './helpers/zimg-oracle';

/**
 * HEIC and HEIF pictures convert through libheif (#783: every HEVC-coded file failed with "bad seek", because the image
 * library's libheif is built without an HEVC decoder; the message is the sequential read that follows the failed plugin
 * load, so a file path and a buffer fail alike). The reference is libheif's own command-line decoder; the rotated
 * file is a 810-byte HEIC that libheif's encoder wrote from a picture whose left half is red and right half blue, with the EXIF
 * orientation 6 (rotate 90 degrees clockwise) that the encoder also turned into an `irot` property.
 */

const heifConvert = getOracleToolPath('heif-convert') ?? getOracleToolPath('heif-dec');
const needsHeifDecoders = skipUnless('ImageMagick with a HEIC coder and libheif-convert', magickReads('HEIC') && heifConvert !== null);

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heif-decode-'));
afterAll(() => fs.rmSync(workDir, { recursive: true, force: true }));
const REAL_FILE_TIMEOUT_MS = 60_000;
/** The PNG libheif's own decoder writes for the file. */
function referencePng(file: string): Buffer {
  const output = path.join(workDir, `${path.basename(file)}.png`);
  execFileSync(heifConvert as string, [file, output], { stdio: 'pipe' });
  return fs.readFileSync(output);
}

/** The picture libheif's own decoder writes. */
function referenceDecode(file: string): Promise<DecodedRgba> {
  return decodeRgba(referencePng(file));
}

/** Lowest PSNR (dB) of a lossy target against libheif's own decode over the colours on white; the least measured on a Linux run is 32.8 dB (the JPEG of the 128 x 128 picture). */
const MIN_LOSSY_PSNR_DB = 30;

/** The colours of a picture on a white background, which is how a target without transparency (JPEG) shows it and how the others are compared with it. */
async function colourOnWhite(bytes: Buffer): Promise<{ width: number; height: number; data: Buffer }> {
  const { data, info } = await sharp(bytes).flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

/** Whether libheif's own decoder reads the file, which is what the installed libheif can do (version 1.19 added the layouts above; the worker image has 1.23.6). */
function libheifReads(file: string): boolean {
  try {
    execFileSync(heifConvert as string, [file, path.join(workDir, `${path.basename(file)}.probe.png`)], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(needsHeifDecoders)('HEIC and HEIF files', () => {
  it.for([
    ['libheif-rainbow-451x461.heic', 'heic', 451, 461],
    ['libheif-with-alpha-512x512.heic', 'heic', 512, 512],
    ['nokiac-c002.heic', 'heic', 1280, 720],
    ['tika-testheif.heic', 'heic', 800, 544],
    ['pil-hopper.heif', 'heif', 128, 128],
  ] as const)('converts %s to the picture libheif decodes', { timeout: REAL_FILE_TIMEOUT_MS }, async ([id, format, width, height], ctx) => {
    const sample = await requireRealworldSample(ctx, id);
    const converted = await decodeRgba((await dispatchConversion(sample.bytes, format, 'png', {}, id)).buffer);
    expect([converted.width, converted.height]).toEqual([width, height]);
    expect(maxSampleDifference(converted, await referenceDecode(sample.path))).toBeLessThanOrEqual(1);
    const reference = await colourOnWhite(referencePng(sample.path));
    for (const target of ['jpg', 'webp', 'avif', 'gif']) {
      const lossy = await colourOnWhite((await dispatchConversion(sample.bytes, format, target, {}, id)).buffer);
      expect([lossy.width, lossy.height], target).toEqual([width, height]);
      expect(psnrDb(lossy.data, reference.data), target).toBeGreaterThanOrEqual(MIN_LOSSY_PSNR_DB);
    }
  });

  // Files that need libheif 1.19 (the `mif3` brand, uncompressed images with row-aligned tiles; the worker image's Debian 13 has 1.23.6,
  // the CI runner's Ubuntu 24.04 has 1.17). Where libheif's own decoder reads the file the conversion has to give the same picture;
  // where it cannot, the conversion has to refuse it with the typed answer and never invent one. Each run exercises one of the two.
  const NEWER_LIBHEIF_SAMPLES = [
    ['libheif-lightning_mini.heif', 256, 256, ['jpg', 'webp']],
    ['libheif-uncompressed_comp_rgb_tiled_row_tile_align.heif', 30, 20, ['avif']],
  ] as const;

  it.for(NEWER_LIBHEIF_SAMPLES)('converts %s to the picture libheif decodes when libheif reads the file', { timeout: REAL_FILE_TIMEOUT_MS }, async ([id, width, height, targets], ctx) => {
    const sample = await requireRealworldSample(ctx, id);
    // skip-ok: the refusal test below runs where libheif cannot read the file, so exactly one of the two runs on any machine
    if (!libheifReads(sample.path)) ctx.skip();
    const converted = await decodeRgba((await dispatchConversion(sample.bytes, 'heif', 'png', {}, id)).buffer);
    expect([converted.width, converted.height]).toEqual([width, height]);
    expect(maxSampleDifference(converted, await referenceDecode(sample.path))).toBeLessThanOrEqual(1);
    for (const target of targets) {
      expect((await decodeRgba((await dispatchConversion(sample.bytes, 'heif', target, {}, id)).buffer)).width).toBe(width);
    }
    expect((await dispatchConversion(sample.bytes, 'heif', 'pdf', {}, id)).buffer.toString('latin1', 0, 5)).toBe('%PDF-');
  });

  it.for(NEWER_LIBHEIF_SAMPLES)('refuses %s with the typed answer when libheif cannot read the file', { timeout: REAL_FILE_TIMEOUT_MS }, async ([id], ctx) => {
    const sample = await requireRealworldSample(ctx, id);
    // skip-ok: the conversion test above runs where libheif reads the file, so exactly one of the two runs on any machine
    if (libheifReads(sample.path)) ctx.skip();
    await expect(dispatchConversion(sample.bytes, 'heif', 'png', {}, id)).rejects.toMatchObject({ name: 'ConversionFailedError', message: 'Invalid image: the HEIF picture could not be decoded' });
  });

  it('keeps the transparency of a picture with an alpha plane', async (ctx) => {
    const sample = await requireRealworldSample(ctx, 'libheif-with-alpha-512x512.heic');
    const converted = await decodeRgba((await dispatchConversion(sample.bytes, 'heic', 'png', {}, 'alpha.heic')).buffer);
    const alphas = new Set(Array.from({ length: converted.width * converted.height }, (_, i) => converted.data[i * 4 + 3]));
    expect(alphas.size).toBeGreaterThan(1);
  });

  it('turns a rotated picture once: the rotation the file states is applied, and the EXIF orientation is not applied again', async () => {
    const bytes = fs.readFileSync(path.join(__dirname, 'fixtures', 'images', 'heic-quarter-turn.heic'));
    const converted = await decodeRgba((await dispatchConversion(bytes, 'heic', 'png', {}, 'rotated.heic')).buffer);
    expect([converted.width, converted.height]).toEqual([30, 60]);
    const pixelAt = (x: number, y: number): number[] => Array.from(converted.data.subarray((y * converted.width + x) * 4, (y * converted.width + x) * 4 + 3));
    const top = pixelAt(15, 5);
    const bottom = pixelAt(15, 55);
    expect(top[0]).toBeGreaterThan(240);
    expect(top[2]).toBeLessThan(15);
    expect(bottom[0]).toBeLessThan(15);
    expect(bottom[2]).toBeGreaterThan(240);
  });
});

/** An EXIF block (TIFF structure, little-endian) with one entry: Orientation (0x0112) = `orientation`. */
function exifWithOrientation(orientation: number): Buffer {
  const exif = Buffer.alloc(8 + 2 + 12 + 4);
  exif.write('II', 0, 'ascii');
  exif.writeUInt16LE(42, 2);
  exif.writeUInt32LE(8, 4);
  exif.writeUInt16LE(1, 8);
  exif.writeUInt16LE(0x0112, 10);
  exif.writeUInt16LE(3, 12);
  exif.writeUInt32LE(1, 14);
  exif.writeUInt16LE(orientation, 18);
  return exif;
}

/** Offset of the Orientation value in the EXIF block above: TIFF header (8), entry count (2), tag, type, count (8). */
const ORIENTATION_VALUE_OFFSET = 18;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

describe('the orientation of an EXIF chunk the decoder wrote', () => {
  it('is set to 1 and the chunk stays a valid PNG chunk', () => {
    const header = pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]));
    const png = Buffer.concat([PNG_SIGNATURE, header, pngChunk('eXIf', exifWithOrientation(6)), pngChunk('IEND', Buffer.alloc(0))]);
    const fixed = withUprightExifOrientation(png);
    const chunkAt = PNG_SIGNATURE.length + header.length;
    expect(fixed.readUInt16LE(chunkAt + 8 + ORIENTATION_VALUE_OFFSET)).toBe(1);
    expect(fixed.subarray(chunkAt + 4, chunkAt + 8).toString('ascii')).toBe('eXIf');
    const rebuilt = pngChunk('eXIf', exifWithOrientation(1));
    expect(fixed.subarray(chunkAt, chunkAt + rebuilt.length)).toEqual(rebuilt);
    expect(fixed.length).toBe(png.length);
  });

  it('is left alone when the PNG ends inside the checksum of the EXIF chunk', () => {
    const header = pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]));
    const png = Buffer.concat([PNG_SIGNATURE, header, pngChunk('eXIf', exifWithOrientation(6))]);
    for (const missing of [1, 2, 3, 4]) {
      const cut = png.subarray(0, png.length - missing);
      expect(withUprightExifOrientation(cut)).toEqual(cut);
    }
    expect(withUprightExifOrientation(png).readUInt16LE(PNG_SIGNATURE.length + header.length + 8 + ORIENTATION_VALUE_OFFSET)).toBe(1);
  });

  it('is left alone when the PNG has no EXIF chunk or ends inside a chunk', () => {
    const header = pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]));
    const plain = Buffer.concat([PNG_SIGNATURE, header, pngChunk('IEND', Buffer.alloc(0))]);
    expect(withUprightExifOrientation(plain)).toEqual(plain);
    const cut = plain.subarray(0, PNG_SIGNATURE.length + header.length - 5);
    expect(withUprightExifOrientation(cut)).toEqual(cut);
  });
});
