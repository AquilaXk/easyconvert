import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { ConversionFailedError, EngineUnavailableError, InvalidPageRangeError } from '../src/lib/types';
import { isOracleToolAvailable, requireOracleTool, extractTextWithExternalPdftotext } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { withMissingBinary } from './helpers/native-tools';
import { buildPdf, singlePagePdf, textContent, type CraftObject } from './helpers/pdf-craft';
import { withSofficeShim } from './helpers/soffice-shim';
import { withPs2pdfShim } from './helpers/ps2pdf-shim';
import { decodeRgba, runConvert, runIdentify, withTempImage } from './helpers/imagemagick';
import { readDxf, type DxfPoint } from './helpers/dxf-reader';
import { flatOdg, flatOdgWithRectangle, normalizeWhitespace, sofficeConvert } from './helpers/soffice-office';

/**
 * Pages become any target a native tool chain writes, not only the two the first Poppler route offered:
 * LibreOffice or the PostScript interpreter draws the pages as PDF, then Poppler renders PNG pages that the image
 * encoders write as avif, bmp, gif, ico, psd or webp, pdftops writes PostScript and EPS, and pdftocairo's SVG
 * geometry becomes DXF. Every expected value comes from a standard CLI run on the same PDF (pdfinfo, pdftocairo,
 * pdftops, ImageMagick), from a hand-written DXF reader, or from geometry written into the fixture itself.
 */

const HAS_PS2PDF = isOracleToolAvailable('ps2pdf');
const NATIVE_TIMEOUT_MS = 240_000;
const POPPLER_DPI = 150;
const POINTS_PER_INCH = 72;
const ICO_MAX_SIDE = 256;
const RED_MIN = 150;
const OTHER_MAX = 100;
const RED_FRACTION_TOLERANCE = 0.02;
const DXF_TOLERANCE = 0.3;
const BEZIER_SAMPLES = 2000;
/** Mean absolute 8-bit difference allowed between two rasterisations of the same figure. */
const RENDERER_MEAN_DIFF_MAX = 12;

const ENCODED_RASTERS: ReadonlyArray<{ source: string; target: string; magick: string }> = [
  { source: 'odg', target: 'bmp', magick: 'BMP' },
  { source: 'odd', target: 'avif', magick: 'AVIF' },
  { source: 'odd', target: 'bmp', magick: 'BMP' },
  { source: 'odd', target: 'gif', magick: 'GIF' },
  { source: 'odd', target: 'ico', magick: 'ICO' },
  { source: 'odd', target: 'psd', magick: 'PSD' },
  { source: 'odd', target: 'tiff', magick: 'TIFF' },
  { source: 'odd', target: 'webp', magick: 'WEBP' },
];

// ---------------------------------------------------------------------------
// Reference tools
// ---------------------------------------------------------------------------

interface PdfGeometry {
  pages: number;
  /** Width and height of every page in points, from pdfinfo. */
  sizes: Array<{ width: number; height: number }>;
}

function inTempDir<T>(run: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-chain-'));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function pdfGeometry(pdf: Buffer): PdfGeometry {
  return inTempDir((dir) => {
    const file = path.join(dir, 'in.pdf');
    fs.writeFileSync(file, pdf);
    const summary = execFileSync(requireOracleTool('pdfinfo'), [file], { encoding: 'utf-8' });
    const pages = Number(/Pages:\s+(\d+)/.exec(summary)?.[1]);
    const sizes: PdfGeometry['sizes'] = [];
    for (let page = 1; page <= pages; page += 1) {
      const info = execFileSync(requireOracleTool('pdfinfo'), ['-f', String(page), '-l', String(page), file], { encoding: 'utf-8' });
      const size = new RegExp(`Page\\s+${page} size:\\s+([\\d.]+) x ([\\d.]+) pts`).exec(info);
      if (!size) throw new Error(`pdfinfo printed no size for page ${page}: ${info}`);
      sizes.push({ width: Number(size[1]), height: Number(size[2]) });
    }
    return { pages, sizes };
  });
}

/** Pixels of a page rendered at the Poppler default resolution. */
function pagePixels(size: { width: number; height: number }): { width: number; height: number } {
  return { width: (size.width * POPPLER_DPI) / POINTS_PER_INCH, height: (size.height * POPPLER_DPI) / POINTS_PER_INCH };
}

function pdftocairoRender(pdf: Buffer): Buffer {
  return inTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'in.pdf'), pdf);
    execFileSync(requireOracleTool('pdftocairo'), ['-png', '-r', String(POPPLER_DPI), '-f', '1', '-l', '1', '-singlefile', path.join(dir, 'in.pdf'), path.join(dir, 'ref')]);
    return fs.readFileSync(path.join(dir, 'ref.png'));
  });
}

function redFraction(encoded: Buffer, extension: string): number {
  const image = decodeRgba(encoded, extension);
  let red = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    if (image.data[i] >= RED_MIN && image.data[i + 1] <= OTHER_MAX && image.data[i + 2] <= OTHER_MAX && image.data[i + 3] > 0) red += 1;
  }
  return red / (image.width * image.height);
}

function identifyBytes(encoded: Buffer, extension: string): { format: string; width: number; height: number } {
  const [format, width, height] = withTempImage(encoded, extension, (file) => runIdentify(['-format', '%m %w %h\n', file]).trim().split('\n')[0].split(' '));
  return { format, width: Number(width), height: Number(height) };
}

