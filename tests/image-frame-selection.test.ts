import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { convertImage } from '../src/lib/conversions/image';
import { buildBilevelTiff } from './helpers/tiff-builder';
import { bombGif } from './helpers/image-bombs';
import { InputPixelLimitError } from '../src/lib/conversions/image-input-limits';
import { captureError } from './helpers/capture-error';
import { readGifLoopCount } from './helpers/animation-containers';
import {
  countFrames,
  decodeRgba,
  frameDelaysMs,
  runConvert,
  runIdentify,
  sampleAt,
  withTempImage,
  SKIP_WITHOUT_MAGICK,
  type Rgb,
} from './helpers/imagemagick';

/**
 * Page and frame selection rules shared by every multi-frame source:
 *  - `page` and `pages` must agree when both are given, `{ page: null }` means absent;
 *  - `multiPageOutput: 'first'` wins over every keep-all default (gif, webp and tiff outputs);
 *  - a TIFF output with `pages` is ONE multi-page TIFF holding exactly those pages;
 *  - one page limit for every caller and an aggregate pixel budget bound the default all-pages case.
 *
 * Oracles: ImageMagick writes the colour fixtures and reads page counts, sizes and colours back; the
 * bilevel/mixed-size TIFFs come from the hand-written writer in tests/helpers/tiff-builder.ts.
 */

const WIDTH = 30;
const HEIGHT = 20;
const COLOURS: readonly Rgb[] = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
];
const COLOUR_TOLERANCE = 12;
/** 500 decoded and encoded pages take longer than the 5 s default on a loaded shard. */
const LIMIT_DOCUMENT_TIMEOUT_MS = 60_000;
const FIVE_HUNDRED_PAGES = 500;
const FIVE_HUNDRED_AND_ONE_PAGES = 501;
const FIFTY_ONE_PAGES = 51;
const TINY_PAGE = 8;
// Each page stays under the 100 Mpx input limit (81 Mpx); five of them exceed the 400 Mpx aggregate budget.
const HUGE_PAGE_SIDE = 9000;
const HUGE_PAGES = 5;

function rgb([r, g, b]: Rgb): string {
  return `rgb(${r},${g},${b})`;
}

function buildGif(): Buffer {
  const args = ['-size', `${WIDTH}x${HEIGHT}`];
  COLOURS.forEach((colour, index) => args.push('-delay', String(10 * (index + 1)), `xc:${rgb(colour)}`));
  return runConvert([...args, '-loop', '3', 'gif:-']);
}

function buildTiff(): Buffer {
  const args = ['-size', `${WIDTH}x${HEIGHT}`];
  COLOURS.forEach((colour) => args.push(`xc:${rgb(colour)}`));
  return runConvert([...args, 'tiff:-']);
}

function centre(encoded: Buffer, extension: string, page = 0): readonly number[] {
  const image = decodeRgba(encoded, extension, page);
  return sampleAt(image, image.width / 2, image.height / 2);
}

function expectColour(actual: readonly number[], expected: Rgb, label: string): void {
  expected.forEach((value, channel) => {
    expect(Math.abs(actual[channel] - value), `${label} channel ${channel}: got ${actual[channel]}, expected ${value}`).toBeLessThanOrEqual(
      COLOUR_TOLERANCE
    );
  });
}

function pageSizes(tiff: Buffer): string[] {
  return withTempImage(tiff, 'tif', (file) => runIdentify(['-format', '%wx%h\n', file]).trim().split('\n'));
}

