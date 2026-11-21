import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import { ICO_PROGRAM_MIN_PIXELS, quantizedIconPng } from '../src/lib/conversions/ico-palette-quantizer';
import { findQuantizr } from '../src/lib/conversions/png-palette-quantizer';
import { meanDeltaE2000 } from './helpers/ciede2000';
import { requireOracleTool } from './helpers/differential-oracle';
import { measureSsimPsnr } from './helpers/ffmpeg-measure';
import { runIdentify, SKIP_WITHOUT_MAGICK, withTempImage } from './helpers/imagemagick';
import { skipUnless, skipWithoutTools } from './helpers/strict-skip';
import { runWithoutFileConfinement } from './helpers/unconfined-files';

// The stand-in programs of this suite write their records outside the job directory, which the file confinement refuses (policy 248).
runWithoutFileConfinement();

/**
 * The palette of a dithered 8-bit ICO of 64 x 64 pixels or more, chosen by quantizr-pixels (entry 376 of docs/policy-decisions.md). The icon is judged by what
 * ffmpeg decodes from it (its ICO demuxer and PNG decoder), by ImageMagick (`identify -format %k` counts the colours of the picture inside), and by PSNR, SSIM
 * (ffmpeg's filters, on yuv420p as the parity benchmark takes it) and CIEDE2000 (`tests/helpers/ciede2000.ts`), none of which shares code with the writer or
 * the quantisers. The Oklab quantiser (`quantizer: 'oklab'`, the palette of the icon before the program) is the other side of the comparison.
 */

const PHOTO = path.join(__dirname, '..', 'bench', 'corpus', 'photo-a.jpg');
const RGBA = 4;
const SIZE = 256;
const PNG_COLOUR_TYPE_OFFSET = 25;
const PNG_PALETTE = 3;
const ICO_PNG_OFFSET = 22;
/** photo-a.jpg at 256 x 256 as an 8-bit ICO measures 40.17 dB, SSIM 0.9394 and CIEDE2000 3.27 with the program, in 26,268 bytes (the Oklab quantiser: 39.30 dB, 0.9297, 3.52, 41,002 bytes); the floors lie below. */
const FLOORS = { psnr: 39.5, ssim: 0.935, deltaE2000: 3.4 };

const real = findQuantizr();
const needsProgram = skipUnless('quantizr-pixels', real !== null) || skipWithoutTools('ffmpeg') || SKIP_WITHOUT_MAGICK;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ico-quantizr-'));
const standIns: string[] = [];

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
  for (const dir of standIns) fs.rmSync(dir, { recursive: true, force: true });
});
afterEach(() => vi.unstubAllEnvs());

interface Picture {
  width: number;
  height: number;
  rgba: Buffer;
  png: Buffer;
}

async function pictureOf(rgba: Buffer, width: number, height: number): Promise<Picture> {
  return { width, height, rgba, png: await sharp(rgba, { raw: { width, height, channels: RGBA } }).png({ compressionLevel: 1 }).toBuffer() };
}

/** The photograph cut to a square of `size` pixels, `edit` applied to its RGBA pixels. */
async function photoOf(size: number, edit?: (rgba: Buffer, size: number) => void): Promise<Picture> {
  const rgba = Buffer.from(await sharp(PHOTO).resize(size, size, { fit: 'cover' }).ensureAlpha().raw().toBuffer());
  edit?.(rgba, size);
  return pictureOf(rgba, size, size);
}

/** An app-icon look: the corners outside a rounded square are transparent and its edge is one pixel and a half of partial alpha. */
function roundedSquare(rgba: Buffer, size: number): void {
  const radius = size * 0.18;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const cx = Math.min(Math.max(x, radius), size - 1 - radius);
      const cy = Math.min(Math.max(y, radius), size - 1 - radius);
      const coverage = Math.min(1, Math.max(0, (radius - Math.hypot(x - cx, y - cy)) / 1.5 + 0.5));
      rgba[(y * size + x) * RGBA + 3] = Math.round(255 * coverage);
    }
  }
}

/** The PNG inside the icon, as its directory says (one image, offset at byte 18). */
function pngOf(ico: Buffer): Buffer {
  expect(ico.readUInt16LE(2)).toBe(1);
  expect(ico.readUInt16LE(4)).toBe(1);
  const offset = ico.readUInt32LE(18);
  expect(offset).toBe(ICO_PNG_OFFSET);
  return ico.subarray(offset, offset + ico.readUInt32LE(14));
}

