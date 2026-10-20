import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { requireOracleTool } from './helpers/differential-oracle';
import { differingSamples, renderPostscriptPages, rgbOfRgba } from './helpers/ghostscript-pages';
import { decodeRgba, runConvert } from './helpers/imagemagick';
import { oracleTest } from './helpers/oracle-test';
import { pdfPageSizes, postscriptInkSizes } from './helpers/page-sizes';
import { requireRealworldSample } from './helpers/realworld-sample';

/**
 * A picture written as a PDF, PostScript or EPS page is as large as the picture says it is: pixels x 72 / dpi points on each
 * axis (nothing is resampled), one pixel to the point when the picture states no resolution. The stored resolution of every
 * fixture is read back by exiftool, a reader other than the converter; the pages are measured by Poppler (PDF) and by
 * Ghostscript (PostScript: the page device it sets up and the box of the ink it draws).
 */

const POINTS_PER_INCH = 72;
const CM_PER_INCH = 2.54;
const WIDTH = 800;
const HEIGHT = 400;
const PAGE_TOLERANCE_POINTS = 0.1;
const DEVICE_PAGE_TOLERANCE_POINTS = 1;
const CONVERSION_TIMEOUT_MS = 180_000;
const MAX_PDF_SIDE_POINTS = 14_400;
const PLACEHOLDER_PPM = 1000;
/** A4 in points, the page a 400 dpi scan of A4 is. */
const A4_POINTS = [595.28, 841.89] as const;
const A4_TOLERANCE_POINTS = 1;

type Dpi = readonly [number, number];
type Target = 'pdf' | 'ps' | 'eps';
const TARGETS: readonly Target[] = ['pdf', 'ps', 'eps'];
const TOOLS = ['gs', 'pdfinfo', 'pdfimages', 'exiftool'] as const;

interface Fixture {
  name: string;
  extension: 'tif' | 'png' | 'jpg' | 'webp' | 'avif';
  build: () => Buffer | Promise<Buffer>;
  /** Tags the file stores, as exiftool reads them (-G1 -n), checked before anything is converted. */
  tags: Record<string, number>;
  /** The resolution the page follows, in dots per inch on each axis. */
  dpi: Dpi;
}

let work = '';
beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'print-density-'));
});
afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

function write(name: string, bytes: Buffer): string {
  const file = path.join(work, name);
  fs.writeFileSync(file, bytes);
  return file;
}

function gradient(...options: string[]): string[] {
  return ['-size', `${WIDTH}x${HEIGHT}`, 'gradient:red-blue', '-depth', '8', ...options];
}

/** The picture with ImageMagick's writer and its density settings. */
function magick(extension: string, options: string[]): Buffer {
  return runConvert([...gradient(...options), `${extension}:-`]);
}

/** Sets tags with exiftool, a writer other than the converter. */
function withTags(bytes: Buffer, extension: string, tags: string[]): Buffer {
  const file = write(`tagged-${Math.random().toString(36).slice(2)}.${extension}`, bytes);
  execFileSync(requireOracleTool('exiftool'), ['-overwrite_original', '-q', ...tags, file]);
  return fs.readFileSync(file);
}

function tagsOf(bytes: Buffer, extension: string): Record<string, number> {
  const file = write(`read-${Math.random().toString(36).slice(2)}.${extension}`, bytes);
  const json = execFileSync(requireOracleTool('exiftool'), ['-j', '-n', '-G1', '-XResolution', '-YResolution', '-ResolutionUnit', '-PixelsPerUnitX', '-PixelsPerUnitY', '-PixelUnits', file], { encoding: 'utf-8' });
  const { SourceFile: _source, ...tags } = (JSON.parse(json) as Array<Record<string, number | string>>)[0];
  return tags as Record<string, number>;
}

/** A plain picture from the image library, for the containers ImageMagick here cannot write; it stores no resolution in them. */
function sharpPicture(format: 'webp' | 'avif'): Promise<Buffer> {
  const raw = Buffer.alloc(WIDTH * HEIGHT * 3, 120);
  return sharp(raw, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } })[format]().toBuffer();
}

const INCH = 'PixelsPerInch';
const CENTIMETRE = 'PixelsPerCentimeter';
const NO_UNIT = 'Undefined';

