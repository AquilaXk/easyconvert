import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { convertImage } from '../src/lib/conversions/image';
import {
  countFrames,
  decodeRgba,
  runConvert,
  runIdentify,
  sampleAt,
  withTempImage,
  SKIP_WITHOUT_MAGICK,
  type Rgb,
} from './helpers/imagemagick';
import { captureError } from './helpers/capture-error';

/**
 * Multi-page TIFF sources: a still target gets one image per page in a ZIP named like PDF page renders
 * (`<name>-p001.<ext>`), `page`/`pages` select pages, and a TIFF target keeps every page.
 *
 * Oracles: ImageMagick writes the three-page fixture and reads the page count (`identify`) and page colours
 * back; the ZIP is opened with JSZip. Multi-image HEIF files take the same code path (libvips reports their
 * images as pages) but cannot be authored with the installed tools, so they are not covered here.
 */

const WIDTH = 30;
const HEIGHT = 20;
const PAGE_COLOURS: readonly Rgb[] = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
];
const COLOUR_TOLERANCE = 12;

function rgb([r, g, b]: Rgb): string {
  return `rgb(${r},${g},${b})`;
}

function buildMultiPageTiff(): Buffer {
  const args = ['-size', `${WIDTH}x${HEIGHT}`];
  PAGE_COLOURS.forEach((colour) => args.push(`xc:${rgb(colour)}`));
  return runConvert([...args, 'tiff:-']);
}

/** The same three pages, each tagged with TIFF orientation 6 (right-top). */
function buildOrientedMultiPageTiff(): Buffer {
  const args = ['-size', `${WIDTH}x${HEIGHT}`];
  PAGE_COLOURS.forEach((colour) => args.push(`xc:${rgb(colour)}`));
  return runConvert([...args, '-orient', 'right-top', 'tiff:-']);
}

function expectCentreColour(encoded: Buffer, extension: string, expected: Rgb, label: string, page = 0): void {
  const image = decodeRgba(encoded, extension, page);
  const actual = sampleAt(image, image.width / 2, image.height / 2);
  expected.forEach((value, channel) => {
    expect(Math.abs(actual[channel] - value), `${label} channel ${channel}: got ${actual[channel]}, expected ${value}`)
      .toBeLessThanOrEqual(COLOUR_TOLERANCE);
  });
}

async function unzip(buffer: Buffer): Promise<{ names: string[]; zip: JSZip }> {
  const zip = await JSZip.loadAsync(buffer);
  return { names: Object.keys(zip.files).sort(), zip };
}

describe('multi-page TIFF fixture', () => {
  it.skipIf(SKIP_WITHOUT_MAGICK)('really has three pages', () => {
    expect(countFrames(buildMultiPageTiff(), 'tif')).toBe(PAGE_COLOURS.length);
  });
});

