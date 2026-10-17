import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { convertVectorCad } from '../src/lib/conversions/vector-cad';
import { getFormatByExtension } from '../src/lib/registry';
import { CadGeometryUnavailableError, EngineUnavailableError } from '../src/lib/types';
import { requireOracleTool } from './helpers/differential-oracle';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipWithoutTools } from './helpers/strict-skip';
import { compareImages } from './helpers/vrt-engine';

/**
 * Real Visio and CorelDRAW files, and the one format that stays refused (DWF). Until #783 the in-process engine took a
 * .vsd or .cdr file for convertible only when its bytes held the text `<svg`, so every real drawing was refused. The
 * office suite's Draw application now imports them (it has the import libraries of both formats) and every target the
 * registry offers is written from its PDF export. Four readers other than the converter judge the output:
 *
 * - pinned phrases, read from the drawing as the renders show them (pdftotext on the PDF) and checked in the PDF, in the
 *   pages of the PostScript and EPS files (ghostscript) and, for the PNG and SVG, as the pixels of the same page;
 * - the page count and size of the PDF (pdfinfo), pinned as literals;
 * - Inkscape, which reads the same two file formats with the same libraries and writes a PDF of its own: every letter it
 *   shows is in the converter's PDF, and the pages look alike (SSIM of the first page);
 * - for the CorelDRAW file with no text, the page thumbnail that CorelDRAW stored in the file itself.
 *
 * The files are fetched, digest-checked and cached like the nightly corpus run does (bench/realworld/manifest.json).
 */

const toolsMissing = skipWithoutTools('soffice', 'pdftotext', 'pdfinfo', 'pdftoppm', 'pdfimages', 'gs');
const inkscapeMissing = skipWithoutTools('inkscape');
const CONVERSION_TIMEOUT_MS = 600_000;
const TOOL_TIMEOUT_MS = 120_000;
const COMPARE_DPI = 50;
const POINT_TOLERANCE = 0.6;
/** Lowest SSIM of a page against another renderer's page of the same file (measured 0.95 to 1.0 against Inkscape). */
const MIN_RENDERER_SSIM = 0.9;
/** Lowest SSIM of the PNG, the SVG and the PostScript render against the PDF page they were written from (measured 0.91 to 1.0: each renderer rasterises text and thin lines its own way). A blank or other page scores far lower. */
const MIN_CHAIN_SSIM = 0.85;
/** Largest distance, in one 8-bit colour channel, between a colour of the render and the same spot of CorelDRAW's thumbnail. */
const THUMBNAIL_COLOUR_TOLERANCE = 16;
const A4_POINTS = { width: 595.28, height: 841.89 };
const TARGETS = ['pdf', 'png', 'svg', 'eps', 'ps'] as const;
const NO_PHRASE: readonly string[] = [];

interface Point {
  width: number;
  height: number;
}

interface SampleCase {
  /** Id in bench/realworld/manifest.json. */
  id: string;
  extension: 'vsd' | 'cdr';
  /** The drawing's page size in points, as the PDF of the page declares it. */
  pageSize: Point;
  /** Phrases of each page's own text, pinned as literals read from the drawing's render. */
  pagePhrases: readonly (readonly string[])[];
  /** Pictures embedded in the drawing's first page, which pdfimages lists in the PDF. */
  embeddedPictures?: number;
  /** Inkscape draws the page as the Draw application does; false where it cannot (it shows a placeholder for the embedded bitmap). */
  inkscapeDrawsAlike: boolean;
}

const SAMPLES: readonly SampleCase[] = [
  { id: 'tika-testvisio.vsd', extension: 'vsd', pageSize: A4_POINTS, pagePhrases: [['test view', 'i am a test view', 'some random text on a page']], inkscapeDrawsAlike: true },
  { id: 'lo-fdo57117-1.vsd', extension: 'vsd', pageSize: A4_POINTS, pagePhrases: [['test']], inkscapeDrawsAlike: true },
  // The Visio text box is narrower than its text, so the Draw application breaks "Nouveau" after "Nouvea".
  { id: 'office-44501.vsd', extension: 'vsd', pageSize: { width: 612.28, height: 790.87 }, pagePhrases: [['penible', 'farine']], inkscapeDrawsAlike: true },
  {
    id: 'office-44501e.vsd',
    extension: 'vsd',
    pageSize: { width: 612, height: 792 },
    pagePhrases: [['busstatus', 'weekdayschedule', 'trafficcondition'], ['player', 'team', 'position']],
    inkscapeDrawsAlike: true,
  },
  { id: 'office-pb-poi.cdr', extension: 'cdr', pageSize: A4_POINTS, pagePhrases: [['powered by', 'apache']], embeddedPictures: 1, inkscapeDrawsAlike: false },
  { id: 'lo-fdo65220-2.cdr', extension: 'cdr', pageSize: A4_POINTS, pagePhrases: [NO_PHRASE], inkscapeDrawsAlike: true },
];