const FIXTURES: readonly Fixture[] = [
  {
    name: 'TIFF at 200 dpi',
    extension: 'tif',
    build: () => magick('tif', ['-units', INCH, '-density', '200']),
    tags: { 'IFD0:XResolution': 200, 'IFD0:YResolution': 200, 'IFD0:ResolutionUnit': 2 },
    dpi: [200, 200],
  },
  {
    name: 'TIFF at 200 x 100 dpi (a different density on each axis)',
    extension: 'tif',
    build: () => magick('tif', ['-units', INCH, '-density', '200x100']),
    tags: { 'IFD0:XResolution': 200, 'IFD0:YResolution': 100, 'IFD0:ResolutionUnit': 2 },
    dpi: [200, 100],
  },
  {
    name: 'TIFF in dots per centimetre (100 x 50)',
    extension: 'tif',
    build: () => magick('tif', ['-units', CENTIMETRE, '-density', '100x50']),
    tags: { 'IFD0:XResolution': 100, 'IFD0:YResolution': 50, 'IFD0:ResolutionUnit': 3 },
    dpi: [100 * CM_PER_INCH, 50 * CM_PER_INCH],
  },
  {
    name: 'TIFF whose resolution unit is "none" (an aspect ratio only)',
    extension: 'tif',
    build: () => magick('tif', ['-units', NO_UNIT, '-density', '300']),
    tags: { 'IFD0:XResolution': 300, 'IFD0:YResolution': 300, 'IFD0:ResolutionUnit': 1 },
    dpi: [POINTS_PER_INCH, POINTS_PER_INCH],
  },
  {
    name: 'TIFF with no resolution tags',
    extension: 'tif',
    build: () => magick('tif', []),
    tags: {},
    dpi: [POINTS_PER_INCH, POINTS_PER_INCH],
  },
  {
    name: 'TIFF whose resolution is zero',
    extension: 'tif',
    build: () => withTags(magick('tif', ['-units', INCH, '-density', '300']), 'tif', ['-IFD0:XResolution=0']),
    tags: { 'IFD0:XResolution': 0, 'IFD0:YResolution': 300, 'IFD0:ResolutionUnit': 2 },
    dpi: [POINTS_PER_INCH, POINTS_PER_INCH],
  },
  {
    name: 'PNG with pHYs at 300 dpi (11811 pixels per metre)',
    extension: 'png',
    build: () => magick('png', ['-units', INCH, '-density', '300']),
    tags: { 'PNG-pHYs:PixelsPerUnitX': 11811, 'PNG-pHYs:PixelsPerUnitY': 11811, 'PNG-pHYs:PixelUnits': 1 },
    dpi: [(11811 * CM_PER_INCH) / 100, (11811 * CM_PER_INCH) / 100],
  },
  {
    name: 'PNG with pHYs of unit 0 (an aspect ratio only)',
    extension: 'png',
    build: () => magick('png', ['-units', NO_UNIT, '-density', '3x1']),
    tags: { 'PNG-pHYs:PixelsPerUnitX': 3, 'PNG-pHYs:PixelsPerUnitY': 1, 'PNG-pHYs:PixelUnits': 0 },
    dpi: [POINTS_PER_INCH, POINTS_PER_INCH],
  },
  {
    name: 'JPEG with JFIF density at 300 dpi',
    extension: 'jpg',
    build: () => magick('jpg', ['-units', INCH, '-density', '300']),
    tags: { 'JFIF:XResolution': 300, 'JFIF:YResolution': 300, 'JFIF:ResolutionUnit': 1 },
    dpi: [300, 300],
  },
  {
    name: 'JPEG with JFIF density in dots per centimetre (100 x 50)',
    extension: 'jpg',
    build: () => magick('jpg', ['-units', CENTIMETRE, '-density', '100x50']),
    tags: { 'JFIF:XResolution': 100, 'JFIF:YResolution': 50, 'JFIF:ResolutionUnit': 2 },
    dpi: [100 * CM_PER_INCH, 50 * CM_PER_INCH],
  },
  {
    name: 'JPEG whose JFIF units are 0 (an aspect ratio only)',
    extension: 'jpg',
    build: () => magick('jpg', ['-units', NO_UNIT, '-density', '2x1']),
    tags: { 'JFIF:XResolution': 2, 'JFIF:YResolution': 1, 'JFIF:ResolutionUnit': 0 },
    dpi: [POINTS_PER_INCH, POINTS_PER_INCH],
  },
  {
    name: 'JPEG with an EXIF resolution only (no JFIF segment)',
    extension: 'jpg',
    build: () => withTags(magick('jpg', []), 'jpg', ['-JFIF:all=', '-IFD0:XResolution=300', '-IFD0:YResolution=150', '-IFD0:ResolutionUnit=inches']),
    tags: { 'IFD0:XResolution': 300, 'IFD0:YResolution': 150, 'IFD0:ResolutionUnit': 2 },
    dpi: [300, 150],
  },
  {
    name: 'JPEG whose JFIF units are 0 and whose EXIF holds 300 x 150 dpi',
    extension: 'jpg',
    build: () => withTags(magick('jpg', ['-units', NO_UNIT, '-density', '1x1']), 'jpg', ['-IFD0:XResolution=300', '-IFD0:YResolution=150', '-IFD0:ResolutionUnit=inches']),
    tags: { 'JFIF:ResolutionUnit': 0, 'IFD0:XResolution': 300, 'IFD0:YResolution': 150, 'IFD0:ResolutionUnit': 2 },
    dpi: [300, 150],
  },
  {
    name: 'JPEG with JFIF at 150 dpi and EXIF at 300 dpi (JFIF is read first)',
    extension: 'jpg',
    build: () => withTags(magick('jpg', ['-units', INCH, '-density', '150']), 'jpg', ['-IFD0:XResolution=300', '-IFD0:YResolution=300', '-IFD0:ResolutionUnit=inches']),
    tags: { 'JFIF:XResolution': 150, 'JFIF:ResolutionUnit': 1, 'IFD0:XResolution': 300, 'IFD0:ResolutionUnit': 2 },
    dpi: [150, 150],
  },
  {
    name: 'WebP with an EXIF resolution of 300 x 150 dpi',
    extension: 'webp',
    build: async () => withTags(await sharpPicture('webp'), 'webp', ['-IFD0:XResolution=300', '-IFD0:YResolution=150', '-IFD0:ResolutionUnit=inches']),
    tags: { 'IFD0:XResolution': 300, 'IFD0:YResolution': 150, 'IFD0:ResolutionUnit': 2 },
    dpi: [300, 150],
  },
  {
    name: 'AVIF with an EXIF resolution of 100 x 50 dots per centimetre',
    extension: 'avif',
    build: async () => withTags(await sharpPicture('avif'), 'avif', ['-IFD0:XResolution=100', '-IFD0:YResolution=50', '-IFD0:ResolutionUnit=cm']),
    tags: { 'IFD0:XResolution': 100, 'IFD0:YResolution': 50, 'IFD0:ResolutionUnit': 3 },
    dpi: [100 * CM_PER_INCH, 50 * CM_PER_INCH],
  },
];

