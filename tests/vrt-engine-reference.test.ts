import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { compareImages } from './helpers/vrt-engine';
import { requireOracleTool } from './helpers/differential-oracle';
import { MAGICK_BINARY } from './helpers/imagemagick';
import { magickPsnr } from './helpers/magick-compare';
import { oracleTest } from './helpers/oracle-test';
import { skipUnless } from './helpers/strict-skip';

/**
 * The visual-regression engine that the VRT gates use is itself checked against standard tools: PSNR against
 * ImageMagick `compare -metric PSNR`, SSIM and PSNR against ffmpeg's `ssim` and `psnr` filters. A metric the engine
 * computes wrongly would let every gate built on it pass or fail for the wrong reason.
 */

const IMAGE_SIZE = 96;
const GRAY_BACKGROUND = 64;
const GRAY_RECTANGLE = 224;
const OPAQUE = 255;
const PSNR_TOLERANCE_DB = 0.01;
/** ffmpeg rounds its block statistics to integers and averages 4 x 4 block pairs; the engine uses the same 8 x 8 windows in floating point. */
const SSIM_TOLERANCE = 0.005;
const TOOL_TIMEOUT_MS = 60_000;
const NOISE_AMPLITUDE = 24;
const PRNG_SEED = 0x2f6e2b1;
const PRNG_STATE_BITS = 32;

/** mulberry32: a small deterministic generator, so every run draws the same noise. */
function prng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** PRNG_STATE_BITS;
  };
}

/** A gray, opaque scene: a diagonal gradient with a bright rectangle at `shift` pixels from its home position. */
function scene(shift: number, brightness = 0, noise: (() => number) | null = null): Buffer {
  const pixels = Buffer.alloc(IMAGE_SIZE * IMAGE_SIZE * 4);
  for (let y = 0; y < IMAGE_SIZE; y++) {
    for (let x = 0; x < IMAGE_SIZE; x++) {
      const inRectangle = x >= 20 + shift && x < 60 + shift && y >= 24 && y < 56;
      let value = inRectangle ? GRAY_RECTANGLE : GRAY_BACKGROUND + Math.floor(((x + y) * 40) / (2 * IMAGE_SIZE));
      value += brightness;
      if (noise) value += Math.round((noise() - 0.5) * 2 * NOISE_AMPLITUDE);
      value = Math.max(0, Math.min(OPAQUE, value));
      const at = (y * IMAGE_SIZE + x) * 4;
      pixels[at] = value;
      pixels[at + 1] = value;
      pixels[at + 2] = value;
      pixels[at + 3] = OPAQUE;
    }
  }
  return pixels;
}

const toPng = (pixels: Buffer): Promise<Buffer> => sharp(pixels, { raw: { width: IMAGE_SIZE, height: IMAGE_SIZE, channels: 4 } }).png().toBuffer();

async function imagePairs(): Promise<Array<{ name: string; a: Buffer; b: Buffer }>> {
  const base = await toPng(scene(0));
  return [
    { name: 'a rectangle moved by 4 pixels', a: base, b: await toPng(scene(4)) },
    { name: 'a brightness offset of 12 levels', a: base, b: await toPng(scene(0, 12)) },
    { name: 'a blur', a: base, b: await sharp(base).blur(1.5).png().toBuffer() },
    { name: 'noise of +-24 levels', a: base, b: await toPng(scene(0, 0, prng(PRNG_SEED))) },
  ];
}