/** The picture of an ICO as ffmpeg decodes it: 8-bit RGBA. */
function decoded(ico: Buffer, picture: Picture): Buffer {
  const target = path.join(scratch, `decode-${process.hrtime.bigint()}.ico`);
  fs.writeFileSync(target, ico);
  const run = spawnSync(requireOracleTool('ffmpeg'), ['-v', 'error', '-nostdin', '-i', target, '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28 });
  expect(run.status, String(run.stderr)).toBe(0);
  expect(run.stdout.length).toBe(picture.width * picture.height * RGBA);
  return run.stdout;
}

/** Distinct colours of the picture inside the icon, by ImageMagick (the transparent colour counts as one). */
function coloursOf(ico: Buffer): number {
  return withTempImage(ico, 'ico', (file) => Number(runIdentify(['-format', '%k', `${file}[0]`]).trim()));
}

interface Score {
  psnr: number;
  ssim: number;
  deltaE2000: number;
}

/** PSNR and SSIM from ffmpeg against the source picture, and the mean CIEDE2000 of the decoded raster. */
function score(ico: Buffer, picture: Picture): Score {
  const sourceFile = path.join(scratch, 'source.png');
  fs.writeFileSync(sourceFile, picture.png);
  const resultFile = path.join(scratch, 'result.ico');
  fs.writeFileSync(resultFile, ico);
  const { ssim, psnr } = measureSsimPsnr(requireOracleTool('ffmpeg'), resultFile, sourceFile);
  return { psnr, ssim, deltaE2000: meanDeltaE2000(picture.rgba, decoded(ico, picture)) };
}

describe.skipIf(needsProgram)('a photograph converted to an 8-bit ICO with the program', () => {
  let photo: Picture;
  beforeAll(async () => {
    photo = await photoOf(SIZE);
  });

  it('holds an indexed PNG of at most 256 colours at the quality floors', async () => {
    const { buffer } = await convertFile(photo.png, 'png', 'ico', { colorDepth: 8 }, 'photo.png');
    const inside = pngOf(buffer);
    expect(inside[PNG_COLOUR_TYPE_OFFSET]).toBe(PNG_PALETTE);
    expect(coloursOf(buffer)).toBeLessThanOrEqual(256);
    const head = score(buffer, photo);
    expect(head.psnr).toBeGreaterThan(FLOORS.psnr);
    expect(head.ssim).toBeGreaterThan(FLOORS.ssim);
    expect(head.deltaE2000).toBeLessThan(FLOORS.deltaE2000);
  });

  it('beats the Oklab quantiser on PSNR, SSIM and CIEDE2000 with the default dithering, in a file at most 3 percent larger', async () => {
    const head = await convertFile(photo.png, 'png', 'ico', { colorDepth: 8 }, 'photo.png');
    const base = await convertFile(photo.png, 'png', 'ico', { colorDepth: 8, quantizer: 'oklab' }, 'photo.png');
    const headScore = score(head.buffer, photo);
    const baseScore = score(base.buffer, photo);
    expect(headScore.psnr).toBeGreaterThan(baseScore.psnr);
    expect(headScore.ssim).toBeGreaterThan(baseScore.ssim);
    expect(headScore.deltaE2000).toBeLessThan(baseScore.deltaE2000);
    expect(head.buffer.length).toBeLessThanOrEqual(base.buffer.length * 1.03);
  });

  it('holds only the colours that were asked for', async () => {
    const { buffer } = await convertFile(photo.png, 'png', 'ico', { colorDepth: 8, colors: 32 }, 'photo.png');
    expect(coloursOf(buffer)).toBeLessThanOrEqual(32);
    expect(score(buffer, photo).psnr).toBeGreaterThan(28);
  });

  it('keeps the transparent corners and the partial alpha of an edge: the palette carries alpha', async () => {
    const icon = await photoOf(SIZE, roundedSquare);
    const { buffer } = await convertFile(icon.png, 'png', 'ico', { colorDepth: 8 }, 'icon.png');
    const inside = pngOf(buffer);
    expect(inside[PNG_COLOUR_TYPE_OFFSET]).toBe(PNG_PALETTE);
    expect(inside.includes(Buffer.from('tRNS', 'latin1'))).toBe(true);
    const raster = decoded(buffer, icon);
    const alphaAt = (x: number, y: number): number => raster[(y * SIZE + x) * RGBA + 3];
    expect(alphaAt(0, 0)).toBe(0);
    expect(alphaAt(SIZE - 1, SIZE - 1)).toBe(0);
    expect(alphaAt(SIZE / 2, SIZE / 2)).toBe(255);
    // Along the straight edge the source has an alpha of 128 in the first column: the icon keeps a partial value there, neither 0 nor 255.
    expect(alphaAt(0, SIZE / 2)).toBeGreaterThan(64);
    expect(alphaAt(0, SIZE / 2)).toBeLessThan(192);
    let wrong = 0;
    for (let at = 3; at < raster.length; at += RGBA) if (Math.abs(raster[at] - icon.rgba[at]) > 64) wrong += 1;
    expect(wrong / (SIZE * SIZE)).toBeLessThan(0.002);
  });
});

/** A program that records its arguments and the bytes it is given, then answers with `body` (a Python script; `input` and `out` are bound). */
function standIn(body: string): { program: string; argsFile: string; inputFile: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ico-stand-in-'));
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

describe.skipIf(skipWithoutTools('ffmpeg', 'python3') || SKIP_WITHOUT_MAGICK)('what the converter gives the program and what it takes back', () => {
  /** 64 x 64 pixels, left half red and right half blue, the same colour in every row. */
  const halves = async (): Promise<Picture> => {
    const rgba = Buffer.alloc(64 * 64 * RGBA);
    for (let at = 0; at < rgba.length; at += RGBA) rgba.set((at / RGBA) % 64 < 32 ? [255, 0, 0, 255] : [0, 0, 255, 255], at);
    return pictureOf(rgba, 64, 64);
  };

  /** The palette: red, blue and a half transparent green no pixel uses; the indices: 0 on the left, 1 on the right. */
  const answer = `
width, height = struct.unpack_from('<II', input, 0)
indices = bytes(0 if (i % width) < width // 2 else 1 for i in range(width * height))
out.write(struct.pack('<I', 3) + bytes([10, 20, 30, 255, 200, 100, 50, 128, 0, 255, 0, 0]) + indices)
out.flush()`;

  it('hands over the RGBA pixels, the colour count and the dithering level of entry 253, and writes the palette, alpha and indices it answers', async () => {
    const picture = await halves();
    const { program, argsFile, inputFile } = standIn(answer);
    vi.stubEnv('QUANTIZR_PIXELS_PATH', program);
    const { buffer } = await convertFile(picture.png, 'png', 'ico', { colorDepth: 8, colors: 100, width: 64, height: 64 }, 'halves.png');
    expect(fs.readFileSync(argsFile, 'utf8')).toContain('--colors 100 --dither 0.25 ');
    const given = fs.readFileSync(inputFile);
    expect([given.readUInt32LE(0), given.readUInt32LE(4)]).toEqual([64, 64]);
    expect([...given.subarray(8, 8 + RGBA)]).toEqual([255, 0, 0, 255]);
    expect([...given.subarray(8 + 40 * RGBA, 8 + 41 * RGBA)]).toEqual([0, 0, 255, 255]);
    const raster = decoded(buffer, picture);
    expect([...raster.subarray(0, RGBA)]).toEqual([10, 20, 30, 255]);
    expect([...raster.subarray(40 * RGBA, 41 * RGBA)]).toEqual([200, 100, 50, 128]);
  });

  it('leaves an icon below 64 x 64 pixels, a request without dithering and the Oklab quantizer to the in-process quantizer: the program is not run', async () => {
    const { program, argsFile } = standIn('sys.exit(9)');
    vi.stubEnv('QUANTIZR_PIXELS_PATH', program);
    const photo = await photoOf(SIZE);
    const requests: Array<[string, Record<string, unknown>]> = [
      ['a 32 pixel icon', { colorDepth: 8, width: 32, height: 32 }],
      ['no dithering', { colorDepth: 8, dither: false }],
      ['the Oklab quantizer', { colorDepth: 8, quantizer: 'oklab' }],
      ['Riemersma dithering', { colorDepth: 8, ditherMethod: 'riemersma' }],
    ];
    for (const [label, options] of requests) {
      const { buffer } = await convertFile(photo.png, 'png', 'ico', options, 'photo.png');
      expect(fs.existsSync(argsFile), label).toBe(false);
      expect(buffer.readUInt16LE(2), label).toBe(1);
      expect(coloursOf(buffer), label).toBeLessThanOrEqual(256);
    }
    expect(ICO_PROGRAM_MIN_PIXELS).toBe(64 * 64);
  });

  it('runs the program for a 64 x 64 icon, the smallest it takes', async () => {
    const { program, argsFile } = standIn(answer);
    vi.stubEnv('QUANTIZR_PIXELS_PATH', program);
    const photo = await photoOf(SIZE);
    await convertFile(photo.png, 'png', 'ico', { colorDepth: 8, width: 64, height: 64 }, 'photo.png');
    expect(fs.existsSync(argsFile)).toBe(true);
  });

  it('writes the picture with the Oklab quantiser when the program fails, answers something that does not fit, or is not installed', async () => {
    const photo = await photoOf(SIZE);
    const bodies = ['sys.stderr.write("broken"); sys.exit(3)', 'out.write(b"\\x01\\x00\\x00\\x00")'];
    const programs = [...bodies.map((body) => standIn(body).program), '/nonexistent/quantizr-pixels'];
    for (const program of programs) {
      vi.stubEnv('QUANTIZR_PIXELS_PATH', program);
      const { buffer } = await convertFile(photo.png, 'png', 'ico', { colorDepth: 8 }, 'photo.png');
      expect(coloursOf(buffer)).toBeLessThanOrEqual(256);
      expect(score(buffer, photo).psnr).toBeGreaterThan(25);
    }
  });

  it('answers null for a picture below the line without running the program', async () => {
    const { program, argsFile } = standIn('sys.exit(9)');
    vi.stubEnv('QUANTIZR_PIXELS_PATH', program);
    expect(await quantizedIconPng(Buffer.alloc(63 * 63 * RGBA), 63, 63, { colours: 256 })).toBeNull();
    expect(fs.existsSync(argsFile)).toBe(false);
  });
});