/** The page in points the stored resolution gives, on each axis. */
function expectedPoints(dpi: Dpi, width = WIDTH, height = HEIGHT): readonly [number, number] {
  return [(width * POINTS_PER_INCH) / dpi[0], (height * POINTS_PER_INCH) / dpi[1]];
}

/** The pixel size of every image in a PDF, by Poppler. */
function pdfImageSizes(pdf: Buffer): Array<[number, number]> {
  const file = write(`images-${Math.random().toString(36).slice(2)}.pdf`, pdf);
  const rows = execFileSync(requireOracleTool('pdfimages'), ['-list', file], { encoding: 'utf-8' }).trim().split('\n').slice(2);
  return rows.map((row) => {
    const cells = row.trim().split(/\s+/);
    return [Number(cells[3]), Number(cells[4])];
  });
}

/** The page sizes a PostScript document sets up: what Ghostscript's 72 dpi device makes of each page. */
function devicePages(program: Buffer): Array<[number, number]> {
  return renderPostscriptPages(program).map((page) => [page.width, page.height]);
}

async function epsFiles(zip: Buffer): Promise<Buffer[]> {
  const archive = await JSZip.loadAsync(zip);
  const names = Object.keys(archive.files).sort();
  return Promise.all(names.map((name) => archive.files[name].async('nodebuffer')));
}

