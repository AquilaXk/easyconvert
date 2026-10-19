import { describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { JOB_DEADLINE_AT, type JobDeadlined, stageTimeoutMs } from '../src/lib/conversions/job-time';
import { OFFICE_PAGE_IMAGE_MAX_PAGES } from '../src/lib/conversions/page-range';
import { PayloadLimitError } from '../src/lib/types';
import { OFFICE_PAGE_CHAIN_STAGE_TIMEOUT_MS, withOfficePageBounds } from '../src/worker/office-suite-route';
import type { WorkerEngineOptions } from '../src/worker/worker-types';
import { oracleTest } from './helpers/oracle-test';
import { requireRealworldSample } from './helpers/realworld-sample';
import { flatOdp, flatOdt, sofficeConvert } from './helpers/soffice-office';
import { expectSamePixels, pagesOfZip, pdfPageCount, referencePages, suitePdf } from './helpers/suite-page-images';

/**
 * A document that becomes page images is printed by the office suite and rasterised page by page, as a workbook is
 * (`spreadsheet-page-images.test.ts`). The nightly real-file run 39316523318 gave `govdocs1-010383.rtf` (an 8 MB report that
 * prints 4,181 pages with LibreOffice 24.2 on macOS and 4,874 on Ubuntu 24.04) to JPEG: the request drew every page and
 * packed 505 to 595 MB of JPEG pages (63 s on a quiet machine, 82 s on the Linux testbed) and passed the 180 s deadline on a
 * shared runner, although the same file converts to every other target in under a second. A request now renders at most
 * `OFFICE_PAGE_IMAGE_MAX_PAGES` pages whatever the source application and refuses a longer document with a 413 that names
 * the limit and the ways out. The oracles are not the converter: the office suite's own PDF of the same file, whose pages `pdftoppm`
 * draws at the density the product uses, and `pdfinfo` for the page counts.
 */

const TEST_TIMEOUT_MS = 900_000;
const TOOLS = ['soffice', 'pdfinfo', 'pdftoppm'] as const;
const HTTP_PAYLOAD_TOO_LARGE = 413;
/** Lines that print on more pages than the limit with room to spare (about 45 lines fit on a page). */
const LINES_BEYOND_THE_LIMIT = 40_000;
/** Slides beyond the limit: one page each. */
const SLIDES_BEYOND_THE_LIMIT = OFFICE_PAGE_IMAGE_MAX_PAGES + 20;
const LONG_DOCUMENT_ID = 'govdocs1-010383.rtf';
const IMAGE_TARGETS = ['jpg', 'png'] as const;

let longTextBytes: Buffer | undefined;

/** An OpenDocument text of one line per paragraph, written by the office suite from flat XML, that prints on more pages than the limit. */
function longText(): Buffer {
  longTextBytes ??= sofficeConvert(flatOdt(Array.from({ length: LINES_BEYOND_THE_LIMIT }, (_, line) => `line ${line + 1}`)), 'fodt', 'odt', 'odt');
  return longTextBytes;
}

async function refusalOf(input: Buffer, source: string, target: string, name: string): Promise<PayloadLimitError> {
  const refusal = await dispatchConversion(input, source, target, {}, name).catch((error: unknown) => error);
  expect(refusal).toBeInstanceOf(PayloadLimitError);
  return refusal as PayloadLimitError;
}

describe('the page bounds of a request that becomes page images', () => {
  it('limit the pages of every office application, and cut the PDF export to page 1 for a workbook only', () => {
    for (const source of ['docx', 'rtf', 'odt', 'pptx', 'odp', 'xlsx', 'ods']) {
      expect(withOfficePageBounds(source, {}).maxRenderedPages, source).toBe(OFFICE_PAGE_IMAGE_MAX_PAGES);
    }
    expect(withOfficePageBounds('docx', { multiPageOutput: 'first' }).pdfExportPageRange).toBeUndefined();
    expect(withOfficePageBounds('xlsx', { multiPageOutput: 'first' }).pdfExportPageRange).toBe('1');
  });

  it('give each stage of the chain the time a long document needs, held to what the job has left and to a limit the server set', () => {
    const now = Date.now();
    const DEFAULT_STAGE_MS = 45_000;
    const STAGE_LIMIT_MS = 120_000;
    expect(OFFICE_PAGE_CHAIN_STAGE_TIMEOUT_MS).toBe(STAGE_LIMIT_MS);
    expect(stageTimeoutMs(withOfficePageBounds('rtf', {}), DEFAULT_STAGE_MS, now)).toBe(STAGE_LIMIT_MS);
    const remaining = 50_000;
    const nearDeadline: WorkerEngineOptions & JobDeadlined = { [JOB_DEADLINE_AT]: now + remaining };
    expect(stageTimeoutMs(withOfficePageBounds('rtf', nearDeadline), DEFAULT_STAGE_MS, now)).toBe(remaining);
    expect(stageTimeoutMs(withOfficePageBounds('rtf', { timeoutMs: 30_000 }), DEFAULT_STAGE_MS, now)).toBe(30_000);
  });

  it('keep the other options of the request', () => {
    expect(withOfficePageBounds('docx', { multiPageOutput: 'first', pages: '2-3' })).toMatchObject({
      multiPageOutput: 'first',
      pages: '2-3',
      maxRenderedPages: OFFICE_PAGE_IMAGE_MAX_PAGES,
    });
  });
});

describe('a document to page images', () => {
  oracleTest(
    'a text that prints more pages than the limit is refused with a 413 that names the page count, the limit and the ways out',
    [...TOOLS],
    async () => {
      const document = longText();
      const printedPages = pdfPageCount(suitePdf(document, 'odt'));
      expect(printedPages).toBeGreaterThan(OFFICE_PAGE_IMAGE_MAX_PAGES);
      for (const target of IMAGE_TARGETS) {
        const refusal = await refusalOf(document, 'odt', target, 'long.odt');
        expect(refusal.status).toBe(HTTP_PAYLOAD_TOO_LARGE);
        expect(refusal.message).toContain(`${printedPages} pages`);
        expect(refusal.message).toContain(`at most ${OFFICE_PAGE_IMAGE_MAX_PAGES}`);
        expect(refusal.message).toContain('multiPageOutput');
      }
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'multiPageOutput "first" returns the one page 1 image the suite prints, and "pages" the pages asked for, from a text beyond the limit',
    [...TOOLS],
    async () => {
      const document = longText();
      const [firstPage, secondPage, thirdPage] = referencePages(suitePdf(document, 'odt'), 1, 3);
      const first = await dispatchConversion(document, 'odt', 'png', { multiPageOutput: 'first' }, 'long.odt');
      expect(first.filename.endsWith('.png')).toBe(true);
      await expectSamePixels(first.buffer, firstPage, 'page 1');
      const selected = await dispatchConversion(document, 'odt', 'png', { pages: '2-3' }, 'long.odt');
      const pages = await pagesOfZip(selected.buffer);
      expect(pages).toHaveLength(2);
      await expectSamePixels(pages[0], secondPage, 'page 2');
      await expectSamePixels(pages[1], thirdPage, 'page 3');
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'a presentation of more slides than the limit is refused the same way',
    [...TOOLS],
    async () => {
      const slides = Array.from({ length: SLIDES_BEYOND_THE_LIMIT }, (_, slide) => [`slide ${slide + 1}`]);
      const presentation = sofficeConvert(flatOdp(slides), 'fodp', 'odp', 'odp');
      expect(pdfPageCount(suitePdf(presentation, 'odp'))).toBe(SLIDES_BEYOND_THE_LIMIT);
      const refusal = await refusalOf(presentation, 'odp', 'png', 'long.odp');
      expect(refusal.status).toBe(HTTP_PAYLOAD_TOO_LARGE);
      expect(refusal.message).toContain(`${SLIDES_BEYOND_THE_LIMIT} pages`);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    `${LONG_DOCUMENT_ID} of the nightly corpus is refused by name to JPEG and PNG, and its first page is the suite's page 1`,
    [...TOOLS],
    async (ctx) => {
      const sample = await requireRealworldSample(ctx, LONG_DOCUMENT_ID);
      const suite = suitePdf(sample.bytes, sample.format);
      const printedPages = pdfPageCount(suite);
      expect(printedPages).toBeGreaterThan(OFFICE_PAGE_IMAGE_MAX_PAGES);
      for (const target of IMAGE_TARGETS) {
        const refusal = await refusalOf(sample.bytes, sample.format, target, LONG_DOCUMENT_ID);
        expect(refusal.message).toContain(`${printedPages} pages`);
        expect(refusal.message).toContain(`at most ${OFFICE_PAGE_IMAGE_MAX_PAGES}`);
      }
      const first = await dispatchConversion(sample.bytes, sample.format, 'png', { multiPageOutput: 'first' }, LONG_DOCUMENT_ID);
      await expectSamePixels(first.buffer, referencePages(suite, 1, 1)[0], `${LONG_DOCUMENT_ID} page 1`);
    },
    TEST_TIMEOUT_MS
  );
});
