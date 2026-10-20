import { describe, expect } from 'vitest';
import sharp from 'sharp';
import { convertImage } from '../src/lib/conversions/image';
import { differingSamples, renderPostscriptPages, rgbOfRgba } from './helpers/ghostscript-pages';
import { decodeRgba } from './helpers/imagemagick';
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
