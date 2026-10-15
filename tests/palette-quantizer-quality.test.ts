import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyOklabQuantizationAndDither } from '../src/lib/conversions/color-quantizer';
import { comparePictures } from './helpers/palette-metrics';
import { runConvert, runIdentify, SKIP_WITHOUT_MAGICK } from './helpers/imagemagick';
import { skipUnless } from './helpers/strict-skip';

/**
 * Perceptual palette quantizer against ImageMagick's own `-colors 256 -dither FloydSteinberg` on five pictures, and
 * its cost at 1.92 megapixels. PSNR and mean Delta E_OK are computed in the test from the published definitions
 * (tests/helpers/palette-metrics.ts); the memory figure is the kernel's VmHWM of a fresh process.
 */

const execFileAsync = promisify(execFile);
const COLOURS = 256;
const PSNR_MARGIN_DB = 1;
const DELTA_E_RATIO = 1.1;
const PERF_WIDTH = 1600;
const PERF_HEIGHT = 1200;
const PERF_MAX_SECONDS = 1.5;
const PERF_MAX_ADDED_MIB = 60;
const PERF_RUNS = 5;
const CHILD_TIMEOUT_MS = 170_000;
const MEASURE_SCRIPT = path.join(__dirname, 'helpers', 'measure-peak-quantize.mts');
const CORPUS = path.join(__dirname, '..', 'bench', 'corpus');
const HAS_PROC = process.platform === 'linux';

let workDir: string;
const pictures = new Map<string, { path: string; rgba: Buffer; width: number; height: number }>();

async function loadPicture(name: string, file: string): Promise<void> {
  const flat = path.join(workDir, `${name}.png`);
  await sharp(file).flatten({ background: '#ffffff' }).png().toFile(flat);
  const { data, info } = await sharp(flat).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  pictures.set(name, { path: flat, rgba: data, width: info.width, height: info.height });
}

beforeAll(async () => {
  workDir = mkdtempSync(path.join(os.tmpdir(), 'palette-quality-'));
  await loadPicture('photo-a', path.join(CORPUS, 'photo-a.jpg'));
  await loadPicture('photo-b', path.join(CORPUS, 'photo-b.png'));
  if (!SKIP_WITHOUT_MAGICK) {
    const plasma = path.join(workDir, 'plasma-source.png');
    runConvert(['-seed', '3', '-size', '900x600', 'plasma:fractal', plasma]);
    await loadPicture('plasma', plasma);
    const ramp = path.join(workDir, 'ramp-source.png');
    runConvert(['-size', '512x512', 'gradient:red-blue', '(', '-size', '512x512', 'gradient:white-black', '-rotate', '90', ')', '-compose', 'multiply', '-composite', ramp]);
    await loadPicture('red-blue ramp', ramp);
    const text = path.join(workDir, 'text-source.png');
    runConvert(['-size', '640x320', 'gradient:#204080-#e0a040', '-font', 'DejaVu-Sans', '-pointsize', '40', '-fill', 'white', '-annotate', '+30+120', 'Palette text', text]);
    await loadPicture('text on gradient', text);
  }
}, 120_000);

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe.skipIf(SKIP_WITHOUT_MAGICK)('256-colour quantization against ImageMagick Floyd-Steinberg', () => {
  it.each(['photo-a', 'photo-b', 'plasma', 'red-blue ramp', 'text on gradient'])(
    '%s: PSNR within 1 dB of the reference and Delta E_OK at most 1.1 times its',
    (name) => {
      const picture = pictures.get(name);
      if (!picture) throw new Error(`fixture ${name} was not built`);
      const ours = applyOklabQuantizationAndDither({ data: picture.rgba, width: picture.width, height: picture.height }, COLOURS, true);
      const oursScore = comparePictures(picture.rgba, ours.rgba);

      const referencePath = path.join(workDir, `${name.replace(/\W/g, '-')}-im.png`);
      runConvert([picture.path, '-dither', 'FloydSteinberg', '-colors', String(COLOURS), '-depth', '8', `PNG24:${referencePath}`]);
      const reference = readFileSync(referencePath);
      const referenceRaster = new Uint8Array(picture.rgba.length);
      referenceRaster.set(runConvert([referencePath, '-depth', '8', 'rgba:-']));
      const referenceScore = comparePictures(picture.rgba, referenceRaster);

      expect(reference.length).toBeGreaterThan(0);
      expect(ours.palette.length).toBeLessThanOrEqual(COLOURS);
      expect(oursScore.psnr).toBeGreaterThanOrEqual(referenceScore.psnr - PSNR_MARGIN_DB);
      expect(oursScore.deltaEOk).toBeLessThanOrEqual(referenceScore.deltaEOk * DELTA_E_RATIO);
    },
    60_000
  );
});

