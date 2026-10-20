import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect } from 'vitest';
import sharp from 'sharp';
import { convertImage } from '../src/lib/conversions/image';
import { requireOracleTool } from './helpers/differential-oracle';
import { differingSamples, renderPostscriptPages, rgbOfRgba } from './helpers/ghostscript-pages';
import { decodeRgba, runConvert, withTempImage } from './helpers/imagemagick';
import { oracleTest } from './helpers/oracle-test';
import { requireRealworldSample } from './helpers/realworld-sample';

/**
 * A multi-page TIFF converted to PostScript is one PostScript document of every page, each page drawn at the size of its
 * picture (pixels x 72 / dpi points, one pixel to the point when it states no resolution, as the PDF writer sizes its pages) and
 * written compactly. The corpus file is a three-page CCITT Group 4 scan of 3307 x 4677 pixels at 400 dpi (a word on each page).
 * The oracles are libtiff through ImageMagick, which decodes each page of the source, and Ghostscript, which draws the document
 * that comes back at the density of the scan: every page must come back sample for sample.
 */

const SAMPLE = 'pil-g4-multi.tiff';
const SAMPLE_PAGES = 3;
const SAMPLE_WIDTH = 3307;
const SAMPLE_HEIGHT = 4677;
/** The density the scan states, at which the interpreter draws one pixel of the scan to one pixel of its page. */
const SAMPLE_DPI = 400;
const SAMPLE_RENDER = [`-r${SAMPLE_DPI}`];
const CONVERSION_TIMEOUT_MS = 180_000;
const RGB_CHANNELS = 3;
/** The size of the PostScript ImageMagick writes for the same file (all three pages, hex samples): the output must not be larger. */
const MAGICK_DOCUMENT_BYTES = 11_772_589;
const WHITE = 255;

function inkedSamples(rgb: Buffer): number {
  return rgb.reduce((count, level) => (level === WHITE ? count : count + 1), 0);
}

describe('a multi-page TIFF converted to PostScript', () => {
  oracleTest(
    'is one document whose pages are the pages of the TIFF, each at its own size',
    ['gs'],
    async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, SAMPLE);
      const result = await convertImage(bytes, 'ps', {}, SAMPLE, 'tiff');
      expect(result.mimeType).toBe('application/postscript');
      expect(result.filename).toBe('pil-g4-multi.ps');
      expect(result.buffer.subarray(0, 14).toString('latin1')).toBe('%!PS-Adobe-3.0');
      expect(result.buffer.length).toBeLessThan(MAGICK_DOCUMENT_BYTES);

      const drawn = renderPostscriptPages(result.buffer, SAMPLE_RENDER);
      expect(drawn).toHaveLength(SAMPLE_PAGES);
      const inked: number[] = [];
      for (let page = 0; page < SAMPLE_PAGES; page += 1) {
        expect([drawn[page].width, drawn[page].height], `page ${page + 1} size`).toEqual([SAMPLE_WIDTH, SAMPLE_HEIGHT]);
        const expected = rgbOfRgba(decodeRgba(bytes, 'tiff', page).data);
        expect(differingSamples(drawn[page], expected), `page ${page + 1} samples that differ from libtiff's`).toBe(0);
        inked.push(inkedSamples(expected));
      }
      // The pages differ from each other (a word, "Page1", "Page2", "Page3"), so a page drawn twice or out of order would not pass above.
      expect(new Set(inked).size).toBe(SAMPLE_PAGES);
      expect(Math.min(...inked)).toBeGreaterThan(0);
    },
    CONVERSION_TIMEOUT_MS
  );

  oracleTest(
    'holds the pages a request selects, in order',
    ['gs'],
    async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, SAMPLE);
      const result = await convertImage(bytes, 'ps', { pages: '2-3' }, SAMPLE, 'tiff');
      const drawn = renderPostscriptPages(result.buffer, SAMPLE_RENDER);
      expect(drawn).toHaveLength(2);
      expect(differingSamples(drawn[0], rgbOfRgba(decodeRgba(bytes, 'tiff', 1).data)), 'first page is page 2').toBe(0);
      expect(differingSamples(drawn[1], rgbOfRgba(decodeRgba(bytes, 'tiff', 2).data)), 'second page is page 3').toBe(0);
    },
    CONVERSION_TIMEOUT_MS
  );
});