// ---------------------------------------------------------------------------
// Readers other than the converter
// ---------------------------------------------------------------------------

function withTempDir<T>(prefix: string, run: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runTool(tool: Parameters<typeof requireOracleTool>[0], args: string[]): string {
  return execFileSync(requireOracleTool(tool), args, { encoding: 'utf-8', timeout: TOOL_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}

function withFile<T>(bytes: Buffer, extension: string, run: (file: string, dir: string) => T): T {
  return withTempDir('vector-source-', (dir) => {
    const file = path.join(dir, `input.${extension}`);
    fs.writeFileSync(file, bytes);
    return run(file, dir);
  });
}

function normalizedText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** The text of each page of a PDF, as pdftotext reads it. */
function pdfPageTexts(pdf: Buffer): string[] {
  const pages = withFile(pdf, 'pdf', (file) => runTool('pdftotext', [file, '-'])).split('\f');
  if (pages.at(-1)?.trim() === '') pages.pop();
  return pages;
}

function pdfPages(pdf: Buffer): { count: number; sizes: Point[] } {
  const info = withFile(pdf, 'pdf', (file) => runTool('pdfinfo', ['-f', '1', '-l', '99', file]));
  const sizes = [...info.matchAll(/^Page\s+\d+ size:\s+([\d.]+) x ([\d.]+) pts/gm)].map((match) => ({ width: Number(match[1]), height: Number(match[2]) }));
  return { count: Number(/^Pages:\s+(\d+)$/m.exec(info)?.[1]), sizes };
}

function pdfPictureCount(pdf: Buffer): number {
  const listing = withFile(pdf, 'pdf', (file) => runTool('pdfimages', ['-list', file]));
  return listing.split('\n').filter((line) => /^\s*\d+\s+\d+\s+image\b/.test(line)).length;
}

/** The first page of a PDF as a PNG at the comparison resolution. */
function firstPageOfPdf(pdf: Buffer): Buffer {
  return withFile(pdf, 'pdf', (file, dir) => {
    runTool('pdftoppm', ['-png', '-r', String(COMPARE_DPI), '-f', '1', '-l', '1', '-singlefile', file, path.join(dir, 'page')]);
    return fs.readFileSync(path.join(dir, 'page.png'));
  });
}

/** The first page of a PostScript or EPS file as a PNG at the comparison resolution, drawn by ghostscript. */
function firstPageOfPostScript(source: Buffer, extension: 'ps' | 'eps'): Buffer {
  return withFile(source, extension, (file, dir) => {
    const crop = extension === 'eps' ? ['-dEPSCrop'] : [];
    runTool('gs', ['-q', '-dBATCH', '-dNOPAUSE', '-dSAFER', '-sDEVICE=png16m', `-r${COMPARE_DPI}`, ...crop, '-dFirstPage=1', '-dLastPage=1', `-sOutputFile=${path.join(dir, 'page.png')}`, file]);
    return fs.readFileSync(path.join(dir, 'page.png'));
  });
}

/** The file as Inkscape reads it, written as a PDF. */
function inkscapePdf(source: Buffer, extension: string): Buffer {
  return withFile(source, extension, (file, dir) => {
    const out = path.join(dir, 'inkscape.pdf');
    runTool('inkscape', [file, '--export-type=pdf', `--export-filename=${out}`]);
    return fs.readFileSync(out);
  });
}

/** How often each letter or digit occurs in the text: the words of a page without their order or where a line breaks. */
function characterCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const character of normalizedText(text).replaceAll(' ', '')) counts.set(character, (counts.get(character) ?? 0) + 1);
  return counts;
}

/** The pages of an output that holds one file per page: the file itself, or the entries of the ZIP the pages arrive in. */
async function pagesOf(output: Buffer): Promise<Buffer[]> {
  if (output.subarray(0, 2).toString('latin1') !== 'PK') return [output];
  const archive = await JSZip.loadAsync(output);
  const names = Object.keys(archive.files).sort();
  return Promise.all(names.map(async (name) => Buffer.from(await archive.files[name].async('uint8array'))));
}

async function ssim(actual: Buffer, reference: Buffer): Promise<number> {
  const size = await sharp(reference).metadata();
  const resized = await sharp(actual).resize(size.width, size.height, { fit: 'fill' }).png().toBuffer();
  return (await compareImages(resized, reference, { includeDiffImage: false })).ssim;
}

function expectClose(actual: Point, expected: Point, label: string): void {
  expect({ label, width: Math.abs(actual.width - expected.width) <= POINT_TOLERANCE, height: Math.abs(actual.height - expected.height) <= POINT_TOLERANCE }).toEqual({
    label,
    width: true,
    height: true,
  });
}

/** A picture of the right kind with a size and more than one colour. */
async function expectDrawnPicture(image: Buffer, label: string): Promise<{ width: number; height: number }> {
  const metadata = await sharp(image).metadata();
  expect(metadata.width, label).toBeGreaterThan(0);
  expect(metadata.height, label).toBeGreaterThan(0);
  const { channels } = await sharp(image).stats();
  expect(Math.max(...channels.map((channel) => channel.max - channel.min)), `${label} is one flat colour`).toBeGreaterThan(0);
  return { width: metadata.width as number, height: metadata.height as number };
}

function expectPhrases(phrases: readonly string[], text: string, label: string): void {
  const normalized = normalizedText(text);
  expect({ label, missing: phrases.filter((phrase) => !normalized.includes(phrase)) }).toEqual({ label, missing: [] });
}

// ---------------------------------------------------------------------------
// CorelDRAW's own thumbnail of a page
// ---------------------------------------------------------------------------

const BMP_HEADER_BYTES = 54;
const BMP_BITS_PER_PIXEL = 24;

/** A 24-bit uncompressed bottom-up bitmap (the format of the thumbnails in a CorelDRAW package), read from its header per the BMP file layout. */
function readBitmap24(bmp: Buffer): { width: number; height: number; pixel: (x: number, y: number) => [number, number, number] } {
  expect(bmp.subarray(0, 2).toString('latin1')).toBe('BM');
  const width = bmp.readInt32LE(18);
  const height = bmp.readInt32LE(22);
  expect({ bitsPerPixel: bmp.readUInt16LE(28), compression: bmp.readUInt32LE(30) }).toEqual({ bitsPerPixel: BMP_BITS_PER_PIXEL, compression: 0 });
  const rowBytes = Math.ceil((width * BMP_BITS_PER_PIXEL) / 32) * 4;
  return {
    width,
    height,
    pixel: (x, y) => {
      const at = BMP_HEADER_BYTES + (height - 1 - y) * rowBytes + x * 3;
      return [bmp[at + 2], bmp[at + 1], bmp[at]];
    },
  };
}

/** Spots inside the four boxes of the left column of the drawing, as fractions of the page. */
const COLUMN_SPOTS: ReadonlyArray<readonly [number, number]> = [
  [0.17, 0.16],
  [0.17, 0.3],
  [0.17, 0.48],
  [0.17, 0.64],
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(toolsMissing)('real Visio and CorelDRAW files', () => {
  for (const sample of SAMPLES) {
    it(
      `${sample.id}: converts to ${TARGETS.join(', ')} and every output shows the drawing`,
      async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, sample.id);
        const label = (target: string): string => `${sample.id} -> ${target}`;

        const pdf = (await dispatchConversion(bytes, sample.extension, 'pdf', {}, sample.id)).buffer;
        const pages = pdfPages(pdf);
        expect({ id: sample.id, pages: pages.count }).toEqual({ id: sample.id, pages: sample.pagePhrases.length });
        pages.sizes.forEach((size, index) => expectClose(size, sample.pageSize, `${label('pdf')} page ${index + 1} size`));
        const pageTexts = pdfPageTexts(pdf);
        sample.pagePhrases.forEach((phrases, index) => expectPhrases(phrases, pageTexts[index] ?? '', `${label('pdf')} page ${index + 1} text`));
        expect(pdfPictureCount(pdf), `${label('pdf')} pictures`).toBe(sample.embeddedPictures ?? 0);
        const pdfPage = firstPageOfPdf(pdf);

        for (const target of TARGETS.filter((candidate) => candidate !== 'pdf')) {
          const result = await dispatchConversion(bytes, sample.extension, target, {}, sample.id);
          const outputs = await pagesOf(result.buffer);
          if (target !== 'ps') expect(outputs.length, `${label(target)} pages`).toBe(pages.count);
          if (target === 'png') {
            for (const image of outputs) await expectDrawnPicture(image, label(target));
            expect(await ssim(outputs[0], pdfPage), `${label(target)} against the PDF page`).toBeGreaterThan(MIN_CHAIN_SSIM);
          } else if (target === 'svg') {
            expect(outputs[0].toString('utf-8'), label(target)).toMatch(/^<\?xml[^>]*\?>\s*<svg\b/);
            const drawn = await sharp(outputs[0], { density: COMPARE_DPI }).png().toBuffer();
            await expectDrawnPicture(drawn, label(target));
            expect(await ssim(drawn, pdfPage), `${label(target)} against the PDF page`).toBeGreaterThan(MIN_CHAIN_SSIM);
          } else {
            const header = outputs[0].subarray(0, 40).toString('latin1');
            expect(header, label(target)).toMatch(target === 'eps' ? /^%!PS-Adobe-[\d.]+ EPSF-/ : /^%!PS-Adobe-/);
            expect(await ssim(firstPageOfPostScript(outputs[0], target), pdfPage), `${label(target)} against the PDF page`).toBeGreaterThan(MIN_CHAIN_SSIM);
          }
        }
      },
      CONVERSION_TIMEOUT_MS
    );
  }

  it(
    'lo-fdo65220-2.cdr: the colours of the left column are those CorelDRAW stored in the page thumbnail of the file',
    async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, 'lo-fdo65220-2.cdr');
      const thumbnail = readBitmap24(Buffer.from(await (await JSZip.loadAsync(bytes)).files['metadata/thumbnails/page1.bmp'].async('uint8array')));
      const picture = (await dispatchConversion(bytes, 'cdr', 'png', {}, 'fdo65220-2.cdr')).buffer;
      const { data, info } = await sharp(picture).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      for (const [x, y] of COLUMN_SPOTS) {
        const expected = thumbnail.pixel(Math.round(x * thumbnail.width), Math.round(y * thumbnail.height));
        const at = (Math.round(y * info.height) * info.width + Math.round(x * info.width)) * info.channels;
        const actual = [data[at], data[at + 1], data[at + 2]];
        expect({ spot: [x, y], distance: Math.max(...actual.map((channel, index) => Math.abs(channel - expected[index]))) <= THUMBNAIL_COLOUR_TOLERANCE }).toEqual({
          spot: [x, y],
          distance: true,
        });
      }
    },
    CONVERSION_TIMEOUT_MS
  );
});