function withFiles<T>(a: Buffer, b: Buffer, run: (fileA: string, fileB: string) => T): T {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vrt-reference-'));
  try {
    const fileA = path.join(dir, 'a.png');
    const fileB = path.join(dir, 'b.png');
    writeFileSync(fileA, a);
    writeFileSync(fileB, b);
    return run(fileA, fileB);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * ffmpeg's own SSIM ("All") and PSNR ("average") of the two images. The images are handed over without their alpha
 * plane: ffmpeg averages every plane it is given, so an all-opaque plane would dilute the PSNR of the colour planes.
 */
async function ffmpegMeasure(a: Buffer, b: Buffer): Promise<{ ssim: number; psnr: number }> {
  const [rgbA, rgbB] = await Promise.all([sharp(a).removeAlpha().png().toBuffer(), sharp(b).removeAlpha().png().toBuffer()]);
  return withFiles(rgbA, rgbB, (fileA, fileB) => {
    const run = spawnSync(
      requireOracleTool('ffmpeg'),
      ['-hide_banner', '-nostdin', '-i', fileA, '-i', fileB, '-filter_complex', '[0:v][1:v]ssim;[0:v][1:v]psnr', '-f', 'null', '-'],
      { encoding: 'utf-8', timeout: TOOL_TIMEOUT_MS }
    );
    const report = run.stderr;
    const ssim = report.match(/SSIM .*All:([0-9.]+)/);
    const psnr = report.match(/PSNR .*average:([0-9.]+)/);
    if (run.status !== 0 || !ssim || !psnr) throw new Error(`ffmpeg ssim/psnr failed (${run.status}): ${report.slice(-400)}`);
    return { ssim: Number.parseFloat(ssim[1]), psnr: Number.parseFloat(psnr[1]) };
  });
}

describe('VRT engine metrics against standard tools', () => {
  it.skipIf(skipUnless('ImageMagick', MAGICK_BINARY !== null))('reports the PSNR that ImageMagick compare reports', async () => {
    for (const { name, a, b } of await imagePairs()) {
      const engine = await compareImages(a, b, { includeDiffImage: false });
      const reference = withFiles(a, b, magickPsnr);
      expect(Math.abs(engine.psnr - reference), `${name}: engine ${engine.psnr} dB, compare ${reference} dB`).toBeLessThan(PSNR_TOLERANCE_DB);
    }
  });

  oracleTest('reports the PSNR and the SSIM that ffmpeg reports', ['ffmpeg'], async () => {
    for (const { name, a, b } of await imagePairs()) {
      const engine = await compareImages(a, b, { includeDiffImage: false });
      const reference = await ffmpegMeasure(a, b);
      expect(Math.abs(engine.psnr - reference.psnr), `${name} PSNR: engine ${engine.psnr} dB, ffmpeg ${reference.psnr} dB`).toBeLessThan(PSNR_TOLERANCE_DB);
      expect(Math.abs(engine.ssim - reference.ssim), `${name} SSIM: engine ${engine.ssim}, ffmpeg ${reference.ssim}`).toBeLessThan(SSIM_TOLERANCE);
    }
  });

  it('scores a blur far below the global-statistics value: SSIM sees local structure, not just the mean and variance', async () => {
    const [blur] = (await imagePairs()).filter((pair) => pair.name === 'a blur');
    const engine = await compareImages(blur.a, blur.b, { includeDiffImage: false });
    // A blur keeps the global mean and nearly the global variance, so a global index stays near 1; windows do not.
    expect(engine.ssim).toBeLessThan(0.95);
    expect(engine.ssim).toBeGreaterThan(0.5);
  });

  it('averages the alpha channel into PSNR only when an image has transparency (hand-computed)', async () => {
    const constant = (alpha: number): Promise<Buffer> => {
      const pixels = Buffer.alloc(IMAGE_SIZE * IMAGE_SIZE * 4);
      for (let i = 0; i < IMAGE_SIZE * IMAGE_SIZE; i++) pixels.set([100, 100, 50, alpha], i * 4);
      return toPng(pixels);
    };
    const opaque = await constant(OPAQUE);
    const half = await constant(128);
    const brighter = await sharp(opaque).modulate({ brightness: 1 }).png().toBuffer();
    // Identical opaque images: infinite PSNR.
    expect((await compareImages(opaque, brighter, { includeDiffImage: false })).psnr).toBe(Infinity);
    // Alpha 255 against 128 differs by 127 in one of four channels: MSE = 127^2 / 4.
    const expected = 10 * Math.log10((OPAQUE * OPAQUE) / ((127 * 127) / 4));
    expect((await compareImages(opaque, half, { includeDiffImage: false })).psnr).toBeCloseTo(expected, 6);
  });
});