/** The one picture of an ICO file, read from its ICONDIR: the entry holds a PNG of at most 256 x 256 pixels. */
function iconPicture(ico: Buffer): Buffer {
  expect(ico.readUInt16LE(0)).toBe(0);
  expect(ico.readUInt16LE(2)).toBe(1);
  expect(ico.readUInt16LE(4)).toBe(1);
  const size = ico.readUInt32LE(6 + 8);
  const offset = ico.readUInt32LE(6 + 12);
  return ico.subarray(offset, offset + size);
}

/** ImageMagick names a Windows BMP "BMP3" when its header is the 40-byte version. */
function expectFormat(actual: string, magick: string): void {
  if (magick === 'BMP') expect(actual).toMatch(/^BMP3?$/);
  else expect(actual).toBe(magick);
}

async function entriesOf(zip: Buffer): Promise<string[]> {
  return Object.keys((await JSZip.loadAsync(zip)).files).sort();
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RED_RECTANGLE_TEXT = ['Rectangle below'];

function drawingOf(source: 'odg' | 'odd'): Buffer {
  const flat = flatOdgWithRectangle(RED_RECTANGLE_TEXT, '#ff0000');
  return source === 'odg' ? sofficeConvert(flat, 'fodg', 'odg', 'odg') : sofficeConvert(flat, 'fodg', 'otg', 'otg');
}

function libreOfficePdf(drawing: Buffer, extension: string): Buffer {
  return sofficeConvert(drawing, extension, 'pdf', 'pdf');
}

interface PdfPage {
  width: number;
  height: number;
  content: string;
}

/** A PDF written by hand: one page tree, one content stream per page. */
function handWrittenPdf(pages: PdfPage[]): Buffer {
  const objects: CraftObject[] = [
    { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
    { id: 2, dict: `/Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages.length}` },
  ];
  pages.forEach((page, i) => {
    const pageId = 3 + i * 2;
    objects.push({ id: pageId, dict: `/Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Contents ${pageId + 1} 0 R` });
    objects.push({ id: pageId + 1, stream: Buffer.from(page.content, 'latin1') });
  });
  return buildPdf(objects, 1).buffer;
}

/** The drawing the DXF tests expect back: one line, one closed triangle, one filled rectangle and one curve. */
const DRAWING_CONTENT = [
  '1 0 0 RG 2 w 20 20 m 180 20 l S',
  '0 0 1 RG 1 w 40 40 m 100 90 l 160 40 l h S',
  '0 0.5 0 rg 30 60 40 20 re f',
  '0 0 0 RG 50 50 m 60 90 100 90 110 50 c S',
].join('\n');

const DRAWING_PAGE: PdfPage = { width: 200, height: 100, content: DRAWING_CONTENT };
const SMALL_PAGE: PdfPage = { width: 200, height: 100, content: '1 0 0 rg 10 10 50 30 re f' };
const MEDIUM_PAGE: PdfPage = { width: 300, height: 150, content: '0 1 0 rg 20 20 60 40 re f' };
const LARGE_PAGE: PdfPage = { width: 400, height: 200, content: '0 0 1 rg 30 30 80 50 re f' };
const POSTSCRIPT_SOURCE = Buffer.from('%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 200 100\n%%EndComments\nshowpage\n', 'latin1');

// ---------------------------------------------------------------------------
// LibreOffice drawings to encoded rasters
// ---------------------------------------------------------------------------

describe('drawings render to every advertised raster', () => {
  it.each(ENCODED_RASTERS)('advertises $source -> $target', ({ source, target }) => {
    expect(FORMAT_REGISTRY[source].targetFormats).toContain(target);
  });

  for (const { source, target, magick } of ENCODED_RASTERS) {
    oracleTest(
      `${source} -> ${target} is a ${magick} picture of the page LibreOffice draws`,
      ['soffice', 'pdftoppm', 'pdftocairo', 'pdfinfo', 'identify'],
      async () => {
        const drawing = drawingOf(source as 'odg' | 'odd');
        const result = await dispatchConversion(drawing, source, target, {}, `shapes.${source}`);
        expect(result.filename).toBe(`shapes.${target}`);
        expect(result.engineUsed).toBe('native-poppler');
        const reference = libreOfficePdf(drawing, source === 'odg' ? 'odg' : 'otg');
        const expected = pagePixels(pdfGeometry(reference).sizes[0]);
        const expectedRed = redFraction(pdftocairoRender(reference), 'png');
        expect(expectedRed).toBeGreaterThan(0.01);
        if (target === 'ico') {
          // An icon holds at most 256 pixels a side: the page is scaled down to fit and centred, keeping its proportions.
          const picture = iconPicture(result.buffer);
          const decoded = identifyBytes(picture, 'png');
          expect(decoded.format).toBe('PNG');
          expect([decoded.width, decoded.height]).toEqual([ICO_MAX_SIDE, ICO_MAX_SIDE]);
          const scale = ICO_MAX_SIDE / Math.max(expected.width, expected.height);
          const pageShare = (expected.width * scale * expected.height * scale) / (ICO_MAX_SIDE * ICO_MAX_SIDE);
          expect(Math.abs(redFraction(picture, 'png') - expectedRed * pageShare)).toBeLessThan(RED_FRACTION_TOLERANCE * pageShare);
          return;
        }
        const decoded = identifyBytes(result.buffer, target);
        expectFormat(decoded.format, magick);
        expect(Math.abs(decoded.width - expected.width)).toBeLessThanOrEqual(1);
        expect(Math.abs(decoded.height - expected.height)).toBeLessThanOrEqual(1);
        // The red rectangle is drawn: the share of red pixels matches an independent render of the same PDF.
        expect(Math.abs(redFraction(result.buffer, target) - expectedRed)).toBeLessThan(RED_FRACTION_TOLERANCE);
      },
      NATIVE_TIMEOUT_MS
    );
  }

  oracleTest('a drawing of two pages comes back as one bmp per page, in a ZIP; multiPageOutput first keeps page one', ['soffice', 'pdfinfo', 'identify'], async () => {
    const drawing = fs.readFileSync(path.join(__dirname, 'fixtures', 'office-sources', 'drawing-two-pages.odg'));
    const geometry = pdfGeometry(libreOfficePdf(drawing, 'odg'));
    expect(geometry.pages).toBe(2);

    const all = await dispatchConversion(drawing, 'odg', 'bmp', {}, 'pages.odg');
    expect(all.filename).toBe('pages.zip');
    const entries = await entriesOf(all.buffer);
    expect(entries).toEqual(['pages-p001.bmp', 'pages-p002.bmp']);
    const zip = await JSZip.loadAsync(all.buffer);
    for (const [index, entry] of entries.entries()) {
      const decoded = identifyBytes(await zip.files[entry].async('nodebuffer'), 'bmp');
      const expected = pagePixels(geometry.sizes[index]);
      expectFormat(decoded.format, 'BMP');
      expect(Math.abs(decoded.width - expected.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(decoded.height - expected.height)).toBeLessThanOrEqual(1);
    }

    const first = await dispatchConversion(drawing, 'odg', 'bmp', { multiPageOutput: 'first' }, 'pages.odg');
    expect(first.filename).toBe('pages.bmp');
    expectFormat(identifyBytes(first.buffer, 'bmp').format, 'BMP');
  }, NATIVE_TIMEOUT_MS);

  oracleTest('a page selection reaches the encoder: pages 2 of 2 is one bmp', ['soffice', 'pdfinfo', 'identify'], async () => {
    const drawing = fs.readFileSync(path.join(__dirname, 'fixtures', 'office-sources', 'drawing-two-pages.odg'));
    const result = await dispatchConversion(drawing, 'odg', 'bmp', { pages: '2' }, 'pages.odg');
    expect(result.filename).toBe('pages.bmp');
    expectFormat(identifyBytes(result.buffer, 'bmp').format, 'BMP');
  }, NATIVE_TIMEOUT_MS);
});

describe('drawing templates are saved again as drawing templates', () => {
  oracleTest('odd -> odd is an OpenDocument drawing template with the same text', ['soffice', 'pdftotext'], async () => {
    const text = [['Template line one', 'Café 한국어']];
    const template = sofficeConvert(flatOdg(text), 'fodg', 'otg', 'otg');
    const result = await dispatchConversion(template, 'odd', 'odd', {}, 'template.odd');
    expect(result.filename).toBe('template.odd');
    expect(result.mimeType).toBe('application/vnd.oasis.opendocument.graphics-template');
    const zip = await JSZip.loadAsync(result.buffer);
    expect(await zip.file('mimetype')!.async('string')).toBe('application/vnd.oasis.opendocument.graphics-template');
    const rendered = libreOfficePdf(result.buffer, 'otg');
    expect(normalizeWhitespace(extractTextWithExternalPdftotext(rendered) ?? '')).toBe(normalizeWhitespace(text.flat().join(' ')));
  }, NATIVE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// LibreOffice drawings to PostScript and EPS
// ---------------------------------------------------------------------------

describe('drawings become PostScript and EPS through pdftops', () => {
  oracleTest('odd -> ps is a PostScript file of the same pages, as pdftops writes them', ['soffice', 'pdftops', 'pdfinfo'], async () => {
    const drawing = fs.readFileSync(path.join(__dirname, 'fixtures', 'office-sources', 'drawing-two-pages.odg'));
    const template = sofficeConvert(drawing, 'odg', 'otg', 'otg');
    const result = await dispatchConversion(template, 'odd', 'ps', {}, 'drawing.odd');
    const text = result.buffer.toString('latin1');
    expect(result.filename).toBe('drawing.ps');
    expect(text.startsWith('%!PS-Adobe-3.0\n')).toBe(true);
    expect(text).not.toContain('EPSF');
    expect(text).toContain('%%Pages: 2\n');
    const first = pdfGeometry(libreOfficePdf(template, 'otg')).sizes[0];
    const box = /%%BoundingBox: (\d+) (\d+) (\d+) (\d+)/.exec(text);
    expect(box?.slice(1).map(Number)).toEqual([0, 0, Math.ceil(first.width), Math.ceil(first.height)]);
  }, NATIVE_TIMEOUT_MS);

  oracleTest('odd -> eps is one EPS per page in a ZIP, each cropped to its page, and multiPageOutput first keeps page one', ['soffice', 'pdftops', 'pdfinfo'], async () => {
    const drawing = fs.readFileSync(path.join(__dirname, 'fixtures', 'office-sources', 'drawing-two-pages.odg'));
    const template = sofficeConvert(drawing, 'odg', 'otg', 'otg');
    const geometry = pdfGeometry(libreOfficePdf(template, 'otg'));
    const result = await dispatchConversion(template, 'odd', 'eps', {}, 'drawing.odd');
    expect(result.filename).toBe('drawing.zip');
    expect(await entriesOf(result.buffer)).toEqual(['drawing-p001.eps', 'drawing-p002.eps']);
    const zip = await JSZip.loadAsync(result.buffer);
    for (const [index, entry] of ['drawing-p001.eps', 'drawing-p002.eps'].entries()) {
      const text = (await zip.files[entry].async('nodebuffer')).toString('latin1');
      expect(text.startsWith('%!PS-Adobe-3.0 EPSF-3.0\n')).toBe(true);
      const box = /%%BoundingBox: (\d+) (\d+) (\d+) (\d+)/.exec(text);
      expect(box?.slice(1).map(Number)).toEqual([0, 0, Math.ceil(geometry.sizes[index].width), Math.ceil(geometry.sizes[index].height)]);
    }
    const first = await dispatchConversion(template, 'odd', 'eps', { multiPageOutput: 'first' }, 'drawing.odd');
    expect(first.filename).toBe('drawing.eps');
    expect(first.buffer.toString('latin1').startsWith('%!PS-Adobe-3.0 EPSF-3.0\n')).toBe(true);
  }, NATIVE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// PostScript sources through the interpreter (a prepared PDF stands in for it)
// ---------------------------------------------------------------------------

describe('PostScript sources hand the interpreter output to the page tools', () => {
  const ONE_PAGE = () => handWrittenPdf([SMALL_PAGE]);
  const THREE_PAGES = () => handWrittenPdf([SMALL_PAGE, MEDIUM_PAGE, LARGE_PAGE]);

  oracleTest('eps asks the interpreter to crop the page to its bounding box; ps does not', ['pdftops'], async () => {
    await withPs2pdfShim(ONE_PAGE(), async (flags) => {
      await dispatchConversion(POSTSCRIPT_SOURCE, 'eps', 'pdf', {}, 'figure.eps');
      expect(flags()).toEqual(['-dSAFER', '-dEPSCrop']);
    });
    await withPs2pdfShim(ONE_PAGE(), async (flags) => {
      await dispatchConversion(POSTSCRIPT_SOURCE, 'ps', 'pdf', {}, 'document.ps');
      expect(flags()).toEqual(['-dSAFER']);
    });
  }, NATIVE_TIMEOUT_MS);

  for (const source of ['eps', 'ps']) {
    for (const target of ['avif', 'bmp', 'gif', 'webp']) {
      oracleTest(
        `${source} -> ${target} is the ${target} picture of the interpreter's page`,
        ['pdftoppm', 'pdfinfo', 'identify'],
        async () => {
          const pdf = ONE_PAGE();
          await withPs2pdfShim(pdf, async () => {
            const result = await dispatchConversion(POSTSCRIPT_SOURCE, source, target, {}, `figure.${source}`);
            expect(result.filename).toBe(`figure.${target}`);
            const decoded = identifyBytes(result.buffer, target);
            const expected = pagePixels(pdfGeometry(pdf).sizes[0]);
            expectFormat(decoded.format, target.toUpperCase());
            expect(Math.abs(decoded.width - expected.width)).toBeLessThanOrEqual(1);
            expect(Math.abs(decoded.height - expected.height)).toBeLessThanOrEqual(1);
          });
        },
        NATIVE_TIMEOUT_MS
      );
    }
  }

  for (const [source, target, header] of [
    ['eps', 'eps', '%!PS-Adobe-3.0 EPSF-3.0'],
    ['ps', 'eps', '%!PS-Adobe-3.0 EPSF-3.0'],
    ['eps', 'ps', '%!PS-Adobe-3.0'],
    ['ps', 'ps', '%!PS-Adobe-3.0'],
  ]) {
    oracleTest(`${source} -> ${target} is PostScript with the page's bounding box`, ['pdftops', 'pdfinfo'], async () => {
      await withPs2pdfShim(ONE_PAGE(), async () => {
        const result = await dispatchConversion(POSTSCRIPT_SOURCE, source, target, {}, `figure.${source}`);
        const text = result.buffer.toString('latin1');
        expect(result.filename).toBe(`figure.${target}`);
        expect(text.split('\n')[0]).toBe(header);
        expect(/%%BoundingBox: (\d+) (\d+) (\d+) (\d+)/.exec(text)?.slice(1).map(Number)).toEqual([0, 0, 200, 100]);
        expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
      });
    }, NATIVE_TIMEOUT_MS);
  }

  oracleTest('a PostScript file of three pages: ps keeps them in one file, eps gives one EPS per page with its own box', ['pdftops', 'pdfinfo'], async () => {
    await withPs2pdfShim(THREE_PAGES(), async () => {
      const ps = await dispatchConversion(POSTSCRIPT_SOURCE, 'ps', 'ps', {}, 'doc.ps');
      expect(ps.filename).toBe('doc.ps');
      expect(ps.buffer.toString('latin1')).toContain('%%Pages: 3\n');

      const eps = await dispatchConversion(POSTSCRIPT_SOURCE, 'ps', 'eps', {}, 'doc.ps');
      expect(eps.filename).toBe('doc.zip');
      const zip = await JSZip.loadAsync(eps.buffer);
      const boxes = await Promise.all(
        ['doc-p001.eps', 'doc-p002.eps', 'doc-p003.eps'].map(async (entry) =>
          /%%BoundingBox: (\d+) (\d+) (\d+) (\d+)/.exec((await zip.files[entry].async('nodebuffer')).toString('latin1'))?.slice(1).map(Number)
        )
      );
      expect(boxes).toEqual([[0, 0, 200, 100], [0, 0, 300, 150], [0, 0, 400, 200]]);

      const second = await dispatchConversion(POSTSCRIPT_SOURCE, 'ps', 'eps', { page: 2 }, 'doc.ps');
      expect(second.filename).toBe('doc.eps');
      expect(/%%BoundingBox: (\d+) (\d+) (\d+) (\d+)/.exec(second.buffer.toString('latin1'))?.slice(1).map(Number)).toEqual([0, 0, 300, 150]);

      const firstOnly = await dispatchConversion(POSTSCRIPT_SOURCE, 'ps', 'ps', { multiPageOutput: 'first' }, 'doc.ps');
      expect(firstOnly.buffer.toString('latin1')).toContain('%%Pages: 1\n');
    });
  }, NATIVE_TIMEOUT_MS);

  oracleTest('pages that are not one consecutive run cannot be one PostScript file: a typed 400 error', ['pdftops'], async () => {
    await withPs2pdfShim(THREE_PAGES(), async () => {
      const run = dispatchConversion(POSTSCRIPT_SOURCE, 'ps', 'ps', { pages: '1,3' }, 'doc.ps');
      await expect(run).rejects.toBeInstanceOf(InvalidPageRangeError);
      await expect(run).rejects.toThrow(/consecutive pages/);
    });
  }, NATIVE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// PostScript sources to DXF
// ---------------------------------------------------------------------------

function near(actual: DxfPoint, expected: [number, number]): boolean {
  return Math.abs(actual.x - expected[0]) <= DXF_TOLERANCE && Math.abs(actual.y - expected[1]) <= DXF_TOLERANCE && actual.z === 0;
}

/** The point of the cubic Bezier at t, from the four control points. */
function bezier(p: ReadonlyArray<[number, number]>, t: number): [number, number] {
  const u = 1 - t;
  const weights = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return [0, 1].map((axis) => p.reduce((sum, point, i) => sum + point[axis] * weights[i], 0)) as [number, number];
}

function distanceToCurve(point: DxfPoint, controls: ReadonlyArray<[number, number]>): number {
  let best = Infinity;
  for (let i = 0; i <= BEZIER_SAMPLES; i += 1) {
    const [x, y] = bezier(controls, i / BEZIER_SAMPLES);
    best = Math.min(best, Math.hypot(point.x - x, point.y - y));
  }
  return best;
}

function expectDrawingGeometry(dxfText: string): void {
  const dxf = readDxf(dxfText);
  expect(dxf.version).toBe('AC1009');
  // Units are PostScript points, the Y axis points up: the page box is 200 x 100 and every vertex lies in it.
  expect(dxf.extMin.x).toBeGreaterThanOrEqual(-DXF_TOLERANCE);
  expect(dxf.extMin.y).toBeGreaterThanOrEqual(-DXF_TOLERANCE);
  expect(dxf.extMax.x).toBeLessThanOrEqual(200 + DXF_TOLERANCE);
  expect(dxf.extMax.y).toBeLessThanOrEqual(100 + DXF_TOLERANCE);

  const lines = dxf.entities.filter((e) => e.type === 'LINE');
  expect(lines).toHaveLength(1);
  expect(near(lines[0].points[0], [20, 20]) && near(lines[0].points[1], [180, 20])).toBe(true);

  const closed = dxf.entities.filter((e) => e.type === 'POLYLINE' && e.closed);
  const triangle = closed.find((e) => e.points.length === 3);
  expect(triangle).toBeDefined();
  for (const corner of [[40, 40], [100, 90], [160, 40]] as Array<[number, number]>) {
    expect(triangle!.points.some((p) => near(p, corner))).toBe(true);
  }
  const rectangle = closed.find((e) => e.points.length === 4);
  expect(rectangle).toBeDefined();
  for (const corner of [[30, 60], [70, 60], [70, 80], [30, 80]] as Array<[number, number]>) {
    expect(rectangle!.points.some((p) => near(p, corner))).toBe(true);
  }

  const curve = dxf.entities.find((e) => e.type === 'POLYLINE' && !e.closed);
  expect(curve).toBeDefined();
  expect(near(curve!.points[0], [50, 50])).toBe(true);
  expect(near(curve!.points[curve!.points.length - 1], [110, 50])).toBe(true);
  expect(curve!.points.length).toBeGreaterThan(4);
  const controls: Array<[number, number]> = [[50, 50], [60, 90], [100, 90], [110, 50]];
  for (const point of curve!.points) expect(distanceToCurve(point, controls)).toBeLessThan(DXF_TOLERANCE);
}

describe('PostScript sources become DXF geometry', () => {
  for (const source of ['eps', 'ps']) {
    oracleTest(`${source} -> dxf writes the lines, polygons and curve of the page at their PostScript coordinates`, ['pdftocairo'], async () => {
      await withPs2pdfShim(handWrittenPdf([DRAWING_PAGE]), async () => {
        const result = await dispatchConversion(POSTSCRIPT_SOURCE, source, 'dxf', {}, `figure.${source}`);
        expect(result.filename).toBe('figure.dxf');
        expect(result.mimeType).toBe('image/vnd.dxf');
        expectDrawingGeometry(result.buffer.toString('utf-8'));
      });
    }, NATIVE_TIMEOUT_MS);
  }

  oracleTest('LibreOffice imports the DXF and draws the same shapes at one common scale', ['pdftocairo', 'soffice'], async () => {
    await withPs2pdfShim(handWrittenPdf([DRAWING_PAGE]), async () => {
      const result = await dispatchConversion(POSTSCRIPT_SOURCE, 'ps', 'dxf', {}, 'figure.ps');
      const svg = sofficeConvert(result.buffer, 'dxf', 'svg', 'svg').toString('utf-8');
      const line = /<line [^>]*x1="(\d+)" y1="(\d+)" x2="(\d+)" y2="(\d+)"/.exec(svg);
      expect(line).not.toBeNull();
      const [x1, y1, x2] = line!.slice(1, 4).map(Number);
      // The line is 160 points long: its drawn length gives the scale of LibreOffice's drawing units.
      const scale = (x2 - x1) / 160;
      const paths = [...svg.matchAll(/<path fill="none" stroke="[^"]*" d="([^"]*)"/g)].map((match) =>
        [...match[1].matchAll(/(-?\d+),(-?\d+)/g)].map((pair) => [Number(pair[1]), Number(pair[2])])
      );
      expect(paths).toHaveLength(3);
      const box = (points: number[][]) => ({
        width: Math.max(...points.map((p) => p[0])) - Math.min(...points.map((p) => p[0])),
        height: Math.max(...points.map((p) => p[1])) - Math.min(...points.map((p) => p[1])),
        bottom: Math.max(...points.map((p) => p[1])),
      });
      const [triangle, rectangle, curve] = paths.map(box);
      const unitsTolerance = 3;
      expect(Math.abs(triangle.width - 120 * scale)).toBeLessThan(unitsTolerance);
      expect(Math.abs(triangle.height - 50 * scale)).toBeLessThan(unitsTolerance);
      expect(Math.abs(rectangle.width - 40 * scale)).toBeLessThan(unitsTolerance);
      expect(Math.abs(rectangle.height - 20 * scale)).toBeLessThan(unitsTolerance);
      expect(Math.abs(curve.width - 60 * scale)).toBeLessThan(unitsTolerance);
      // The triangle's base (PostScript y 40) lies 20 points above the line (y 20): the Y axis points up.
      expect(Math.abs(y1 - triangle.bottom - 20 * scale)).toBeLessThan(unitsTolerance);
    });
  }, NATIVE_TIMEOUT_MS);

  oracleTest('a DXF of two pages is one DXF per page in a ZIP', ['pdftocairo'], async () => {
    await withPs2pdfShim(handWrittenPdf([DRAWING_PAGE, SMALL_PAGE]), async () => {
      const result = await dispatchConversion(POSTSCRIPT_SOURCE, 'ps', 'dxf', {}, 'doc.ps');
      expect(result.filename).toBe('doc.zip');
      expect(await entriesOf(result.buffer)).toEqual(['doc-p001.dxf', 'doc-p002.dxf']);
      const zip = await JSZip.loadAsync(result.buffer);
      expectDrawingGeometry(await zip.files['doc-p001.dxf'].async('string'));
      expect(readDxf(await zip.files['doc-p002.dxf'].async('string')).entities).toHaveLength(1);
    });
  }, NATIVE_TIMEOUT_MS);

  oracleTest('a page with no vector geometry is a typed 400 error, never a stand-in line', ['pdftocairo'], async () => {
    await withPs2pdfShim(handWrittenPdf([{ width: 200, height: 100, content: '' }]), async () => {
      const run = dispatchConversion(POSTSCRIPT_SOURCE, 'eps', 'dxf', {}, 'blank.eps');
      await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
      await expect(run).rejects.not.toBeInstanceOf(EngineUnavailableError);
      await expect(run).rejects.toThrow(/no vector geometry/);
    });
  }, NATIVE_TIMEOUT_MS);

  oracleTest('a page that holds a picture cannot be written as DXF: a typed 400 error naming the element', ['pdftocairo'], async () => {
    const image: CraftObject[] = [
      { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
      { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
      { id: 3, dict: '/Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /XObject << /Im 5 0 R >> >>' },
      { id: 4, stream: Buffer.from('q 100 0 0 50 10 10 cm /Im Do Q', 'latin1') },
      { id: 5, dict: '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8', stream: Buffer.from([0, 255, 255, 0]) },
    ];
    await withPs2pdfShim(buildPdf(image, 1).buffer, async () => {
      const run = dispatchConversion(POSTSCRIPT_SOURCE, 'ps', 'dxf', {}, 'picture.ps');
      await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
      await expect(run).rejects.toThrow(/cannot be written as DXF.*<image>/);
    });
  }, NATIVE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// Presentations LibreOffice reads but this host cannot author (Keynote)
// ---------------------------------------------------------------------------

describe('a Keynote presentation becomes HTML through the PDF LibreOffice renders', () => {
  async function keynotePackage(): Promise<Buffer> {
    const zip = new JSZip();
    zip.file('index.apxl', '<?xml version="1.0"?><key:presentation xmlns:key="http://developer.apple.com/namespaces/keynote2"/>');
    return zip.generateAsync({ type: 'nodebuffer' });
  }

  oracleTest('key -> html carries the text of the rendered pages', ['pdftotext'], async () => {
    const pdf = singlePagePdf(Buffer.from(textContent('Keynote slide text'), 'latin1'), [], { contentFilter: false }).buffer;
    await withSofficeShim(pdf, async () => {
      const result = await dispatchConversion(await keynotePackage(), 'key', 'html', {}, 'deck.key');
      expect(result.filename).toBe('deck.html');
      expect(result.mimeType).toBe('text/html');
      const html = result.buffer.toString('utf-8');
      const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? '';
      const visible = normalizeWhitespace(body.replace(/<[^>]+>/g, ' '));
      expect(visible).toBe(normalizeWhitespace(extractTextWithExternalPdftotext(pdf) ?? ''));
      expect(visible).toBe('Keynote slide text');
    });
  }, NATIVE_TIMEOUT_MS);

  oracleTest('key -> html of a presentation with no text on its pages is a typed error, not an empty page', ['pdftotext'], async () => {
    const blank = handWrittenPdf([{ width: 200, height: 100, content: '0 0 1 rg 10 10 50 30 re f' }]);
    await withSofficeShim(blank, async () => {
      const run = dispatchConversion(await keynotePackage(), 'key', 'html', {}, 'deck.key');
      await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
      await expect(run).rejects.toMatchObject({ message: 'The rendered pages hold no text, so there is nothing to write as HTML.' });
    });
  }, NATIVE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// Missing engines answer with a typed 503 naming the tool
// ---------------------------------------------------------------------------

describe('a missing tool is a typed 503 error naming it', () => {
  const stillThere = () => handWrittenPdf([SMALL_PAGE]);

  it.each([
    ['eps', 'avif'], ['eps', 'bmp'], ['eps', 'dxf'], ['eps', 'eps'], ['eps', 'gif'], ['eps', 'ps'], ['eps', 'webp'],
    ['ps', 'avif'], ['ps', 'bmp'], ['ps', 'dxf'], ['ps', 'eps'], ['ps', 'gif'], ['ps', 'ps'], ['ps', 'webp'],
  ])('%s -> %s without ps2pdf', async (source, target) => {
    const run = withMissingBinary('PS2PDF_PATH', () => dispatchConversion(POSTSCRIPT_SOURCE, source, target, {}, `figure.${source}`));
    await expect(run).rejects.toBeInstanceOf(EngineUnavailableError);
    await expect(run).rejects.toMatchObject({ engineName: 'ps2pdf' });
  });

  it.each([
    ['eps', 'bmp', 'PDFTOPPM_PATH', 'pdftoppm'],
    ['ps', 'webp', 'PDFTOPPM_PATH', 'pdftoppm'],
    ['eps', 'dxf', 'PDFTOCAIRO_PATH', 'pdftocairo'],
    ['ps', 'eps', 'PDFTOPS_PATH', 'pdftops'],
    ['eps', 'ps', 'PDFTOPS_PATH', 'pdftops'],
  ])('%s -> %s without %s', async (source, target, envVar, engineName) => {
    const run = withPs2pdfShim(stillThere(), () =>
      withMissingBinary(envVar, () => dispatchConversion(POSTSCRIPT_SOURCE, source, target, {}, `figure.${source}`))
    );
    await expect(run).rejects.toBeInstanceOf(EngineUnavailableError);
    await expect(run).rejects.toMatchObject({ engineName });
  });

  const ODF_HEADER_ONLY = async (mimetype: string) => {
    const zip = new JSZip();
    zip.file('mimetype', mimetype, { compression: 'STORE' });
    zip.file('content.xml', '<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"/>');
    return zip.generateAsync({ type: 'nodebuffer' });
  };

  it.each([
    ['odg', 'bmp'], ['odd', 'avif'], ['odd', 'bmp'], ['odd', 'eps'], ['odd', 'gif'], ['odd', 'ico'],
    ['odd', 'odd'], ['odd', 'ps'], ['odd', 'psd'], ['odd', 'tiff'], ['odd', 'webp'], ['key', 'html'],
  ])('%s -> %s without LibreOffice', async (source, target) => {
    const mimetype = {
      odg: 'application/vnd.oasis.opendocument.graphics',
      odd: 'application/vnd.oasis.opendocument.graphics-template',
      key: 'application/x-iwork-keynote-sffkey',
    }[source]!;
    const input = await ODF_HEADER_ONLY(mimetype);
    const run = withMissingBinary('SOFFICE_PATH', () => dispatchConversion(input, source, target, {}, `drawing.${source}`));
    await expect(run).rejects.toBeInstanceOf(EngineUnavailableError);
    await expect(run).rejects.toMatchObject({ engineName: 'soffice' });
  });
});

// ---------------------------------------------------------------------------
// The real interpreter (Ghostscript is AGPL-licensed and is not in the CI image until its licence review is done)
// ---------------------------------------------------------------------------

const REAL_EPS = Buffer.from(
  [
    '%!PS-Adobe-3.0 EPSF-3.0',
    '%%BoundingBox: 0 0 200 100',
    '%%EndComments',
    '1 0 0 setrgbcolor 2 setlinewidth',
    'newpath 20 20 moveto 180 20 lineto stroke',
    '0 0 1 setrgbcolor 1 setlinewidth',
    'newpath 40 40 moveto 100 90 lineto 160 40 lineto closepath stroke',
    '0 0.5 0 setrgbcolor',
    '30 60 40 20 rectfill',
    '0 0 0 setrgbcolor',
    'newpath 50 50 moveto 60 90 100 90 110 50 curveto stroke',
    'showpage',
    '',
  ].join('\n'),
  'latin1'
);

const REAL_TWO_PAGE_PS = Buffer.from(
  [
    '%!PS-Adobe-3.0',
    '%%Pages: 2',
    '%%EndComments',
    '<< /PageSize [200 100] >> setpagedevice',
    '1 0 0 setrgbcolor 10 10 50 30 rectfill',
    'showpage',
    '<< /PageSize [300 150] >> setpagedevice',
    '0 1 0 setrgbcolor 20 20 60 40 rectfill',
    'showpage',
    '',
  ].join('\n'),
  'latin1'
);

describe('PostScript against the real interpreter', () => {
  // Ghostscript is licensed under the AGPL and is not part of the CI image until the licence review accepts
  // it, so these checks run wherever it is installed and are skipped, by name, where it is not.
  it.skipIf(!HAS_PS2PDF)('eps -> png is the size of the bounding box, not of a default paper page', async () => {
    const result = await dispatchConversion(REAL_EPS, 'eps', 'png', {}, 'figure.eps');
    const decoded = identifyBytes(result.buffer, 'png');
    const expected = pagePixels({ width: 200, height: 100 });
    expect(Math.abs(decoded.width - expected.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(decoded.height - expected.height)).toBeLessThanOrEqual(1);
  }, NATIVE_TIMEOUT_MS);

  it.skipIf(!HAS_PS2PDF)('eps -> dxf holds the geometry of the PostScript path', async () => {
    const result = await dispatchConversion(REAL_EPS, 'eps', 'dxf', {}, 'figure.eps');
    expectDrawingGeometry(result.buffer.toString('utf-8'));
  }, NATIVE_TIMEOUT_MS);

  it.skipIf(!HAS_PS2PDF)('eps -> eps is an EPS that rasterises like the source (ImageMagick through Ghostscript)', async () => {
    const result = await dispatchConversion(REAL_EPS, 'eps', 'eps', {}, 'figure.eps');
    const text = result.buffer.toString('latin1');
    expect(text.split('\n')[0]).toBe('%!PS-Adobe-3.0 EPSF-3.0');
    expect(/%%BoundingBox: (\d+) (\d+) (\d+) (\d+)/.exec(text)?.slice(1).map(Number)).toEqual([0, 0, 200, 100]);
    const rasterise = (data: Buffer) =>
      inTempDir((dir) => {
        fs.writeFileSync(path.join(dir, 'in.eps'), data);
        runConvert(['-density', String(POPPLER_DPI), path.join(dir, 'in.eps'), '-background', 'white', '-flatten', path.join(dir, 'out.png')]);
        return decodeRgba(fs.readFileSync(path.join(dir, 'out.png')), 'png');
      });
    const reference = rasterise(REAL_EPS);
    const converted = rasterise(result.buffer);
    expect(converted.width).toBe(reference.width);
    expect(converted.height).toBe(reference.height);
    let total = 0;
    for (let i = 0; i < reference.data.length; i += 1) total += Math.abs(reference.data[i] - converted.data[i]);
    expect(total / reference.data.length).toBeLessThan(RENDERER_MEAN_DIFF_MAX);
  }, NATIVE_TIMEOUT_MS);

  it.skipIf(!HAS_PS2PDF)('a two-page PostScript file keeps both pages, each at its own size, as bmp and as PostScript', async () => {
    const bmp = await dispatchConversion(REAL_TWO_PAGE_PS, 'ps', 'bmp', {}, 'doc.ps');
    expect(await entriesOf(bmp.buffer)).toEqual(['doc-p001.bmp', 'doc-p002.bmp']);
    const zip = await JSZip.loadAsync(bmp.buffer);
    const sizes = await Promise.all(['doc-p001.bmp', 'doc-p002.bmp'].map(async (e) => identifyBytes(await zip.files[e].async('nodebuffer'), 'bmp')));
    for (const [index, page] of [{ width: 200, height: 100 }, { width: 300, height: 150 }].entries()) {
      const expected = pagePixels(page);
      expect(Math.abs(sizes[index].width - expected.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(sizes[index].height - expected.height)).toBeLessThanOrEqual(1);
    }
    const ps = await dispatchConversion(REAL_TWO_PAGE_PS, 'ps', 'ps', {}, 'doc.ps');
    expect(ps.buffer.toString('latin1')).toContain('%%Pages: 2\n');
  }, NATIVE_TIMEOUT_MS);
});
