import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { PayloadLimitError } from '../src/lib/types';
import { SPREADSHEET_IMAGE_MAX_PAGES } from '../src/lib/conversions/page-range';
import { resolveLibreOfficeFilter } from '../src/worker/libreoffice-pool';
import { requireOracleTool } from './helpers/differential-oracle';
import { decodeRgba, maxSampleDifference, type DecodedRgba } from './helpers/image-pixels';
import { oracleTest } from './helpers/oracle-test';
import { flatOds } from './helpers/office-pair-fixtures';
import { requireRealworldSample } from './helpers/realworld-sample';
import { sofficeConvert } from './helpers/soffice-office';

/**
 * A spreadsheet that becomes page images is printed by the office suite and rasterised page by page. The pages of a real
 * worksheet are an artefact of its used range: nightly real-file run 39012667333 found workbooks of 900 to 4,600 printed
 * pages (PDF export 3 to 7 s, then about 50 ms and 0.5 MB a page), so the request spent minutes drawing pages and passed the
 * 180 s deadline on a shared runner. A request now renders at most `SPREADSHEET_IMAGE_MAX_PAGES` pages and refuses a larger sheet with a 413
 * that names the limit and the two ways out (`pages`, `multiPageOutput: "first"`). Readers other than the converter judge
 * the output: the office suite's own PDF of the same file, whose pages `pdftoppm` draws at the density the product uses, and
 * `pdfinfo` for the page counts.
 */

const TEST_TIMEOUT_MS = 600_000;
const TOOLS = ['soffice', 'pdfinfo', 'pdftoppm'] as const;
const RENDER_DPI = '150';
const HTTP_PAYLOAD_TOO_LARGE = 413;
/** Rows that print on more pages than the limit with room to spare (about 50 rows fit on a page). */
const ROWS_BEYOND_THE_LIMIT = 40_000;
const BENCH_WORKBOOK = path.join(__dirname, '..', 'bench', 'corpus', 'office', 'workbook.xlsx');
const BENCH_WORKBOOK_PAGES = 2;
/** Real worksheets whose printed ranges the nightly run found beyond any deadline (digests pinned by bench/realworld/manifest.json). */
const REAL_WORKSHEETS = ['govdocs1-005540.xls', 'office-spreadsheet-no_drawing_patriarch.xlsx'] as const;

function withTempDir<T>(run: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-pages-'));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The pages of `pdf` as the page chain draws them: `pdftoppm -png` at the product's density, `first` to `last` inclusive. */
function referencePages(pdf: Buffer, first: number, last: number): Buffer[] {
  return withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'in.pdf'), pdf);
    execFileSync(requireOracleTool('pdftoppm'), ['-r', RENDER_DPI, '-png', '-f', String(first), '-l', String(last), path.join(dir, 'in.pdf'), path.join(dir, 'page')]);
    return fs
      .readdirSync(dir)
      .filter((name) => name.startsWith('page-'))
      .sort((a, b) => a.localeCompare(b))
      .map((name) => fs.readFileSync(path.join(dir, name)));
  });
}

function pdfPageCount(pdf: Buffer): number {
  return withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'in.pdf'), pdf);
    const info = execFileSync(requireOracleTool('pdfinfo'), [path.join(dir, 'in.pdf')], { encoding: 'utf-8' });
    return Number(/^Pages:\s+(\d+)/m.exec(info)?.[1]);
  });
}

/** The office suite's own PDF of a spreadsheet: the truth for the page count and for the pixels of every page. */
function suitePdf(sheet: Buffer, extension: string): Buffer {
  return sofficeConvert(sheet, extension, 'pdf', 'pdf');
}

let longSheetBytes: Buffer | undefined;

/** An OpenDocument spreadsheet of one column pair, written by the office suite from flat XML, that prints on more pages than the limit. */
function longSheet(): Buffer {
  longSheetBytes ??= sofficeConvert(flatOds(Array.from({ length: ROWS_BEYOND_THE_LIMIT }, (_, row) => [`row ${row + 1}`, `${row + 1}`])), 'fods', 'ods', 'ods');
  return longSheetBytes;
}

async function expectSamePixels(actual: Buffer, expected: Buffer, label: string): Promise<void> {
  const [got, want] = await Promise.all([decodeRgba(actual), decodeRgba(expected)]);
  expect({ label, width: got.width, height: got.height }).toEqual({ label, width: want.width, height: want.height });
  expect({ label, difference: maxSampleDifference(got, want) }).toEqual({ label, difference: 0 });
  expect(inkedSamples(got), `${label} is not a blank page`).toBeGreaterThan(0);
}

/** Samples of a picture that are not white: a blank page has none. */
function inkedSamples(picture: DecodedRgba): number {
  let inked = 0;
  for (let i = 0; i < picture.data.length; i += 4) {
    if (picture.data[i] !== 255 || picture.data[i + 1] !== 255 || picture.data[i + 2] !== 255) inked += 1;
  }
  return inked;
}

