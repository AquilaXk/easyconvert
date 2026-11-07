import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { requireOracleTool } from './helpers/differential-oracle';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * `pix-google-pixel6pro.dng` to PDF killed the job server of the real-world run for memory (issue #783: SIGKILL beside two other
 * jobs). The file is 4080 x 3072 pixels (12.5 megapixels); its developed picture is noisy, so the PNG that goes on the page is 21 MB, and
 * PDFKit's PNG reader turned each byte of it into an array element: 570 MB of heap on top of the pixels, 965 MB resident in all, where the
 * JPEG of the same picture needed 460 MB. The page now carries the PNG data stream as it is (tests/image-pdf-plain-png-embed.test.ts holds
 * the heap bound). Here the real file is converted and the PDF is judged by Poppler: the page size, the picture's size and depth, and its
 * pixels against the PNG the same file develops to, with the JPEG it develops to as the quality bar.
 */

vi.setConfig({ testTimeout: 180_000 });

const SAMPLE = 'pix-google-pixel6pro.dng';
const WIDTH = 4080;
const HEIGHT = 3072;
/** The PDF picture goes through the 8-bit sRGB transform and the PNG stays at 16 bits to the end, so they differ by that step (41.6 dB measured). */
const MIN_PSNR_DB = 40;
const EIGHT_BIT_PEAK = 255;

const noTools = skipWithoutTools('dcraw_emu', 'pdfimages', 'pdfinfo');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-dng-pdf-'));
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

function psnr(a: Buffer, b: Buffer): number {
  expect(a.length).toBe(b.length);
  let squares = 0;
  for (let at = 0; at < a.length; at += 1) squares += (a[at] - b[at]) ** 2;
  return 10 * Math.log10((EIGHT_BIT_PEAK * EIGHT_BIT_PEAK) / Math.max(squares / a.length, Number.EPSILON));
}

describe('a developed 12.5 megapixel DNG as a PDF page', () => {
  it.skipIf(noTools)('is one page of the picture at its pixel size, 8-bit RGB, with the pixels of the PNG', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, SAMPLE);
    const pdf = await dispatchConversion(bytes, 'dng', 'pdf', {}, SAMPLE);
    expect(pdf.engineUsed).toBe('native-raw');
    const file = path.join(directory, 'sample.pdf');
    fs.writeFileSync(file, pdf.buffer);

    const info = execFileSync(requireOracleTool('pdfinfo'), [file], { encoding: 'utf8' });
    expect(info).toMatch(/^Pages:\s+1$/m);
    expect(info).toMatch(new RegExp(`^Page size:\\s+${WIDTH} x ${HEIGHT} pts$`, 'm'));
    const rows = execFileSync(requireOracleTool('pdfimages'), ['-list', file], { encoding: 'utf8' }).trim().split('\n').slice(2);
    expect(rows.map((row) => row.trim().split(/\s+/).slice(3, 8))).toEqual([[String(WIDTH), String(HEIGHT), 'rgb', '3', '8']]);

    execFileSync(requireOracleTool('pdfimages'), ['-png', file, path.join(directory, 'picture')]);
    const picture = await sharp(path.join(directory, 'picture-000.png')).raw().toBuffer({ resolveWithObject: true });
    expect({ width: picture.info.width, height: picture.info.height, channels: picture.info.channels }).toEqual({ width: WIDTH, height: HEIGHT, channels: 3 });

    const png = await dispatchConversion(bytes, 'dng', 'png', {}, SAMPLE);
    const expected = await sharp(png.buffer).toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
    expect({ width: expected.info.width, height: expected.info.height, channels: expected.info.channels }).toEqual({ width: WIDTH, height: HEIGHT, channels: 3 });
    const pictureDb = psnr(picture.data, expected.data);
    expect(pictureDb).toBeGreaterThan(MIN_PSNR_DB);
    // The JPEG the same file develops to is the reference for quality: the page is at least as close to the PNG as it is.
    const jpg = await dispatchConversion(bytes, 'dng', 'jpg', {}, SAMPLE);
    const jpgPixels = await sharp(jpg.buffer).raw().toBuffer();
    expect(pictureDb).toBeGreaterThanOrEqual(psnr(jpgPixels, expected.data));
  });
});
