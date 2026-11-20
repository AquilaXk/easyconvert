import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import { quantizedBmp8 } from '../src/lib/conversions/bmp-palette-quantizer';
import { findQuantizr } from '../src/lib/conversions/png-palette-quantizer';
import { requireOracleTool } from './helpers/differential-oracle';
import { meanDeltaE2000 } from './helpers/ciede2000';
import { measureSsimPsnr } from './helpers/ffmpeg-measure';
import { skipUnless, skipWithoutTools } from './helpers/strict-skip';
import { runWithoutFileConfinement } from './helpers/unconfined-files';

// The stand-in programs of this suite write their records outside the job directory, which the file confinement refuses (policy 248).
runWithoutFileConfinement();

/**
 * The palette of an 8-bit BMP, chosen by quantizr-pixels (entry 365 of docs/policy-decisions.md). The files are judged by what ffmpeg decodes from them
 * and by PSNR, SSIM (ffmpeg's filters, on yuv420p as the parity benchmark takes it) and CIEDE2000 (`tests/helpers/ciede2000.ts`), none of which shares
 * code with the writer or the quantisers; the Oklab quantiser (`quantizer: 'oklab'`, the palette of the BMP before the program) is the other side of
 * the comparison.
 */

const PHOTO = path.join(__dirname, '..', 'bench', 'corpus', 'photo-a.jpg');
const RGBA = 4;
/** Photo-a.jpg as an 8-bit BMP with the program measures 39.24 dB, SSIM 0.9222 and CIEDE2000 3.47 (the Oklab quantiser: 38.19 dB, 0.9095, 3.81); the floors lie below. */
const FLOORS = { psnr: 38.5, ssim: 0.915, deltaE2000: 3.7 };

const real = findQuantizr();
const needsProgram = skipUnless('quantizr-pixels', real !== null) || skipWithoutTools('ffmpeg');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bmp-quantizr-'));
const standIns: string[] = [];

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
  for (const dir of standIns) fs.rmSync(dir, { recursive: true, force: true });
});

interface Picture {
  width: number;
  height: number;
  rgba: Buffer;
  png: Buffer;
}

async function pictureOf(input: Buffer | string, edit?: (rgba: Buffer) => void): Promise<Picture> {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgba = Buffer.from(data);
  edit?.(rgba);
  const png = await sharp(rgba, { raw: { width: info.width, height: info.height, channels: RGBA } }).png({ compressionLevel: 1 }).toBuffer();
  return { width: info.width, height: info.height, rgba, png };
}