function expectBoxes(actual: Array<[number, number]>, expected: ReadonlyArray<readonly [number, number]>, tolerance: number): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((box, page) => {
    expect(Math.abs(box[0] - expected[page][0]), `page ${page + 1} width`).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(box[1] - expected[page][1]), `page ${page + 1} height`).toBeLessThanOrEqual(tolerance);
  });
}

/** Converts `bytes` to `target` and returns the pages' sizes in points as the oracle for that target measures them. */
async function pageSizesOf(bytes: Buffer, extension: string, target: Target, options = {}): Promise<{ sizes: Array<[number, number]>; output: Buffer }> {
  const result = await convertImage(bytes, target, options, `picture.${extension}`, extension);
  if (target === 'pdf') return { sizes: pdfPageSizes(result.buffer), output: result.buffer };
  if (target === 'ps') return { sizes: postscriptInkSizes(result.buffer), output: result.buffer };
  const files = result.mimeType === 'application/zip' ? await epsFiles(result.buffer) : [result.buffer];
  return { sizes: files.flatMap((file) => postscriptInkSizes(file)), output: result.buffer };
}

describe('the page of a picture follows its stored resolution', () => {
  for (const fixture of FIXTURES) {
    for (const target of TARGETS) {
      oracleTest(
        `${fixture.name} to ${target}`,
        [...TOOLS],
        async () => {
          const bytes = await fixture.build();
          expect(tagsOf(bytes, fixture.extension), 'the fixture stores what the case says').toMatchObject(fixture.tags);
          const { sizes } = await pageSizesOf(bytes, fixture.extension, target);
          expectBoxes(sizes, [expectedPoints(fixture.dpi)], PAGE_TOLERANCE_POINTS);
          if (target === 'pdf') expect(pdfImageSizes((await convertImage(bytes, 'pdf', {}, `picture.${fixture.extension}`, fixture.extension)).buffer)).toEqual([[WIDTH, HEIGHT]]);
        },
        CONVERSION_TIMEOUT_MS
      );
    }
  }

  oracleTest(
    'a PNG written by the image library with no density (1 pixel per millimetre) stays one pixel to the point',
    [...TOOLS],
    async () => {
      const raw = Buffer.alloc(WIDTH * HEIGHT * 3, 120);
      const png = await sharp(raw, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } }).png().toBuffer();
      expect(tagsOf(png, 'png')).toMatchObject({ 'PNG-pHYs:PixelsPerUnitX': PLACEHOLDER_PPM, 'PNG-pHYs:PixelUnits': 1 });
      for (const target of TARGETS) {
        const { sizes } = await pageSizesOf(png, 'png', target);
        expectBoxes(sizes, [[WIDTH, HEIGHT]], PAGE_TOLERANCE_POINTS);
      }
    },
    CONVERSION_TIMEOUT_MS
  );

  oracleTest(
    'a PostScript page without a stored resolution is written exactly as before: integer page size and bounding box',
    [...TOOLS],
    async () => {
      const result = await convertImage(magick('tif', []), 'ps', {}, 'picture.tif', 'tif');
      const text = result.buffer.toString('latin1');
      expect(text).toContain(`%%BoundingBox: 0 0 ${WIDTH} ${HEIGHT}\n`);
      expect(text).toContain(`<< /PageSize [${WIDTH} ${HEIGHT}] >> setpagedevice\n`);
      expect(text).toContain(`${WIDTH} ${HEIGHT} scale\n`);
    },
    CONVERSION_TIMEOUT_MS
  );

  oracleTest(
    'a 200 x 100 dpi picture to ps draws back the pixels of the picture when it is rendered at that density',
    [...TOOLS],
    async () => {
      const bytes = magick('tif', ['-units', INCH, '-density', '200x100']);
      const result = await convertImage(bytes, 'ps', {}, 'picture.tif', 'tif');
      const pages = renderPostscriptPages(result.buffer, ['-r200x100']);
      expect(pages).toHaveLength(1);
      expect([pages[0].width, pages[0].height]).toEqual([WIDTH, HEIGHT]);
      expect(differingSamples(pages[0], rgbOfRgba(decodeRgba(bytes, 'tif').data))).toBe(0);
    },
    CONVERSION_TIMEOUT_MS
  );

  oracleTest(
    'a 200 x 100 dpi picture to pdf keeps every pixel: the image is the pixels of the picture, placed on the whole page',
    [...TOOLS],
    async () => {
      const bytes = magick('tif', ['-units', INCH, '-density', '200x100']);
      const result = await convertImage(bytes, 'pdf', {}, 'picture.tif', 'tif');
      const file = write('pixels.pdf', result.buffer);
      execFileSync(requireOracleTool('pdfimages'), ['-png', file, path.join(work, 'pixels')]);
      const extracted = fs.readFileSync(path.join(work, 'pixels-000.png'));
      expect(decodeRgba(extracted, 'png').data.equals(decodeRgba(bytes, 'tif').data)).toBe(true);
      // The image covers the whole page: the ink of the page is the page.
      expectBoxes(postscriptInkSizes(result.buffer), [expectedPoints([200, 100])], DEVICE_PAGE_TOLERANCE_POINTS);
    },
    CONVERSION_TIMEOUT_MS
  );

  for (const target of TARGETS) {
    oracleTest(
      `EXIF orientation 6 turns the picture, so its two densities turn with it (${target})`,
      [...TOOLS],
      async () => {
        const tiff = withTags(magick('tif', ['-units', INCH, '-density', '200x50']), 'tif', ['-Orientation#=6']);
        const jpeg = withTags(magick('jpg', ['-units', INCH, '-density', '200x50']), 'jpg', ['-Orientation#=6']);
        // The upright picture is HEIGHT x WIDTH pixels: its width of HEIGHT pixels is the old Y axis (50 dpi), its height the old X axis (200 dpi).
        const expected: readonly [number, number] = [(HEIGHT * POINTS_PER_INCH) / 50, (WIDTH * POINTS_PER_INCH) / 200];
        for (const [bytes, extension] of [[tiff, 'tif'], [jpeg, 'jpg']] as const) {
          const { sizes } = await pageSizesOf(bytes, extension, target);
          expectBoxes(sizes, [expected], PAGE_TOLERANCE_POINTS);
        }
      },
      CONVERSION_TIMEOUT_MS
    );
  }

  oracleTest(
    'a resized picture to ps is the new pixel count at the stored density',
    [...TOOLS],
    async () => {
      const bytes = magick('tif', ['-units', INCH, '-density', '200']);
      const { sizes } = await pageSizesOf(bytes, 'tif', 'ps', { width: WIDTH / 2 });
      expectBoxes(sizes, [expectedPoints([200, 200], WIDTH / 2, HEIGHT / 2)], PAGE_TOLERANCE_POINTS);
    },
    CONVERSION_TIMEOUT_MS
  );

  oracleTest(
    'a page that would be over 14,400 points a side is scaled to that limit in a PDF, with the pixels untouched',
    [...TOOLS],
    async () => {
      const bytes = runConvert(['-size', '400x200', 'gradient:red-blue', '-units', INCH, '-density', '1', 'tif:-']);
      const result = await convertImage(bytes, 'pdf', {}, 'picture.tif', 'tif');
      const [page] = pdfPageSizes(result.buffer);
      expect(page[0]).toBeCloseTo(MAX_PDF_SIDE_POINTS, 1);
      expect(page[1]).toBeCloseTo(MAX_PDF_SIDE_POINTS / 2, 1);
      expect(pdfImageSizes(result.buffer)).toEqual([[400, 200]]);
    },
    CONVERSION_TIMEOUT_MS
  );
});