async function pagesOfZip(zipBytes: Buffer): Promise<Buffer[]> {
  const zip = await JSZip.loadAsync(zipBytes);
  const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir).sort((a, b) => a.localeCompare(b));
  return Promise.all(names.map((name) => zip.files[name].async('nodebuffer')));
}

describe('the PDF export of a spreadsheet that becomes the first page image', () => {
  it('writes only page 1 when asked, and leaves the default export of every page unchanged', () => {
    const everyPage = resolveLibreOfficeFilter('pdf', 'xlsx');
    expect(everyPage).not.toContain('PageRange');
    const firstPage = resolveLibreOfficeFilter('pdf', 'xlsx', { pdfExportPageRange: '1' });
    expect(firstPage.startsWith('pdf:calc_pdf_Export:')).toBe(true);
    expect(JSON.parse(firstPage.slice('pdf:calc_pdf_Export:'.length))).toMatchObject({ PageRange: { type: 'string', value: '1' } });
  });
});

describe('a spreadsheet to page images', () => {
  oracleTest(
    'a workbook within the limit still comes back as the ZIP of every page, each page the suite prints',
    [...TOOLS],
    async () => {
      const workbook = fs.readFileSync(BENCH_WORKBOOK);
      const reference = referencePages(suitePdf(workbook, 'xlsx'), 1, BENCH_WORKBOOK_PAGES);
      expect(reference).toHaveLength(BENCH_WORKBOOK_PAGES);
      const result = await dispatchConversion(workbook, 'xlsx', 'png', {}, 'workbook.xlsx');
      const pages = await pagesOfZip(result.buffer);
      expect(pages).toHaveLength(BENCH_WORKBOOK_PAGES);
      for (const [index, page] of pages.entries()) await expectSamePixels(page, reference[index], `workbook page ${index + 1}`);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'a sheet that prints more pages than the limit is refused with a 413 that names the limit and the ways out',
    [...TOOLS],
    async () => {
      const sheet = longSheet();
      const printedPages = pdfPageCount(suitePdf(sheet, 'ods'));
      expect(printedPages).toBeGreaterThan(SPREADSHEET_IMAGE_MAX_PAGES);
      const refusal = await dispatchConversion(sheet, 'ods', 'png', {}, 'long.ods').catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(PayloadLimitError);
      expect((refusal as PayloadLimitError).status).toBe(HTTP_PAYLOAD_TOO_LARGE);
      const message = (refusal as PayloadLimitError).message;
      expect(message).toContain(`${printedPages} pages`);
      expect(message).toContain(`at most ${SPREADSHEET_IMAGE_MAX_PAGES}`);
      expect(message).toContain('multiPageOutput');
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'multiPageOutput "first" returns the one page 1 image the suite prints, and "pages" the pages asked for, from a sheet beyond the limit',
    [...TOOLS],
    async () => {
      const sheet = longSheet();
      const pdf = suitePdf(sheet, 'ods');
      const [firstPage, secondPage, thirdPage] = referencePages(pdf, 1, 3);
      const first = await dispatchConversion(sheet, 'ods', 'png', { multiPageOutput: 'first' }, 'long.ods');
      expect(first.filename.endsWith('.png')).toBe(true);
      await expectSamePixels(first.buffer, firstPage, 'page 1');
      const selected = await dispatchConversion(sheet, 'ods', 'png', { pages: '2-3' }, 'long.ods');
      const pages = await pagesOfZip(selected.buffer);
      expect(pages).toHaveLength(2);
      await expectSamePixels(pages[0], secondPage, 'page 2');
      await expectSamePixels(pages[1], thirdPage, 'page 3');
    },
    TEST_TIMEOUT_MS
  );

  describe('real worksheets of the nightly corpus', () => {
    for (const id of REAL_WORKSHEETS) {
      oracleTest(
        `${id} is refused by name with a 413 and its first page is the suite's page 1`,
        [...TOOLS],
        async (ctx) => {
          const sample = await requireRealworldSample(ctx, id);
          const suite = suitePdf(sample.bytes, sample.format);
          expect(pdfPageCount(suite)).toBeGreaterThan(SPREADSHEET_IMAGE_MAX_PAGES);
          const refusal = await dispatchConversion(sample.bytes, sample.format, 'png', {}, id).catch((error: unknown) => error);
          expect(refusal).toBeInstanceOf(PayloadLimitError);
          const first = await dispatchConversion(sample.bytes, sample.format, 'png', { multiPageOutput: 'first' }, id);
          await expectSamePixels(first.buffer, referencePages(suite, 1, 1)[0], `${id} page 1`);
        },
        TEST_TIMEOUT_MS
      );
    }
  });
});
