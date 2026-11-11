import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { DJXL_PATH_ENV, findDjxl } from '../src/lib/conversions/image-jxl-cli';
import { MAX_INPUT_PIXELS_ENV } from '../src/lib/conversions/image-input-limits';
import { getOracleToolPath } from './helpers/differential-oracle';
import { buildPnm } from './helpers/image-format-builders';
import { decodeRgba, maxSampleDifference, rgbaBytes, sixteenBitSamples } from './helpers/image-pixels';
import { jxlCodestream, jxlContainer, jxlSizeHeader } from './helpers/jxl-builders';
import { magickPsnr } from './helpers/magick-compare';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipUnless, skipWithoutTools } from './helpers/strict-skip';
import { runWithoutFileConfinement } from './helpers/unconfined-files';

// The stand-in programs of this suite write their records outside the job directory, which the file confinement refuses (policy 248).
runWithoutFileConfinement();

/**
 * JPEG XL pictures convert through libjxl's `djxl` (a separate sandboxed program) to the lossless PNG that the image pipeline then
 * writes as any other picture. The pictures written here are encoded losslessly by `cjxl` from pixels the test knows, so the decode is
 * judged against those pixels; the conformance files of the libjxl project (bare codestreams and containers, orientation, ICC profiles,
 * 10 and 12 bit samples, alpha, an animation) are judged against a reference decode by `djxl` itself, and every output is read back by a
 * decoder that is not ours (ImageMagick, `avifdec`).
 */

/** The largest conformance file is a 1.4-megapixel 16-bit picture, decoded twice and compared. */
const REAL_FILE_TIMEOUT_MS = 60_000;

const needsLibjxl = skipUnless('the libjxl tools (cjxl, djxl)', findDjxl() !== null && getOracleToolPath('cjxl') !== null && getOracleToolPath('djxl') !== null);

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jxl-decode-'));
afterAll(() => fs.rmSync(workDir, { recursive: true, force: true }));

const WIDTH = 64;
const HEIGHT = 48;
const gradient = Array.from({ length: WIDTH * HEIGHT }, (_, i) => ({ r: (i * 7) % 256, g: (i * 13 + 5) % 256, b: (i * 29 + 11) % 256, a: 255 }));
const gradientNetpbm = buildPnm('P6', WIDTH, HEIGHT, 255, gradient.flatMap((p) => [p.r, p.g, p.b]));
let fileCount = 0;

/** Encodes a Netpbm file losslessly (distance 0) with the reference encoder, as a bare codestream. */
function encodeLossless(netpbm: Buffer): Buffer {
  const id = fileCount++;
  const input = path.join(workDir, `in-${id}.${netpbm.toString('latin1', 0, 2) === 'P6' ? 'ppm' : 'pgm'}`);
  const output = path.join(workDir, `out-${id}.jxl`);
  fs.writeFileSync(input, netpbm);
  execFileSync(getOracleToolPath('cjxl') as string, [input, output, '-d', '0', '--quiet'], { stdio: 'pipe' });
  return fs.readFileSync(output);
}

/** The reference decode of a JPEG XL file: the PNG (an APNG for an animation) that `djxl` writes. */
function referenceDecode(file: string): string {
  const output = path.join(workDir, `reference-${fileCount++}.png`);
  execFileSync(getOracleToolPath('djxl') as string, [file, output, '--quiet'], { stdio: 'pipe' });
  return output;
}