describe('a density that would make a page longer than the readers accept', () => {
  const LOW_DENSITY_DPI = 0.1;

  for (const target of ['ps', 'eps'] as const) {
    oracleTest(
      `a ${LOW_DENSITY_DPI} dpi TIFF is a page of at most 14,400 points to ${target}, scaled evenly`,
      [...TOOLS],
      async () => {
        const bytes = runConvert(['-size', '2000x1000', 'gradient:red-blue', '-depth', '8', '-units', INCH, '-density', String(LOW_DENSITY_DPI), 'tif:-']);
        const file = write('low-density.tif', bytes);
        expect(execFileSync(requireOracleTool('tiffinfo'), [file], { encoding: 'utf-8' })).toContain(`Resolution: ${LOW_DENSITY_DPI}, ${LOW_DENSITY_DPI} pixels/inch`);
        const { sizes, output } = await pageSizesOf(bytes, 'tif', target);
        expectBoxes(sizes, [[MAX_PDF_SIDE_POINTS, MAX_PDF_SIDE_POINTS / 2]], PAGE_TOLERANCE_POINTS);
        const box = /^%%BoundingBox: 0 0 (\d+) (\d+)$/m.exec(output.toString('latin1'));
        expect([Number(box?.[1]), Number(box?.[2])]).toEqual([MAX_PDF_SIDE_POINTS, MAX_PDF_SIDE_POINTS / 2]);
      },
      CONVERSION_TIMEOUT_MS
    );
  }
});