describe('multi-page TIFF to a still target', () => {
  it.skipIf(SKIP_WITHOUT_MAGICK).each(['png', 'jpg'])('%s: defaults to one numbered image per page in a ZIP', async (target) => {
    const result = await convertImage(buildMultiPageTiff(), target, {}, 'scan.tif', 'tiff');
    expect(result.mimeType).toBe('application/zip');
    expect(result.filename).toBe('scan.zip');
    expect(result.sourceFrameCount).toBe(PAGE_COLOURS.length);
    expect(result.frameUsed).toBeUndefined();
    expect(result.size).toBe(result.buffer.length);
    const { names, zip } = await unzip(result.buffer);
    expect(names).toEqual([`scan-p001.${target}`, `scan-p002.${target}`, `scan-p003.${target}`]);
    for (let index = 0; index < PAGE_COLOURS.length; index += 1) {
      const page = await zip.file(names[index])!.async('nodebuffer');
      expectCentreColour(page, target, PAGE_COLOURS[index], `${target} page ${index + 1}`);
    }
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('page selects one page and returns a plain image', async () => {
    const result = await convertImage(buildMultiPageTiff(), 'png', { page: 2 }, 'scan.tif', 'tiff');
    expect(result.mimeType).toBe('image/png');
    expect(result.filename).toBe('scan.png');
    expect(result.sourceFrameCount).toBe(PAGE_COLOURS.length);
    expect(result.frameUsed).toBe(2);
    expect(countFrames(result.buffer, 'png')).toBe(1);
    expectCentreColour(result.buffer, 'png', PAGE_COLOURS[1], 'page 2');
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('pages selects a subset, named by the page numbers', async () => {
    const result = await convertImage(buildMultiPageTiff(), 'png', { pages: '1,3' }, 'scan.tif', 'tiff');
    const { names, zip } = await unzip(result.buffer);
    expect(names).toEqual(['scan-p001.png', 'scan-p003.png']);
    expectCentreColour(await zip.file('scan-p003.png')!.async('nodebuffer'), 'png', PAGE_COLOURS[2], 'page 3');
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('multiPageOutput "first" returns only the first page, as the PDF renderer does', async () => {
    const result = await convertImage(buildMultiPageTiff(), 'png', { multiPageOutput: 'first' }, 'scan.tif', 'tiff');
    expect(result.mimeType).toBe('image/png');
    expect(result.frameUsed).toBe(1);
    expectCentreColour(result.buffer, 'png', PAGE_COLOURS[0], 'first page');
  });

  it.skipIf(SKIP_WITHOUT_MAGICK).each([0, 4, 1.5])('page %s is outside 1..3 and is rejected', async (page) => {
    const error = await captureError(() => convertImage(buildMultiPageTiff(), 'png', { page }, 'scan.tif', 'tiff'));
    expect(error.name).toBe('InvalidPageRangeError');
    expect(error.message).toMatch(/out of range: the image has 3 frames/);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('pages beyond the page count are rejected', async () => {
    const error = await captureError(() => convertImage(buildMultiPageTiff(), 'png', { pages: '2-5' }, 'scan.tif', 'tiff'));
    expect(error.name).toBe('InvalidPageRangeError');
    expect(error.message).toMatch(/exceeds document page count of 3/);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('a single-page TIFF converts to a plain image without frame metadata', async () => {
    const single = runConvert(['-size', `${WIDTH}x${HEIGHT}`, `xc:${rgb(PAGE_COLOURS[0])}`, 'tiff:-']);
    const result = await convertImage(single, 'png', {}, 'one.tif', 'tiff');
    expect(result.mimeType).toBe('image/png');
    expect(result.sourceFrameCount).toBeUndefined();
    expectCentreColour(result.buffer, 'png', PAGE_COLOURS[0], 'single page');
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('an EXIF orientation is applied to each page image', async () => {
    const result = await convertImage(buildOrientedMultiPageTiff(), 'png', {}, 'scan.tif', 'tiff');
    const { names, zip } = await unzip(result.buffer);
    expect(names).toHaveLength(PAGE_COLOURS.length);
    for (const name of names) {
      const page = decodeRgba(await zip.file(name)!.async('nodebuffer'), 'png');
      // Orientation right-top (6) turns the stored 30x20 page into 20x30.
      expect([page.width, page.height], name).toEqual([HEIGHT, WIDTH]);
    }
  });
});

describe('multi-page TIFF to TIFF', () => {
  it.skipIf(SKIP_WITHOUT_MAGICK)('keeps every page', async () => {
    const result = await convertImage(buildMultiPageTiff(), 'tiff', {}, 'scan.tif', 'tiff');
    expect(result.mimeType).toBe('image/tiff');
    expect(result.filename).toBe('scan.tiff');
    expect(result.sourceFrameCount).toBe(PAGE_COLOURS.length);
    expect(result.frameUsed).toBeUndefined();
    expect(countFrames(result.buffer, 'tif')).toBe(PAGE_COLOURS.length);
    const sizes = withTempImage(result.buffer, 'tif', (file) => runIdentify(['-format', '%wx%h\n', file]).trim().split('\n'));
    expect(sizes).toEqual(PAGE_COLOURS.map(() => `${WIDTH}x${HEIGHT}`));
    PAGE_COLOURS.forEach((colour, index) => expectCentreColour(result.buffer, 'tif', colour, `tiff page ${index + 1}`, index));
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('orients every page and leaves no rotating tag', async () => {
    const result = await convertImage(buildOrientedMultiPageTiff(), 'tiff', {}, 'scan.tif', 'tiff');
    const sizes = withTempImage(result.buffer, 'tif', (file) => runIdentify(['-format', '%wx%h %[orientation]\n', file]).trim().split('\n'));
    // Orientation right-top (6) turns the stored 30x20 pages into 20x30 and no page keeps the tag.
    expect(sizes).toHaveLength(PAGE_COLOURS.length);
    sizes.forEach((line) => expect(line).toMatch(/^20x30 (Undefined|TopLeft)$/));
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('resizes every page', async () => {
    const result = await convertImage(buildMultiPageTiff(), 'tiff', { width: 15, height: 10, fit: 'fill' }, 'scan.tif', 'tiff');
    const sizes = withTempImage(result.buffer, 'tif', (file) => runIdentify(['-format', '%wx%h\n', file]).trim().split('\n'));
    expect(sizes).toEqual(PAGE_COLOURS.map(() => '15x10'));
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('page selects a single-page TIFF', async () => {
    const result = await convertImage(buildMultiPageTiff(), 'tiff', { page: 3 }, 'scan.tif', 'tiff');
    expect(countFrames(result.buffer, 'tif')).toBe(1);
    expect(result.frameUsed).toBe(3);
    expectCentreColour(result.buffer, 'tif', PAGE_COLOURS[2], 'page 3');
  });
});
