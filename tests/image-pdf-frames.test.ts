import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertImage } from '../src/lib/conversions/image';
import { decodeRgba, runConvert, sampleAt, SKIP_WITHOUT_MAGICK, type Rgb } from './helpers/imagemagick';
import { captureError } from './helpers/capture-error';
import { injectExifOrientation } from './helpers/exif-orientation';
import { getOracleToolPath } from './helpers/differential-oracle';

/**
 * Image to PDF applies the EXIF orientation and the same frame rules as the other targets: an animated
 * source gives frame 1 (or `page`), a multi-page TIFF gives one PDF page per TIFF page.
 *
 * Oracles: poppler's `pdfinfo` reads page count and page size, `pdftoppm` renders pages that ImageMagick
 * decodes; fixtures come from ImageMagick and the hand-built EXIF block.
 */

const WIDTH = 30;
const HEIGHT = 20;
const POINTS_PER_PIXEL = 1;
const RENDER_DPI = '72';
const COLOUR_TOLERANCE = 16;
const FRAME_COLOURS: readonly Rgb[] = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
];
const STRICT = process.env.ORACLE_STRICT_MODE === '1';
const PDFINFO = getOracleToolPath('pdfinfo');
const PDFTOPPM = getOracleToolPath('pdftoppm');
const SKIP_PDF = (!PDFINFO || !PDFTOPPM) && !STRICT;

function requirePoppler(): { pdfinfo: string; pdftoppm: string } {
  if (!PDFINFO || !PDFTOPPM) throw new Error('poppler (pdfinfo, pdftoppm) is required by this oracle test (ORACLE_STRICT_MODE=1)');
  return { pdfinfo: PDFINFO, pdftoppm: PDFTOPPM };
}

function rgb([r, g, b]: Rgb): string {
  return `rgb(${r},${g},${b})`;
}