describe('each page of a multi-page source follows its own resolution', () => {
  /** Two pages, 800 x 400 pixels at 200 dpi and 400 x 800 pixels at 100 x 50 dpi. */
  function twoDensities(): Buffer {
    return runConvert([
      '(', '-size', '800x400', 'gradient:red-blue', '-units', INCH, '-set', 'density', '200x200', ')',
      '(', '-size', '400x800', 'gradient:green-yellow', '-units', INCH, '-set', 'density', '100x50', ')',
      'tif:-',
    ]);
  }
  const EXPECTED: ReadonlyArray<readonly [number, number]> = [
    [(800 * POINTS_PER_INCH) / 200, (400 * POINTS_PER_INCH) / 200],
    [(400 * POINTS_PER_INCH) / 100, (800 * POINTS_PER_INCH) / 50],
  ];

  for (const target of TARGETS) {
    oracleTest(
      `a two-page TIFF to ${target}`,
      [...TOOLS],
      async () => {
        const bytes = twoDensities();
        const file = write('two-densities.tif', bytes);
        const tiffinfo = execFileSync(requireOracleTool('tiffinfo'), [file], { encoding: 'utf-8' });
        expect([...tiffinfo.matchAll(/Resolution: ([\d.]+), ([\d.]+) pixels\/inch/g)].map((m) => [Number(m[1]), Number(m[2])])).toEqual([[200, 200], [100, 50]]);
        const { sizes } = await pageSizesOf(bytes, 'tif', target);
        expectBoxes(sizes, EXPECTED, PAGE_TOLERANCE_POINTS);
      },
      CONVERSION_TIMEOUT_MS
    );
  }

  oracleTest(
    'the page a request selects follows its own resolution',
    [...TOOLS],
    async () => {
      const { sizes } = await pageSizesOf(twoDensities(), 'tif', 'ps', { page: 2 });
      expectBoxes(sizes, [EXPECTED[1]], PAGE_TOLERANCE_POINTS);
    },
    CONVERSION_TIMEOUT_MS
  );
});

describe('a 400 dpi scan from the real-world corpus', () => {
  const SAMPLE = 'pil-g4-multi.tiff';
  const SAMPLE_PAGES = 3;

  for (const target of ['pdf', 'ps'] as const) {
    oracleTest(
      `is A4 pages in ${target}, as the scan was`,
      [...TOOLS],
      async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, SAMPLE);
        const { sizes, output } = await pageSizesOf(bytes, 'tiff', target);
        expectBoxes(sizes, Array(SAMPLE_PAGES).fill(A4_POINTS), A4_TOLERANCE_POINTS);
        if (target === 'ps') expectBoxes(devicePages(output), Array(SAMPLE_PAGES).fill(A4_POINTS), DEVICE_PAGE_TOLERANCE_POINTS);
      },
      CONVERSION_TIMEOUT_MS
    );
  }

  oracleTest(
    'is one A4 figure per page in eps',
    [...TOOLS],
    async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, SAMPLE);
      const { sizes } = await pageSizesOf(bytes, 'tiff', 'eps');
      expectBoxes(sizes, Array(SAMPLE_PAGES).fill(A4_POINTS), A4_TOLERANCE_POINTS);
    },
    CONVERSION_TIMEOUT_MS
  );
});
