import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { PayloadLimitError } from '../src/lib/types';
import { OFFICE_PAGE_IMAGE_MAX_PAGES } from '../src/lib/conversions/page-range';
import { resolveLibreOfficeFilter } from '../src/worker/libreoffice-pool';
import { withOfficePageBounds } from '../src/worker/office-suite-route';
import { oracleTest } from './helpers/oracle-test';
import { flatOds } from './helpers/office-pair-fixtures';
import { requireRealworldSample } from './helpers/realworld-sample';
import { sofficeConvert } from './helpers/soffice-office';
import { expectSamePixels, pagesOfZip, pdfPageCount, referencePages, suitePdf } from './helpers/suite-page-images';

/**
 * A spreadsheet that becomes page images is printed by the office suite and rasterised page by page. The pages of a real
 * worksheet are an artefact of its used range: nightly real-file run 39012667333 found workbooks of 900 to 4,600 printed
 * pages (PDF export 3 to 7 s, then about 50 ms and 0.5 MB a page), so the request spent minutes drawing pages and passed the
 * 180 s deadline on a shared runner. A request now renders at most `OFFICE_PAGE_IMAGE_MAX_PAGES` pages and refuses a larger sheet with a 413
 * that names the limit and the two ways out (`pages`, `multiPageOutput: "first"`). Readers other than the converter judge
 * the output: the office suite's own PDF of the same file, whose pages `pdftoppm` draws at the density the product uses, and
 * `pdfinfo` for the page counts.
 */

const TEST_TIMEOUT_MS = 600_000;
const TOOLS = ['soffice', 'pdfinfo', 'pdftoppm'] as const;
const HTTP_PAYLOAD_TOO_LARGE = 413;
/** Rows that print on more pages than the limit with room to spare (about 50 rows fit on a page). */
const ROWS_BEYOND_THE_LIMIT = 40_000;
const BENCH_WORKBOOK = path.join(__dirname, '..', 'bench', 'corpus', 'office', 'workbook.xlsx');
const BENCH_WORKBOOK_PAGES = 2;
/** Real worksheets whose printed ranges the nightly run found beyond any deadline (digests pinned by bench/realworld/manifest.json). */
const REAL_WORKSHEETS = ['govdocs1-005540.xls', 'office-spreadsheet-no_drawing_patriarch.xlsx'] as const;

let longSheetBytes: Buffer | undefined;

/** An OpenDocument spreadsheet of one column pair, written by the office suite from flat XML, that prints on more pages than the limit. */
function longSheet(): Buffer {
  longSheetBytes ??= sofficeConvert(flatOds(Array.from({ length: ROWS_BEYOND_THE_LIMIT }, (_, row) => [`row ${row + 1}`, `${row + 1}`])), 'fods', 'ods', 'ods');
  return longSheetBytes;
}

describe('the PDF export of a spreadsheet that becomes the first page image', () => {
  it('writes only page 1 when asked, and leaves the default export of every page unchanged', () => {
    const everyPage = resolveLibreOfficeFilter('pdf', 'xlsx');
    expect(everyPage).not.toContain('PageRange');
    const firstPage = resolveLibreOfficeFilter('pdf', 'xlsx', { pdfExportPageRange: '1' });
    expect(firstPage.startsWith('pdf:calc_pdf_Export:')).toBe(true);
    expect(JSON.parse(firstPage.slice('pdf:calc_pdf_Export:'.length))).toMatchObject({ PageRange: { type: 'string', value: '1' } });
  });

  it('is asked for by the spreadsheet bounds only for the first page of a request without a page selection', () => {
    expect(withOfficePageBounds('xlsx', { multiPageOutput: 'first' })).toMatchObject({
      pdfExportPageRange: '1',
      maxRenderedPages: OFFICE_PAGE_IMAGE_MAX_PAGES,
    });
    expect(withOfficePageBounds('ods', { multiPageOutput: 'first', pages: '2-3' }).pdfExportPageRange).toBeUndefined();
    expect(withOfficePageBounds('xls', {})).toMatchObject({ pdfExportPageRange: undefined, maxRenderedPages: OFFICE_PAGE_IMAGE_MAX_PAGES });
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
      expect(printedPages).toBeGreaterThan(OFFICE_PAGE_IMAGE_MAX_PAGES);
      const refusal = await dispatchConversion(sheet, 'ods', 'png', {}, 'long.ods').catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(PayloadLimitError);
      expect((refusal as PayloadLimitError).status).toBe(HTTP_PAYLOAD_TOO_LARGE);
      const message = (refusal as PayloadLimitError).message;
      expect(message).toContain(`${printedPages} pages`);
      expect(message).toContain(`at most ${OFFICE_PAGE_IMAGE_MAX_PAGES}`);
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
          expect(pdfPageCount(suite)).toBeGreaterThan(OFFICE_PAGE_IMAGE_MAX_PAGES);
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