describe.skipIf(SKIP_WITHOUT_MAGICK || skipUnless('Linux /proc (VmHWM)', HAS_PROC))('cost at 1.92 megapixels and 256 colours', () => {
  it('takes at most 1.5 s and adds at most 60 MiB of resident memory', async () => {
    const rgbaFile = path.join(workDir, 'perf.rgba');
    // A textured picture with a smooth tonal range: the statistics of a photograph, 10 thousand histogram bins.
    runConvert(['-seed', '11', '-size', `${PERF_WIDTH}x${PERF_HEIGHT}`, 'plasma:fractal', '-blur', '0x2', '-attenuate', '0.3', '+noise', 'Gaussian', '-alpha', 'on', '-depth', '8', `rgba:${rgbaFile}`]);
    expect(readFileSync(rgbaFile).length).toBe(PERF_WIDTH * PERF_HEIGHT * 4);
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', MEASURE_SCRIPT, rgbaFile, String(PERF_WIDTH), String(PERF_HEIGHT), String(COLOURS), String(PERF_RUNS)],
      { cwd: path.join(__dirname, '..'), timeout: CHILD_TIMEOUT_MS, maxBuffer: 1024 * 1024 }
    );
    const measured = JSON.parse(stdout.trim().split('\n').pop() as string) as { bestMs: number; addedMiB: number };
    expect(measured.bestMs / 1000).toBeLessThanOrEqual(PERF_MAX_SECONDS);
    expect(measured.addedMiB).toBeLessThanOrEqual(PERF_MAX_ADDED_MIB);
  }, 180_000);
});

describe.skipIf(SKIP_WITHOUT_MAGICK)('the palette is not touched again by the GIF writer', () => {
  /** The colour table of a GIF as ImageMagick lists it (`identify -verbose`, "Colormap" section). */
  function colormapOf(gif: Buffer): string[] {
    const file = path.join(workDir, 'table.gif');
    writeFileSync(file, gif);
    const text = runIdentify(['-verbose', file]);
    const section = /Colormap(?: entries: \d+)?:\n([\s\S]*?)\n\s*(?:Rendering intent|Gamma|Interlace|Orientation)/.exec(text)?.[1] ?? '';
    return [...section.matchAll(/\d+:\s*\(\s*(\d+),\s*(\d+),\s*(\d+)/g)].map((m) => `${m[1]},${m[2]},${m[3]}`);
  }

  it('GIF colour table equals the quantizer palette, entry by entry', async () => {
    const picture = pictures.get('plasma');
    if (!picture) throw new Error('fixture plasma was not built');
    const source = await sharp(picture.path).png().toBuffer();
    const { convertImage } = await import('../src/lib/conversions/image');
    const gif = (await convertImage(source, 'gif', { quantizer: 'oklab', colors: 64 }, 'plasma.png', 'png')).buffer;
    const quantized = applyOklabQuantizationAndDither({ data: picture.rgba, width: picture.width, height: picture.height }, 64, true);
    const table = colormapOf(gif);
    const expected = quantized.palette.map((c) => `${c.r},${c.g},${c.b}`);
    expect(table.slice(0, expected.length)).toEqual(expected);
  }, 60_000);

  it('keeps transparent pixels transparent and gives every other pixel a colour of the table', async () => {
    const side = 40;
    const rgba = Buffer.alloc(side * side * 4);
    for (let y = 0; y < side; y += 1) {
      for (let x = 0; x < side; x += 1) rgba.set([x * 6, y * 6, 128, x < 10 ? 0 : 255], (y * side + x) * 4);
    }
    const source = await sharp(rgba, { raw: { width: side, height: side, channels: 4 } }).png().toBuffer();
    const { convertImage } = await import('../src/lib/conversions/image');
    const gif = (await convertImage(source, 'gif', { quantizer: 'oklab', colors: 16 }, 'alpha.png', 'png')).buffer;
    const file = path.join(workDir, 'alpha.gif');
    writeFileSync(file, gif);
    const decoded = runConvert([file, '-depth', '8', 'rgba:-']);
    const table = new Set(colormapOf(gif));
    for (let p = 0; p < side * side; p += 1) {
      const transparent = p % side < 10;
      expect(decoded[p * 4 + 3]).toBe(transparent ? 0 : 255);
      if (!transparent) expect(table.has(`${decoded[p * 4]},${decoded[p * 4 + 1]},${decoded[p * 4 + 2]}`)).toBe(true);
    }
    expect(table.size).toBeLessThanOrEqual(16);
  }, 60_000);
});