/**
 * The same document from scans that store their bits the other way: a 1-bit CCITT Group 4 TIFF is white-is-zero (PhotometricInterpretation 0)
 * or black-is-zero (1), and its bytes are read from the high bit (FillOrder 1) or from the low bit (2). The pictures are drawn in the test (a
 * black rectangle on white, one pixel to the point), so the expected page is the drawing, not a decoder's reading of the file; `tiffinfo`
 * confirms that each fixture stores what its name says before anything is converted. Ghostscript writes the white-is-zero files, as it
 * wrote the corpus scan; ImageMagick writes black-is-zero.
 */
const BILEVEL_WIDTH = 64;
const BILEVEL_HEIGHT = 48;
/** The rectangles, in pixels from the top left; both corners are inked. */
const BILEVEL_INK = [
  { left: 8, top: 6, right: 39, bottom: 21 },
  { left: 20, top: 30, right: 55, bottom: 41 },
] as const;
const BLACK = 0;
const BILEVEL_DPI = 72;

/** The page as RGB samples: white with the rectangle black. */
function bilevelPage(ink: (typeof BILEVEL_INK)[number]): Buffer {
  const rgb = Buffer.alloc(BILEVEL_WIDTH * BILEVEL_HEIGHT * RGB_CHANNELS, WHITE);
  for (let y = ink.top; y <= ink.bottom; y += 1) {
    rgb.fill(BLACK, (y * BILEVEL_WIDTH + ink.left) * RGB_CHANNELS, (y * BILEVEL_WIDTH + ink.right + 1) * RGB_CHANNELS);
  }
  return rgb;
}

/** The two rectangles as a PostScript program of two pages (the origin of PostScript is the bottom left). */
const bilevelProgram = (): string =>
  `%!PS\n${BILEVEL_INK.map(({ left, top, right, bottom }) => `${BLACK} setgray ${left} ${BILEVEL_HEIGHT - bottom - 1} ${right - left + 1} ${bottom - top + 1} rectfill showpage\n`).join('')}`;