function withPdf<T>(pdf: Buffer, run: (file: string, dir: string) => T): T {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pdf-oracle-'));
  try {
    const file = path.join(dir, 'out.pdf');
    writeFileSync(file, pdf);
    return run(file, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface PdfInfo {
  pages: number;
  pageSize: string;
}

function pdfInfo(pdf: Buffer): PdfInfo {
  const { pdfinfo } = requirePoppler();
  return withPdf(pdf, (file) => {
    const text = execFileSync(pdfinfo, [file], { encoding: 'utf8' });
    return {
      pages: Number(/^Pages:\s+(\d+)/m.exec(text)?.[1]),
      pageSize: /^Page size:\s+(.+)$/m.exec(text)?.[1] ?? '',
    };
  });
}

function renderPage(pdf: Buffer, page: number) {
  const { pdftoppm } = requirePoppler();
  return withPdf(pdf, (file, dir) => {
    execFileSync(pdftoppm, ['-r', RENDER_DPI, '-f', String(page), '-l', String(page), '-png', '-singlefile', file, path.join(dir, 'page')]);
    return decodeRgba(readFileSync(path.join(dir, 'page.png')), 'png');
  });
}

function expectNear(actual: readonly number[], expected: Rgb, label: string): void {
  expected.forEach((value, channel) => {
    expect(Math.abs(actual[channel] - value), `${label} channel ${channel}: got ${actual[channel]}, expected ${value}`)
      .toBeLessThanOrEqual(COLOUR_TOLERANCE);
  });
}

function buildAnimatedGif(): Buffer {
  const args = ['-size', `${WIDTH}x${HEIGHT}`];
  FRAME_COLOURS.forEach((colour) => args.push('-delay', '10', `xc:${rgb(colour)}`));
  return runConvert([...args, 'gif:-']);
}

function buildMultiPageTiff(): Buffer {
  const args = ['-size', `${WIDTH}x${HEIGHT}`];
  FRAME_COLOURS.forEach((colour) => args.push(`xc:${rgb(colour)}`));
  return runConvert([...args, 'tiff:-']);
}

describe('convertImage to pdf', () => {
  it.skipIf(SKIP_PDF || SKIP_WITHOUT_MAGICK)('applies the EXIF orientation: the page is the upright size with the marker in place', async () => {
    const stored = runConvert([
      '-size',
      `${WIDTH}x${HEIGHT}`,
      'xc:white',
      '-fill',
      'rgb(255,0,0)',
      '-draw',
      'rectangle 0,0 7,5',
      '-quality',
      '100',
      '-sampling-factor',
      '1x1',
      'jpg:-',
    ]);
    const result = await convertImage(injectExifOrientation(stored, 6), 'pdf', {}, 'photo.jpg', 'jpg');
    expect(result.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const info = pdfInfo(result.buffer);
    expect(info.pages).toBe(1);
    expect(info.pageSize).toBe(`${HEIGHT * POINTS_PER_PIXEL} x ${WIDTH * POINTS_PER_PIXEL} pts`);
    const page = renderPage(result.buffer, 1);
    // Orientation 6 turns the stored top-left marker to the top-right of the upright 20x30 page.
    expectNear(sampleAt(page, page.width - 3, 2), [255, 0, 0], 'marker');
    expectNear(sampleAt(page, 2, 2), [255, 255, 255], 'former marker corner');
  });

  it.skipIf(SKIP_PDF || SKIP_WITHOUT_MAGICK)('an animated gif gives a one-page PDF of frame 1 and reports the frames', async () => {
    const result = await convertImage(buildAnimatedGif(), 'pdf', {}, 'anim.gif', 'gif');
    expect(pdfInfo(result.buffer).pages).toBe(1);
    expectNear(sampleAt(renderPage(result.buffer, 1), WIDTH / 2, HEIGHT / 2), FRAME_COLOURS[0], 'frame 1');
    expect(result.sourceFrameCount).toBe(FRAME_COLOURS.length);
    expect(result.frameUsed).toBe(1);
  });

  it.skipIf(SKIP_PDF || SKIP_WITHOUT_MAGICK)('page selects the frame of an animated gif', async () => {
    const result = await convertImage(buildAnimatedGif(), 'pdf', { page: 3 }, 'anim.gif', 'gif');
    expectNear(sampleAt(renderPage(result.buffer, 1), WIDTH / 2, HEIGHT / 2), FRAME_COLOURS[2], 'frame 3');
    expect(result.frameUsed).toBe(3);
  });

  it.skipIf(SKIP_PDF || SKIP_WITHOUT_MAGICK)('a multi-page TIFF gives one PDF page per TIFF page', async () => {
    const result = await convertImage(buildMultiPageTiff(), 'pdf', {}, 'scan.tif', 'tiff');
    expect(pdfInfo(result.buffer).pages).toBe(FRAME_COLOURS.length);
    FRAME_COLOURS.forEach((colour, index) => {
      expectNear(sampleAt(renderPage(result.buffer, index + 1), WIDTH / 2, HEIGHT / 2), colour, `pdf page ${index + 1}`);
    });
    expect(result.sourceFrameCount).toBe(FRAME_COLOURS.length);
    expect(result.frameUsed).toBeUndefined();
  });

  it.skipIf(SKIP_PDF || SKIP_WITHOUT_MAGICK)('pages selects a subset of a multi-page TIFF', async () => {
    const result = await convertImage(buildMultiPageTiff(), 'pdf', { pages: '2-3' }, 'scan.tif', 'tiff');
    expect(pdfInfo(result.buffer).pages).toBe(2);
    expectNear(sampleAt(renderPage(result.buffer, 1), WIDTH / 2, HEIGHT / 2), FRAME_COLOURS[1], 'first selected page');
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('rejects a page outside the image', async () => {
    const error = await captureError(() => convertImage(buildMultiPageTiff(), 'pdf', { page: 9 }, 'scan.tif', 'tiff'));
    expect(error.name).toBe('InvalidPageRangeError');
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('refuses OCR over several pages at once', async () => {
    const error = await captureError(() =>
      convertImage(buildMultiPageTiff(), 'pdf', { ocrEnabled: true }, 'scan.tif', 'tiff')
    );
    expect(error.name).toBe('ConversionFailedError');
    expect(error.message).toMatch(/OCR reads one page at a time/);
  });
});
