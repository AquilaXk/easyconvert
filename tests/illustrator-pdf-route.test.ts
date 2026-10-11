import { describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { decodeRgba } from './helpers/imagemagick';
import { oracleTest } from './helpers/oracle-test';
import { singlePagePdf } from './helpers/pdf-craft';

/**
 * An Illustrator file is a PDF with private data, so it takes the PDF path: Poppler draws its pages, and the encoders write
 * them. The sample is a PDF page that fills the left half with red, written byte by byte (tests/helpers/pdf-craft.ts).
 */

const PAGE_WIDTH_PT = 612;
const PAGE_HEIGHT_PT = 792;
const POPPLER_DPI = 150;
const POINTS_PER_INCH = 72;
const RED_MIN = 200;
const OTHER_MAX = 60;

const redLeftHalf = (): Buffer => singlePagePdf(Buffer.from(`1 0 0 rg 0 0 ${PAGE_WIDTH_PT / 2} ${PAGE_HEIGHT_PT} re f\n`, 'latin1'), [], { contentFilter: false }).buffer;

describe('an Illustrator file', () => {
  oracleTest('converts to PNG at the size Poppler draws its page, with the red half where the content stream put it', ['pdftoppm', 'identify'], async () => {
    const result = await dispatchConversion(redLeftHalf(), 'ai', 'png', {}, 'art.ai');
    expect(result.engineUsed).toBe('native-poppler');
    const picture = decodeRgba(result.buffer, 'png');
    expect(picture.width).toBe(Math.round((PAGE_WIDTH_PT * POPPLER_DPI) / POINTS_PER_INCH));
    expect(picture.height).toBe(Math.round((PAGE_HEIGHT_PT * POPPLER_DPI) / POINTS_PER_INCH));
    const at = (x: number, y: number): number[] => [...picture.data.subarray((y * picture.width + x) * 4, (y * picture.width + x) * 4 + 3)];
    const [r, g, b] = at(Math.floor(picture.width / 4), Math.floor(picture.height / 2));
    expect(r).toBeGreaterThan(RED_MIN);
    expect(Math.max(g, b)).toBeLessThan(OTHER_MAX);
    expect(at(Math.floor((picture.width * 3) / 4), Math.floor(picture.height / 2))).toEqual([255, 255, 255]);
  });

  it('keeps packaging as the original file: a ZIP of the .ai, not of rendered pages', async () => {
    const result = await dispatchConversion(redLeftHalf(), 'ai', 'zip', {}, 'art.ai');
    expect(result.buffer.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(result.buffer.includes(Buffer.from('art.ai'))).toBe(true);
  });
});