/** A white-is-zero Group 4 scan of the two pages, written by the interpreter with the fill order asked for (`-dFillOrder`: 1 high bit first, 2 low bit first). */
function whiteIsZeroScan(fillOrder: 1 | 2): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bilevel-scan-'));
  try {
    fs.writeFileSync(path.join(dir, 'pages.ps'), bilevelProgram());
    const output = path.join(dir, 'scan.tif');
    execFileSync(requireOracleTool('gs'), ['-q', '-dBATCH', '-dNOPAUSE', '-dSAFER', '-sDEVICE=tiffg4', `-g${BILEVEL_WIDTH}x${BILEVEL_HEIGHT}`, `-r${BILEVEL_DPI}`, `-dFillOrder=${fillOrder}`, `-sOutputFile=${output}`, path.join(dir, 'pages.ps')], { stdio: 'pipe' });
    return fs.readFileSync(output);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A black-is-zero Group 4 scan of the two pages, written by ImageMagick with the fill order asked for. */
function blackIsZeroScan(fillOrder: 'msb' | 'lsb'): Buffer {
  const pages = BILEVEL_INK.flatMap(({ left, top, right, bottom }) => ['(', '-size', `${BILEVEL_WIDTH}x${BILEVEL_HEIGHT}`, 'xc:white', '-fill', 'black', '-draw', `rectangle ${left},${top} ${right},${bottom}`, ')']);
  return runConvert([...pages, '-units', 'PixelsPerInch', '-density', String(BILEVEL_DPI), '-type', 'bilevel', '-compress', 'Group4', '-define', 'tiff:photometric=minisblack', '-define', `tiff:fill-order=${fillOrder}`, '-adjoin', 'tiff:-']);
}

describe.each([
  ['white-is-zero, high bit first', () => whiteIsZeroScan(1), 'min-is-white', 'msb-to-lsb'],
  ['white-is-zero, low bit first', () => whiteIsZeroScan(2), 'min-is-white', 'lsb-to-msb'],
  ['black-is-zero, high bit first', () => blackIsZeroScan('msb'), 'min-is-black', 'msb-to-lsb'],
  ['black-is-zero, low bit first', () => blackIsZeroScan('lsb'), 'min-is-black', 'lsb-to-msb'],
] as const)('a two-page CCITT Group 4 scan that is %s', (_label, build, storedPhotometric, storedFillOrder) => {
  oracleTest(
    'is drawn as the two pages that were drawn, sample for sample',
    ['gs', 'tiffinfo'],
    async () => {
      const scan = build();
      const stored = withTempImage(scan, 'tif', (file) => execFileSync(requireOracleTool('tiffinfo'), [file], { encoding: 'utf-8' }));
      for (const line of ['Compression Scheme: CCITT Group 4', `Photometric Interpretation: ${storedPhotometric}`, `FillOrder: ${storedFillOrder}`]) {
        expect(stored.split(line), line).toHaveLength(BILEVEL_INK.length + 1);
      }

      const drawn = renderPostscriptPages((await convertImage(scan, 'ps', {}, 'scan.tif', 'tiff')).buffer);
      expect(drawn.map((page) => [page.width, page.height])).toEqual(BILEVEL_INK.map(() => [BILEVEL_WIDTH, BILEVEL_HEIGHT]));
      BILEVEL_INK.forEach((ink, page) => expect(differingSamples(drawn[page], bilevelPage(ink)), `page ${page + 1} samples that differ from the drawing`).toBe(0));
    },
    CONVERSION_TIMEOUT_MS
  );
});

/** A picture bigger than the default page of the interpreter (612 x 792 points): a ramp that changes in both directions. */
const RAMP_WIDTH = 700;
const RAMP_HEIGHT = 900;
const RAMP_X_STEP = 7;
const RAMP_Y_STEP = 13;
const LEVELS = 256;
const GREEN_OFFSET = 85;
const BLUE_OFFSET = 170;

/** The ramp as RGB samples, each pixel a different tint of its level (red the level, green and blue offsets of it), so a swapped channel shows. */
function rampRgb(): Buffer {
  const rgb = Buffer.alloc(RAMP_WIDTH * RAMP_HEIGHT * RGB_CHANNELS);
  for (let y = 0; y < RAMP_HEIGHT; y += 1) {
    for (let x = 0; x < RAMP_WIDTH; x += 1) {
      const level = (x * RAMP_X_STEP + y * RAMP_Y_STEP) % LEVELS;
      rgb.set([level, (level + GREEN_OFFSET) % LEVELS, (level + BLUE_OFFSET) % LEVELS], (y * RAMP_WIDTH + x) * RGB_CHANNELS);
    }
  }
  return rgb;
}

describe.each([
  ['ps', []],
  ['eps', ['-dEPSCrop']],
] as const)('a picture larger than the default page converted to %s', (target, drawArguments) => {
  oracleTest(
    'is drawn whole, sample for sample, on a page of its own size',
    ['gs'],
    async () => {
      const rgb = rampRgb();
      const png = await sharp(rgb, { raw: { width: RAMP_WIDTH, height: RAMP_HEIGHT, channels: RGB_CHANNELS } }).png().toBuffer();
      const result = await convertImage(png, target, {}, 'ramp.png', 'png');
      const drawn = renderPostscriptPages(result.buffer, drawArguments);
      expect(drawn).toHaveLength(1);
      expect([drawn[0].width, drawn[0].height]).toEqual([RAMP_WIDTH, RAMP_HEIGHT]);
      expect(differingSamples(drawn[0], rgb)).toBe(0);
    },
    CONVERSION_TIMEOUT_MS
  );
});