/** The minor version of the installed libjxl (the 11 of `djxl v0.11.2`). */
function libjxlMinorVersion(): number {
  const banner = execFileSync(findDjxl() as string, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return Number(/v0\.(\d+)/.exec(banner)?.[1] ?? 0);
}

function convert(bytes: Buffer, target: string, name = 'picture.jxl') {
  return dispatchConversion(bytes, 'jxl', target, {}, name);
}

function withDjxlPath<T>(value: string, run: () => Promise<T>): Promise<T> {
  const saved = process.env[DJXL_PATH_ENV];
  process.env[DJXL_PATH_ENV] = value;
  return run().finally(() => {
    if (saved === undefined) delete process.env[DJXL_PATH_ENV];
    else process.env[DJXL_PATH_ENV] = saved;
  });
}

describe.skipIf(needsLibjxl)('JPEG XL pictures with known pixels', () => {
  const codestream = encodeLossless(gradientNetpbm);

  it('decodes a lossless codestream to the pixels that were encoded', async () => {
    expect([...codestream.subarray(0, 2)]).toEqual([0xff, 0x0a]);
    const decoded = await decodeRgba((await convert(codestream, 'png')).buffer);
    expect([decoded.width, decoded.height]).toEqual([WIDTH, HEIGHT]);
    expect(decoded.data).toEqual(rgbaBytes(gradient));
  });

  it('decodes the same picture from a container, and from a container that splits the codestream into partial boxes', async () => {
    const box = (type: string, content: Buffer) => ({ type, content });
    const half = Math.floor(codestream.length / 2);
    const partial = (index: number, last: boolean, bytes: Buffer) => {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(last ? (0x80000000 | index) >>> 0 : index, 0);
      return box('jxlp', Buffer.concat([header, bytes]));
    };
    for (const file of [
      jxlContainer([box('jxlc', codestream)]),
      jxlContainer([box('Exif', Buffer.alloc(12)), box('jxlc', codestream)]),
      jxlContainer([partial(0, false, codestream.subarray(0, half)), partial(1, true, codestream.subarray(half))]),
    ]) {
      const decoded = await decodeRgba((await convert(file, 'png')).buffer);
      expect(decoded.data).toEqual(rgbaBytes(gradient));
    }
  });

  it('takes the kind of file from its bytes, not from the name it was uploaded under', async () => {
    const decoded = await decodeRgba((await convert(codestream, 'png', 'misnamed.png.jxl')).buffer);
    expect(decoded.data).toEqual(rgbaBytes(gradient));
  });

  it('keeps the 16 bits of a deep grey picture', async () => {
    const samples = [0, 257, 40000, 65535, 1, 65534];
    const expected = Array.from({ length: WIDTH * HEIGHT }, (_, i) => samples[i % samples.length]);
    const jxl = encodeLossless(buildPnm('P5', WIDTH, HEIGHT, 65535, expected));
    expect(await sixteenBitSamples((await convert(jxl, 'png')).buffer, 'grey16')).toEqual(expected);
  });

  it('writes each of the 13 targets as a file the reference reads back', async () => {
    const targets = ['avif', 'bmp', 'eps', 'gif', 'ico', 'jpg', 'odd', 'pdf', 'png', 'ps', 'psd', 'tiff', 'webp'];
    // A smooth picture: the lossy writers keep it within a few levels, which noise would hide.
    const smooth = encodeLossless(buildPnm('P6', 128, 96, 255, Array.from({ length: 128 * 96 }, (_, i) => [(i % 128) * 2, Math.floor(i / 128) * 2, ((i % 128) + Math.floor(i / 128)) % 256]).flat()));
    const referencePng = referenceDecode(writeFile('known.jxl', smooth));
    for (const target of targets) {
      const result = await convert(smooth, target);
      expect(result.buffer.length, target).toBeGreaterThan(100);
      expect(result.filename, target).toBe(`picture.${target}`);
      const file = writeFile(`known-out.${target}`, result.buffer);
      // Pictures in a format ImageMagick reads are compared with it; the others by their own signature.
      // ImageMagick reports identical pictures as 120 dB (or infinity), whichever way the build rounds the mean square error.
      if (['bmp', 'png', 'tiff'].includes(target)) expect(magickPsnr(file, referencePng), target).toBeGreaterThanOrEqual(120);
      if (['jpg', 'webp', 'gif'].includes(target)) expect(magickPsnr(file, referencePng), target).toBeGreaterThan(25);
    }
  });
});

function writeFile(name: string, bytes: Buffer): string {
  const file = path.join(workDir, `${fileCount++}-${name}`);
  fs.writeFileSync(file, bytes);
  return file;
}

/** The 16-bit RGBA samples of a PNG, row by row. */
async function samples16(bytes: Buffer): Promise<Uint16Array> {
  const { data } = await sharp(bytes).ensureAlpha().raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true });
  return new Uint16Array(data.buffer, data.byteOffset, data.length / Uint16Array.BYTES_PER_ELEMENT);
}

const SIXTEEN_BIT_TOLERANCE = 512;