describe.skipIf(toolsMissing || inkscapeMissing)('real Visio and CorelDRAW files against Inkscape, which reads them with the same libraries', () => {
  for (const sample of SAMPLES) {
    it(
      `${sample.id}: Inkscape's letters are all in the PDF, and the first page looks the same`,
      async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, sample.id);
        const reference = inkscapePdf(bytes, sample.extension);
        const pdf = (await dispatchConversion(bytes, sample.extension, 'pdf', {}, sample.id)).buffer;
        const have = characterCounts(pdfPageTexts(pdf).join(' '));
        const lacking = [...characterCounts(pdfPageTexts(reference).join(' '))].filter(([character, count]) => (have.get(character) ?? 0) < count).map(([character]) => character);
        expect({ id: sample.id, lacking }).toEqual({ id: sample.id, lacking: [] });
        expectClose(pdfPages(pdf).sizes[0], pdfPages(reference).sizes[0], `${sample.id} first page size`);
        if (sample.inkscapeDrawsAlike) expect(await ssim(firstPageOfPdf(pdf), firstPageOfPdf(reference)), `${sample.id} first page`).toBeGreaterThan(MIN_RENDERER_SSIM);
      },
      CONVERSION_TIMEOUT_MS
    );
  }
});

describe('what the in-process engine no longer pretends to read', () => {
  it.each(['vsd', 'cdr'])('a file named .%s whose bytes hold an SVG is not converted by cutting the SVG out of it', async (extension) => {
    const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>');
    const failure = await convertVectorCad(svg, extension, 'png', {}, `drawing.${extension}`).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EngineUnavailableError);
    expect((failure as EngineUnavailableError).engineName).toBe('soffice');
  });

  it.each(['vsd', 'cdr'])('every target the registry offers for .%s is one a real file above converts to', (extension) => {
    const advertised = getFormatByExtension(extension)?.targetFormats ?? [];
    expect([...advertised].sort()).toEqual([...TARGETS].sort());
  });
});

describe('DWF, which has no open-source reader', () => {
  it('a real .dwf file is refused with the reason for every target the registry offers', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'tika-testdwf2010.dwf');
    for (const target of getFormatByExtension('dwf')?.targetFormats ?? []) {
      const failure = await dispatchConversion(bytes, 'dwf', target, {}, 'testDWF2010.dwf').catch((error: unknown) => error);
      expect(failure, `dwf -> ${target}`).toBeInstanceOf(CadGeometryUnavailableError);
      expect((failure as Error).message, `dwf -> ${target}`).toMatch(/no open-source DWF reader exists/);
    }
  });
});
