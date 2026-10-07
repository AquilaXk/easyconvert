import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { convertImage } from '../src/lib/conversions/image';
import { selectFrames } from '../src/lib/conversions/image-frames';
import { MAX_AGGREGATE_PAGE_PIXELS, MAX_OUTPUT_DIMENSION } from '../src/lib/conversions/image-limits';
import { captureError } from './helpers/capture-error';
import { buildBilevelTiff } from './helpers/tiff-builder';
import { decodeRgba, SKIP_WITHOUT_MAGICK } from './helpers/imagemagick';

/**
 * The aggregate pixel budget of a multi-page conversion counts the pixels each page will be rendered at, so a
 * request that resizes many small pages to a large size is refused before the first page is rendered. A page
 * is charged for the larger of its source size and its resized size.
 *
 * Oracles: the TIFF files are written by the hand-written bilevel builder (tiny files that declare their page
 * sizes); the budget arithmetic below is spelled out from the documented 400 million pixel limit, and the
 * pages of the admitted ZIP are decoded with ImageMagick.
 */

const TINY_SIDE = 100;
const BOX_SIDE = 9999;
const BOX_PIXELS = BOX_SIDE * BOX_SIDE; // 99980001 pixels per resized page
const QUICK_MS = 3000;
const SMALL_BOX_SIDE = 64;
const SMALL_PAGES = 3;

const pagesOf = (count: number, side = TINY_SIDE) => buildBilevelTiff(Array.from({ length: count }, () => ({ width: side, height: side })));
const BOX = { width: BOX_SIDE, height: BOX_SIDE, fit: 'fill' } as const;

describe('aggregate budget of resized pages', () => {
  it('documents the arithmetic: 4 resized pages fit the budget, 5 do not', () => {
    expect(MAX_AGGREGATE_PAGE_PIXELS).toBe(400_000_000);
    expect(MAX_OUTPUT_DIMENSION).toBeGreaterThanOrEqual(BOX_SIDE);
    expect(4 * BOX_PIXELS).toBe(399_920_004);
    expect(5 * BOX_PIXELS).toBe(499_900_005);
  });

  it('refuses 6 small pages resized to 9999 x 9999 before rendering any of them', async () => {
    const started = Date.now();
    const error = await captureError(() => convertImage(pagesOf(6), 'png', BOX, 'pages.tif', 'tiff'));
    expect(error.name).toBe('ConversionFailedError');
    expect(error.message).toMatch(/^The 6 selected pages hold 599880006 pixels in total, over the limit of 400000000/);
    expect(Date.now() - started).toBeLessThan(QUICK_MS);
  });

  it('refuses 5 resized pages and admits 4 at the selection stage', async () => {
    const five = await captureError(() => selectFrames(pagesOf(5), 'png', {}, BOX));
    expect(five.name).toBe('ConversionFailedError');
    expect(five.message).toMatch(/^The 5 selected pages hold 499900005 pixels in total/);

    const four = await selectFrames(pagesOf(4), 'png', {}, BOX);
    expect(four.zipPages).toEqual([1, 2, 3, 4]);
    expect(four.sourceFrameCount).toBe(4);
  });

  it('names the page size when a single resized page is already over the output limit', async () => {
    const error = await captureError(() => selectFrames(pagesOf(3), 'png', {}, { width: 14000, height: 14000, fit: 'fill' }));
    expect(error.name).toBe('ConversionFailedError');
    expect(error.message).toMatch(/^The resized image would be 14000x14000 pixels \(196000000 pixels\), over the limit of 100000000 pixels$/);
  });

  it('charges a tiff target the same way', async () => {
    const error = await captureError(() => convertImage(pagesOf(6), 'tiff', BOX, 'pages.tif', 'tiff'));
    expect(error.name).toBe('ConversionFailedError');
    expect(error.message).toMatch(/^The 6 selected pages hold 599880006 pixels in total/);
  });

  it('counts only the selected pages', async () => {
    const selection = await selectFrames(pagesOf(6), 'png', { pages: '1-4' }, BOX);
    expect(selection.zipPages).toEqual([1, 2, 3, 4]);
  });

  it('still charges the source size when the request shrinks the pages', async () => {
    // 6 pages of 9999 x 9999 hold 599880006 pixels to decode, however small they are resized afterwards.
    const error = await captureError(() => selectFrames(pagesOf(6, BOX_SIDE), 'png', {}, { width: SMALL_BOX_SIDE, height: SMALL_BOX_SIDE }));
    expect(error.name).toBe('ConversionFailedError');
    expect(error.message).toMatch(/^The 6 selected pages hold 599880006 pixels in total/);
  });

  it('does not charge a resize that was not requested', async () => {
    const selection = await selectFrames(pagesOf(6), 'png', {}, null);
    expect(selection.zipPages).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('refuses an unsupported side before looking at the pages', async () => {
    const error = await captureError(() => convertImage(pagesOf(3), 'png', { width: 70000 }, 'pages.tif', 'tiff'));
    expect(error.name).toBe('UnsupportedOptionError');
    expect(error.message).toMatch(/Unsupported width 70000/);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('converts a resized multi-page document within the budget', async () => {
    const result = await convertImage(
      pagesOf(SMALL_PAGES),
      'png',
      { width: SMALL_BOX_SIDE, height: SMALL_BOX_SIDE, fit: 'fill' },
      'pages.tif',
      'tiff'
    );
    const zip = await JSZip.loadAsync(result.buffer);
    const names = Object.keys(zip.files).sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(['pages-p001.png', 'pages-p002.png', 'pages-p003.png']);
    for (const name of names) {
      const image = decodeRgba(await zip.files[name].async('nodebuffer'), 'png');
      expect([image.width, image.height]).toEqual([SMALL_BOX_SIDE, SMALL_BOX_SIDE]);
    }
  });
});