/** The largest difference between two sample arrays, a number so that a failure never prints millions of samples. */
function largestDifference(a: Uint16Array, b: Uint16Array): number {
  if (a.length !== b.length) return Infinity;
  let largest = 0;
  for (let i = 0; i < a.length; i += 1) largest = Math.max(largest, Math.abs(a[i] - b[i]));
  return largest;
}

/** The picture converted to sRGB by its own profile, as 8-bit RGBA: pictures that carry a profile compare in the colours a viewer shows. */
async function inSrgb(bytes: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(bytes).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** The Orientation (tag 0x0112) of the first directory of an EXIF block, with or without the `Exif\0\0` prefix; undefined when it has none. */
function exifOrientation(exif: Buffer): number | undefined {
  const start = exif.toString('latin1', 0, 6) === 'Exif\0\0' ? 6 : 0;
  const little = exif.toString('latin1', start, start + 2) === 'II';
  const u16 = (at: number) => (little ? exif.readUInt16LE(at) : exif.readUInt16BE(at));
  const ifd = start + (little ? exif.readUInt32LE(start + 4) : exif.readUInt32BE(start + 4));
  for (let i = 0; i < u16(ifd); i += 1) {
    const entry = ifd + 2 + i * 12;
    if (u16(entry) === 0x0112) return u16(entry + 8);
  }
  return undefined;
}

function psnr(a: Buffer, b: Buffer): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += (a[i] - b[i]) ** 2;
  return sum === 0 ? Infinity : 10 * Math.log10((255 * 255 * a.length) / sum);
}

describe.skipIf(needsLibjxl)('the conformance files of the libjxl project', () => {
  // Pictures in sRGB: the PNG must equal the reference decode sample for sample, at the depth the file has.
  it.for([
    ['libjxl-delta-palette.jxl', 555, 751, 8],
    // 10-bit samples, an orientation in the header and two layers (a bare codestream).
    ['libjxl-sunset-logo.jxl', 924, 1386, 16],
    // 12-bit colour and 16-bit alpha in a container.
    ['libjxl-alpha-premultiplied.jxl', 1024, 1024, 16],
  ] as const)('decodes %s to the picture the reference decoder writes', { timeout: REAL_FILE_TIMEOUT_MS }, async ([id, width, height, depth], ctx) => {
    const sample = await requireRealworldSample(ctx, id);
    if (id === 'libjxl-alpha-premultiplied.jxl' && libjxlMinorVersion() < 8) {
      // libjxl 0.7 cannot write a picture whose alpha is deeper than its colour (12 and 16 bits) as a PNG: the decoder's refusal is the answer.
      await expect(convert(sample.bytes, 'png', id)).rejects.toMatchObject({ name: 'ConversionFailedError', message: 'Invalid image: the JPEG XL picture could not be decoded' });
      return;
    }
    const converted = (await convert(sample.bytes, 'png', id)).buffer;
    const reference = fs.readFileSync(referenceDecode(sample.path));
    const meta = await sharp(converted).metadata();
    expect([meta.width, meta.height, meta.depth]).toEqual([width, height, depth === 16 ? 'ushort' : 'uchar']);
    // libjxl before 0.8 tags an sRGB picture with a profile as well, and the profile's transform rounds a 16-bit sample by up to 0.4 percent of the range.
    if (depth === 16) expect(largestDifference(await samples16(converted), await samples16(reference))).toBeLessThanOrEqual(SIXTEEN_BIT_TOLERANCE);
    else expect(maxSampleDifference(await decodeRgba(converted), await decodeRgba(reference))).toBe(0);
  });

  // Pictures with a profile of their own (a grey ramp, a permuted-channel RGB profile, a printer-style profile): the colours a viewer shows.
  it.for([
    ['libjxl-grayscale.jxl', 200, 200],
    ['libjxl-grayscale-jpeg.jxl', 200, 200],
    ['libjxl-patches-lossless.jxl', 1600, 1096],
    // Orientation 5 (transpose) in the codestream and in the Exif box; a container that holds a recompressed JPEG.
    ['libjxl-bench-oriented-brg.jxl', 606, 500],
  ] as const)('keeps the profile of %s: PNG and TIFF show the colours of the reference decode', { timeout: REAL_FILE_TIMEOUT_MS }, async ([id, width, height], ctx) => {
    const sample = await requireRealworldSample(ctx, id);
    const reference = await inSrgb(fs.readFileSync(referenceDecode(sample.path)));
    for (const target of ['png', 'tiff']) {
      const converted = await inSrgb((await convert(sample.bytes, target, id)).buffer);
      expect([converted.width, converted.height], target).toEqual([width, height]);
      expect(psnr(converted.data, reference.data), target).toBeGreaterThan(50);
    }
    const jpeg = await inSrgb((await convert(sample.bytes, 'jpg', id)).buffer);
    expect(psnr(jpeg.data, reference.data)).toBeGreaterThan(30);
  });

  it('turns the picture by the orientation of the header and keeps the Exif block of the file upright', { timeout: REAL_FILE_TIMEOUT_MS }, async (ctx) => {
    const sample = await requireRealworldSample(ctx, 'libjxl-bench-oriented-brg.jxl');
    // The codestream states 500 x 606 pixels and the transpose that turns it to 606 x 500.
    for (const target of ['png', 'jpg', 'webp', 'tiff']) {
      const out = (await convert(sample.bytes, target, 'oriented.jxl')).buffer;
      const meta = await sharp(out).metadata();
      expect([meta.width, meta.height], target).toEqual([606, 500]);
      expect(meta.orientation ?? 1, target).toBe(1);
      // A TIFF keeps the tags of the block in its own directory, which the image library does not hand out as a block.
      if (target === 'tiff') continue;
      expect(meta.exif, target).toBeDefined();
      expect(exifOrientation(meta.exif as Buffer), target).toBe(1);
    }
  });

  it('reads an animation as its first frame for a still target and as every frame for GIF and WebP', { timeout: REAL_FILE_TIMEOUT_MS }, async (ctx) => {
    const sample = await requireRealworldSample(ctx, 'libjxl-animation-spline.jxl');
    const still = await convert(sample.bytes, 'png', 'spline.jxl');
    expect(still).toMatchObject({ sourceFrameCount: 60, frameUsed: 1 });
    expect(await sharp(still.buffer).metadata()).toMatchObject({ width: 320, height: 320 });
    const reference = await decodeRgba(await sharp(fs.readFileSync(referenceDecode(sample.path)), { page: 0 }).png().toBuffer());
    expect(maxSampleDifference(await decodeRgba(still.buffer), reference)).toBe(0);
    for (const target of ['gif', 'webp']) {
      const animated = await convert(sample.bytes, target, 'spline.jxl');
      expect(await sharp(animated.buffer, { animated: true }).metadata(), target).toMatchObject({ pages: 60, width: 320, pageHeight: 320 });
    }
  });
});