/** The picture of a BMP as ffmpeg decodes it: 8-bit RGBA. */
function decoded(file: Buffer, picture: Picture): Buffer {
  const target = path.join(scratch, `decode-${process.hrtime.bigint()}.bmp`);
  fs.writeFileSync(target, file);
  const run = spawnSync(requireOracleTool('ffmpeg'), ['-v', 'error', '-nostdin', '-i', target, '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28 });
  expect(run.status, String(run.stderr)).toBe(0);
  expect(run.stdout.length).toBe(picture.width * picture.height * RGBA);
  return run.stdout;
}

function distinctColours(rgba: Uint8Array): number {
  const seen = new Set<number>();
  for (let i = 0; i < rgba.length; i += RGBA) seen.add(((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]) >>> 0);
  return seen.size;
}

interface Score {
  psnr: number;
  ssim: number;
  deltaE2000: number;
}

/** PSNR and SSIM from ffmpeg against the source picture, and the mean CIEDE2000 of the decoded raster. */
function score(file: Buffer, picture: Picture): Score {
  const sourceFile = path.join(scratch, 'source.png');
  fs.writeFileSync(sourceFile, picture.png);
  const resultFile = path.join(scratch, 'result.bmp');
  fs.writeFileSync(resultFile, file);
  const { ssim, psnr } = measureSsimPsnr(requireOracleTool('ffmpeg'), resultFile, sourceFile);
  return { psnr, ssim, deltaE2000: meanDeltaE2000(picture.rgba, decoded(file, picture)) };
}

describe.skipIf(needsProgram)('a photograph converted to an 8-bit BMP with the program', () => {
  let photo: Picture;
  beforeAll(async () => {
    photo = await pictureOf(PHOTO);
  });

  it('is an 8-bit BMP of at most 256 colours at the quality floors', async () => {
    const { buffer } = await convertFile(photo.png, 'png', 'bmp', { colorDepth: 8 }, 'photo.png');
    expect(buffer.subarray(0, 2).toString('latin1')).toBe('BM');
    expect(buffer.readUInt16LE(28)).toBe(8);
    expect(buffer.readUInt32LE(46)).toBeLessThanOrEqual(256);
    expect(distinctColours(decoded(buffer, photo))).toBeLessThanOrEqual(256);
    const head = score(buffer, photo);
    expect(head.psnr).toBeGreaterThan(FLOORS.psnr);
    expect(head.ssim).toBeGreaterThan(FLOORS.ssim);
    expect(head.deltaE2000).toBeLessThan(FLOORS.deltaE2000);
  });

  it('beats the Oklab quantiser on PSNR, SSIM and CIEDE2000 with the default dithering, in a file of the same size', async () => {
    const head = await convertFile(photo.png, 'png', 'bmp', { colorDepth: 8 }, 'photo.png');
    const base = await convertFile(photo.png, 'png', 'bmp', { colorDepth: 8, quantizer: 'oklab' }, 'photo.png');
    const headScore = score(head.buffer, photo);
    const baseScore = score(base.buffer, photo);
    expect(headScore.psnr).toBeGreaterThan(baseScore.psnr);
    expect(headScore.ssim).toBeGreaterThan(baseScore.ssim);
    expect(headScore.deltaE2000).toBeLessThan(baseScore.deltaE2000);
    // A BMP of 8 bits is its headers, its table and its padded rows: the size does not depend on the palette but for the entries of the table.
    expect(head.buffer.length).toBeLessThanOrEqual(base.buffer.length);
  });

  it('holds only the colours that were asked for', async () => {
    const { buffer } = await convertFile(photo.png, 'png', 'bmp', { colorDepth: 8, colors: 32 }, 'photo.png');
    expect(buffer.readUInt32LE(46)).toBeLessThanOrEqual(32);
    expect(distinctColours(decoded(buffer, photo))).toBeLessThanOrEqual(32);
    expect(score(buffer, photo).psnr).toBeGreaterThan(30);
  });

  it('leaves a BMP without dithering to the Oklab quantiser: the program is not run', async () => {
    const { program, argsFile } = standIn('sys.exit(9)');
    vi.stubEnv('QUANTIZR_PIXELS_PATH', program);
    try {
      const { buffer } = await convertFile(photo.png, 'png', 'bmp', { colorDepth: 8, dither: false }, 'photo.png');
      expect(fs.existsSync(argsFile)).toBe(false);
      expect(score(buffer, photo).psnr).toBeGreaterThan(30);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('writes a picture with transparency as its colours, alpha taking no part in the palette', async () => {
    const masked = await pictureOf(PHOTO, (rgba) => {
      for (let i = 3; i < rgba.length; i += RGBA) rgba[i] = i % 7 === 0 ? 0 : 255;
    });
    const written = await quantizedBmp8(sharp(masked.png), { colours: 256, options: {} });
    expect(written).not.toBeNull();
    const raster = decoded(written as Buffer, masked);
    const opaque = await pictureOf(PHOTO);
    expect(meanDeltaE2000(opaque.rgba, raster)).toBeLessThan(FLOORS.deltaE2000);
  });
});

/** A program that records its arguments and the bytes it is given, then answers with `body` (a Python script; `input` and `out` are bound). */
function standIn(body: string): { program: string; argsFile: string; inputFile: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmp-stand-in-'));
  standIns.push(dir);
  const argsFile = path.join(dir, 'args.txt');
  const inputFile = path.join(dir, 'input.bin');
  const program = path.join(dir, 'quantizr-pixels');
  const script = [
    '#!/usr/bin/env python3',
    'import struct, sys',
    `open(${JSON.stringify(argsFile)}, 'w').write(' '.join(sys.argv[1:]))`,
    'input = sys.stdin.buffer.read()',
    'try:',
    `  open(${JSON.stringify(inputFile)}, 'wb').write(input)`,
    'except OSError:',
    '  pass',
    'out = sys.stdout.buffer',
    body,
  ].join('\n');
  fs.writeFileSync(program, script, { mode: 0o755 });
  return { program, argsFile, inputFile };
}

describe.skipIf(skipWithoutTools('ffmpeg', 'python3'))('what the converter gives the program and what it takes back', () => {
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  /** 4 x 1 pixels of four colours, the alpha 0, 127, 128 and 255. */
  const fourPixels = async (): Promise<Picture> =>
    pictureOf(await sharp({ create: { width: 4, height: 1, channels: 4, background: '#000000' } }).png().toBuffer(), (rgba) => {
      [[10, 20, 30, 0], [40, 50, 60, 127], [70, 80, 90, 128], [100, 110, 120, 255]].forEach((pixel, i) => rgba.set(pixel, i * RGBA));
    });

  it('hands over the pixels with alpha 255, the colour count and the dithering level of entry 253, and writes the palette and indices it answers', async () => {
    const picture = await fourPixels();
    const answer = `
width, height = struct.unpack_from('<II', input, 0)
out.write(struct.pack('<I', 2) + bytes([200, 100, 50, 255, 1, 2, 3, 255]) + bytes([0, 1, 1, 0]))
out.flush()`;
    const { program, argsFile, inputFile } = standIn(answer);
    vi.stubEnv('QUANTIZR_PIXELS_PATH', program);
    const written = await quantizedBmp8(sharp(picture.png), { colours: 16, options: {} });
    expect(written).not.toBeNull();
    expect(fs.readFileSync(argsFile, 'utf8')).toContain('--colors 16 --dither 0.25 ');
    const given = fs.readFileSync(inputFile);
    expect([given.readUInt32LE(0), given.readUInt32LE(4)]).toEqual([4, 1]);
    expect([...given.subarray(8)]).toEqual([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255]);
    const raster = decoded(written as Buffer, picture);
    expect([...raster]).toEqual([200, 100, 50, 255, 1, 2, 3, 255, 1, 2, 3, 255, 200, 100, 50, 255]);
  });

  it('writes the picture with the Oklab quantiser when the program fails, answers something that does not fit, or is not installed', async () => {
    const photo = await pictureOf(PHOTO);
    const bodies = ['sys.stderr.write("broken"); sys.exit(3)', 'out.write(b"\\x01\\x00\\x00\\x00")'];
    const programs = [...bodies.map((body) => standIn(body).program), '/nonexistent/quantizr-pixels'];
    for (const program of programs) {
      vi.stubEnv('QUANTIZR_PIXELS_PATH', program);
      const { buffer } = await convertFile(photo.png, 'png', 'bmp', { colorDepth: 8 }, 'photo.png');
      expect(buffer.readUInt16LE(28)).toBe(8);
      expect(score(buffer, photo).psnr).toBeGreaterThan(25);
    }
  });
});