describe('page and pages must agree', () => {
  it.skipIf(SKIP_WITHOUT_MAGICK).each([
    ['an animated gif to png', () => buildGif(), 'gif', 'png'],
    ['a multi-page tiff to png', () => buildTiff(), 'tiff', 'png'],
    ['a multi-page tiff to pdf', () => buildTiff(), 'tiff', 'pdf'],
    ['a multi-page tiff to tiff', () => buildTiff(), 'tiff', 'tiff'],
    ['an animated gif to gif', () => buildGif(), 'gif', 'gif'],
  ])('%s with page 2 and pages "3" is rejected', async (_label, build, source, target) => {
    const error = await captureError(() => convertImage(build(), target, { page: 2, pages: '3' }, 'in', source));
    expect(error.name).toBe('InvalidPageRangeError');
    expect(error.message).toMatch(/The "page" option \(2\) and the "pages" option \("3"\) select different pages/);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('page 2 with pages "2" (what the API sends) selects page 2', async () => {
    const result = await convertImage(buildTiff(), 'png', { page: 2, pages: '2' }, 'scan.tif', 'tiff');
    expect(result.frameUsed).toBe(2);
    expectColour(centre(result.buffer, 'png'), COLOURS[1], 'page 2');
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('page 2 with pages "1-3" is rejected as ambiguous', async () => {
    const error = await captureError(() => convertImage(buildTiff(), 'png', { page: 2, pages: '1-3' }, 'scan.tif', 'tiff'));
    expect(error.name).toBe('InvalidPageRangeError');
  });

  it.skipIf(SKIP_WITHOUT_MAGICK).each([
    ['null page', { page: null }],
    ['null pages', { pages: null }],
    ['an empty pages string', { pages: '' }],
  ])('%s counts as absent', async (_label, options) => {
    const result = await convertImage(buildGif(), 'gif', options as never, 'anim.gif', 'gif');
    expect(countFrames(result.buffer, 'gif')).toBe(COLOURS.length);
    expect(result.frameUsed).toBeUndefined();
  });
});

describe('multiPageOutput "first" wins over keep-everything defaults', () => {
  it.skipIf(SKIP_WITHOUT_MAGICK)('gif to gif gives a one-frame gif of frame 1', async () => {
    const result = await convertImage(buildGif(), 'gif', { multiPageOutput: 'first' }, 'anim.gif', 'gif');
    expect(countFrames(result.buffer, 'gif')).toBe(1);
    expect(result.frameUsed).toBe(1);
    expect(result.sourceFrameCount).toBe(COLOURS.length);
    expectColour(centre(result.buffer, 'gif'), COLOURS[0], 'gif frame 1');
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('webp to webp gives a one-frame webp of frame 1', async () => {
    const webp = runConvert(['gif:-', '-define', 'webp:lossless=true', 'webp:-'], buildGif());
    const result = await convertImage(webp, 'webp', { multiPageOutput: 'first' }, 'anim.webp', 'webp');
    expect(countFrames(result.buffer, 'webp')).toBe(1);
    expect(result.frameUsed).toBe(1);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('tiff to tiff gives a one-page tiff of page 1', async () => {
    const result = await convertImage(buildTiff(), 'tiff', { multiPageOutput: 'first' }, 'scan.tif', 'tiff');
    expect(pageSizes(result.buffer)).toHaveLength(1);
    expect(result.frameUsed).toBe(1);
    expectColour(centre(result.buffer, 'tif'), COLOURS[0], 'page 1');
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('tiff to png gives a plain png, honouring the first of the selected pages', async () => {
    const result = await convertImage(buildTiff(), 'png', { multiPageOutput: 'first', pages: '2-3' }, 'scan.tif', 'tiff');
    expect(result.mimeType).toBe('image/png');
    expect(result.frameUsed).toBe(2);
    expectColour(centre(result.buffer, 'png'), COLOURS[1], 'page 2');
  });
});

describe('a TIFF output with pages is one multi-page TIFF', () => {
  it.skipIf(SKIP_WITHOUT_MAGICK).each([
    ['a contiguous range', '2-3', [1, 2]],
    ['a non-contiguous list', '1,3', [0, 2]],
  ])('%s', async (_label, pages, colourIndexes) => {
    const result = await convertImage(buildTiff(), 'tiff', { pages }, 'scan.tif', 'tiff');
    expect(result.mimeType).toBe('image/tiff');
    expect(result.sourceFrameCount).toBe(COLOURS.length);
    expect(result.frameUsed).toBeUndefined();
    expect(pageSizes(result.buffer)).toEqual(colourIndexes.map(() => `${WIDTH}x${HEIGHT}`));
    colourIndexes.forEach((colourIndex, position) => {
      expectColour(centre(result.buffer, 'tif', position), COLOURS[colourIndex], `output page ${position + 1}`);
    });
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('keeps pages of different sizes', async () => {
    const mixed = runConvert(['-size', '30x20', 'xc:red', '(', '-size', '12x8', 'xc:lime', ')', 'tiff:-']);
    const result = await convertImage(mixed, 'tiff', {}, 'mixed.tif', 'tiff');
    expect(pageSizes(result.buffer)).toEqual(['30x20', '12x8']);
    expectColour(centre(result.buffer, 'tif', 0), [255, 0, 0], 'page 1');
    expectColour(centre(result.buffer, 'tif', 1), [0, 255, 0], 'page 2');
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('joins pages that were stored with LZW compression', async () => {
    const lzw = runConvert(['-size', '30x20', 'xc:red', 'xc:lime', '-compress', 'LZW', 'tiff:-']);
    const result = await convertImage(lzw, 'tiff', {}, 'lzw.tif', 'tiff');
    expect(pageSizes(result.buffer)).toHaveLength(2);
    expectColour(centre(result.buffer, 'tif', 1), [0, 255, 0], 'page 2');
  });
});

describe('page limits', () => {
  const pagesOf = (count: number) => buildBilevelTiff(Array.from({ length: count }, () => ({ width: TINY_PAGE, height: TINY_PAGE })));

  it.skipIf(SKIP_WITHOUT_MAGICK).each(['png', 'tiff', 'pdf'])('%s: more pages than the limit of every caller are refused by default', async (target) => {
    const error = await captureError(() => convertImage(pagesOf(FIVE_HUNDRED_AND_ONE_PAGES), target, {}, 'many.tif', 'tiff'));
    expect(error.name).toBe('InvalidPageRangeError');
    expect(error.message).toContain(`${FIVE_HUNDRED_AND_ONE_PAGES} pages`);
    expect(error.message).toContain(`limit of ${FIVE_HUNDRED_PAGES} pages`);
    expect(error.message).toContain('multiPageOutput');
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('multiPageOutput "first" takes the first page of a document past the limit', { timeout: LIMIT_DOCUMENT_TIMEOUT_MS }, async () => {
    const result = await convertImage(pagesOf(FIVE_HUNDRED_AND_ONE_PAGES), 'png', { multiPageOutput: 'first' }, 'many.tif', 'tiff');
    expect(result.mimeType).toBe('image/png');
    expect(result.sourceFrameCount).toBe(FIVE_HUNDRED_AND_ONE_PAGES);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('a selection within the limit of a longer document is accepted', async () => {
    const result = await convertImage(pagesOf(FIVE_HUNDRED_AND_ONE_PAGES), 'png', { pages: `1-${FIFTY_ONE_PAGES}` }, 'many.tif', 'tiff');
    const zip = await JSZip.loadAsync(result.buffer);
    expect(Object.keys(zip.files)).toHaveLength(FIFTY_ONE_PAGES);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('a document of exactly the limit converts every page', { timeout: LIMIT_DOCUMENT_TIMEOUT_MS }, async () => {
    const result = await convertImage(pagesOf(FIVE_HUNDRED_PAGES), 'png', {}, 'many.tif', 'tiff');
    const zip = await JSZip.loadAsync(result.buffer);
    expect(Object.keys(zip.files)).toHaveLength(FIVE_HUNDRED_PAGES);
    expect(result.sourceFrameCount).toBe(FIVE_HUNDRED_PAGES);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('refuses pages whose pixels exceed the aggregate budget before decoding any', async () => {
    const huge = buildBilevelTiff(Array.from({ length: HUGE_PAGES }, () => ({ width: HUGE_PAGE_SIDE, height: HUGE_PAGE_SIDE })));
    for (const target of ['png', 'tiff']) {
      const error = await captureError(() => convertImage(huge, target, {}, 'huge.tif', 'tiff'));
      expect(error.name).toBe('ConversionFailedError');
      expect(error.message).toContain(`The ${HUGE_PAGES} selected pages hold ${HUGE_PAGES * HUGE_PAGE_SIDE * HUGE_PAGE_SIDE} pixels in total`);
    }
  });
});

describe('the input pixel limit holds on the multi-frame path', () => {
  // 20000 x 20000 = 400 Mpx declared in the GIF header, four times the 100 Mpx default input limit.
  const OVERSIZED_SIDE = 20000;

  it.each(['gif', 'webp'])('refuses an oversized GIF before decoding any frame for an animated %s target', async (target) => {
    const error = await captureError(() => convertImage(bombGif(OVERSIZED_SIDE, OVERSIZED_SIDE), target, {}, 'big.gif', 'gif'));
    expect(error).toBeInstanceOf(InputPixelLimitError);
    expect((error as InputPixelLimitError).status).toBe(413);
    expect(error.message).toContain(`${OVERSIZED_SIDE}x${OVERSIZED_SIDE} pixels`);
  });
});

describe('animated outputs keep their timing', () => {
  it.skipIf(SKIP_WITHOUT_MAGICK)('a gif keeps delays and loop when no selection is made', async () => {
    const result = await convertImage(buildGif(), 'gif', {}, 'anim.gif', 'gif');
    expect(frameDelaysMs(result.buffer, 'gif')).toEqual([100, 200, 300]);
    expect(readGifLoopCount(result.buffer)).toBe(2);
  });
});