describe.skipIf(needsLibjxl || skipWithoutTools('avifdec'))('the formats the output is read back in by a decoder that is not ours', () => {
  it('are the pictures of the reference decode: AVIF through avifdec', { timeout: REAL_FILE_TIMEOUT_MS }, async (ctx) => {
    const avifdec = getOracleToolPath('avifdec') as string;
    const sample = await requireRealworldSample(ctx, 'libjxl-delta-palette.jxl');
    const avif = writeFile('palette.avif', (await convert(sample.bytes, 'avif', 'palette.jxl')).buffer);
    const decoded = path.join(workDir, 'palette-avif.png');
    execFileSync(avifdec, ['--ignore-icc', avif, decoded], { stdio: 'pipe' });
    expect(magickPsnr(decoded, referenceDecode(sample.path))).toBeGreaterThan(30);
  });
});

describe.skipIf(needsLibjxl)('JPEG XL files that cannot be decoded', () => {
  const header = 'Invalid image: the JPEG XL header could not be decoded';
  const picture = 'Invalid image: the JPEG XL picture could not be decoded';

  it('refuses bytes that carry the signature and no header', async () => {
    await expect(convert(Buffer.from([0xff, 0x0a]), 'png')).rejects.toMatchObject({ name: 'ConversionFailedError', message: header });
    await expect(convert(jxlContainer([]), 'png')).rejects.toMatchObject({ name: 'ConversionFailedError', message: header });
  });

  it('refuses a codestream that ends before its pixels do', async () => {
    const whole = encodeLossless(gradientNetpbm);
    await expect(convert(whole.subarray(0, whole.length - 40), 'png')).rejects.toMatchObject({ name: 'ConversionFailedError', message: picture });
  });

  it('refuses a header that is followed by bytes that are no picture', async () => {
    const noise = Buffer.from(Array.from({ length: 200 }, (_, i) => (i * 37 + 11) % 256));
    await expect(convert(Buffer.concat([jxlCodestream(jxlSizeHeader({ small: true, width: 64, height: 64 }), 0), noise]), 'png')).rejects.toMatchObject({ name: 'ConversionFailedError', message: picture });
  });

  it('refuses a tiny codestream that declares a picture over the input limit before decoding it', async () => {
    const huge = jxlCodestream(jxlSizeHeader({ small: false, width: 30_000, height: 30_000 }));
    await expect(convert(huge, 'png')).rejects.toMatchObject({ name: 'InputPixelLimitError', status: 413, width: 30_000, height: 30_000 });
    const saved = process.env[MAX_INPUT_PIXELS_ENV];
    try {
      process.env[MAX_INPUT_PIXELS_ENV] = String(WIDTH * HEIGHT - 1);
      await expect(convert(encodeLossless(gradientNetpbm), 'png')).rejects.toMatchObject({ name: 'InputPixelLimitError', status: 413, limit: WIDTH * HEIGHT - 1, width: WIDTH, height: HEIGHT });
      process.env[MAX_INPUT_PIXELS_ENV] = String(WIDTH * HEIGHT);
      expect((await convert(encodeLossless(gradientNetpbm), 'png')).buffer.length).toBeGreaterThan(0);
    } finally {
      if (saved === undefined) delete process.env[MAX_INPUT_PIXELS_ENV];
      else process.env[MAX_INPUT_PIXELS_ENV] = saved;
    }
  });
});

describe('the decoder program', () => {
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djxl-stub-'));
  afterAll(() => fs.rmSync(stubDir, { recursive: true, force: true }));
  let stubCount = 0;
  const valid = jxlCodestream(jxlSizeHeader({ small: true, width: 16, height: 16 }));

  /** A stand-in for djxl: a script that runs `body` in the job directory with the arguments it was given. */
  function convertWithStub(body: string): Promise<unknown> {
    const stub = path.join(stubDir, `djxl-${stubCount++}`);
    fs.writeFileSync(stub, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return withDjxlPath(stub, () => convert(valid, 'png'));
  }

  it('names the missing engine when DJXL_PATH is not a program', async () => {
    const message = { name: 'EngineUnavailableError', engineName: 'djxl' };
    await expect(withDjxlPath('/nonexistent/djxl', () => convert(valid, 'png'))).rejects.toMatchObject(message);
    await expect(withDjxlPath(path.relative(process.cwd(), stubDir), () => convert(valid, 'png'))).rejects.toMatchObject(message);
  });

  it.each([126, 127])('names the missing engine when the program cannot be started (exit status %i)', async (status) => {
    await expect(convertWithStub(`exit ${status}`)).rejects.toMatchObject({ name: 'EngineUnavailableError', engineName: 'djxl' });
  });

  it('refuses a run that fails, exits cleanly without a picture, or leaves something that is not a regular file', async () => {
    const refusal = { name: 'ConversionFailedError', message: 'Invalid image: the JPEG XL picture could not be decoded' };
    await expect(convertWithStub('echo "failed to decode" >&2; exit 1')).rejects.toMatchObject(refusal);
    await expect(convertWithStub('exit 0')).rejects.toMatchObject(refusal);
    await expect(convertWithStub('mkdir out.png')).rejects.toMatchObject(refusal);
    await expect(convertWithStub('printf x > elsewhere; ln -s elsewhere out.png')).rejects.toMatchObject(refusal);
  });

  it('is run on the file and the name the decoder expects, with two threads, in a private directory that is removed afterwards', async () => {
    const log = path.join(stubDir, `args-${stubCount}.log`);
    await convertWithStub(`printf '%s\\n' "$@" > '${log}'; pwd >> '${log}'; exit 1`).catch(() => undefined);
    const lines = fs.readFileSync(log, 'utf8').split('\n').filter((line) => line !== '');
    expect(lines.slice(0, 4)).toEqual(['in.jxl', 'out.png', '--num_threads=2', '--quiet']);
    expect(path.basename(lines[4])).toMatch(/^easyconvert-decode-/);
    expect(fs.existsSync(lines[4])).toBe(false);
  });
});
