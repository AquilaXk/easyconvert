import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recognizeRenderedPdfPages, shutdownOcrWorkerPool } from '../src/lib/conversions/ocr';
import {
  OCR_ALLOWANCE_PAGES,
  OCR_JOB_DEADLINE_SHARE,
  OCR_PAGE_BUDGET_ENV,
  OCR_PAGE_BUDGET_MS,
  OCR_PAGE_GUARD_PAGES,
  ocrDocumentBudgetMs,
  ocrPageBudgetMs,
  OcrWorkLimitError,
} from '../src/lib/conversions/ocr-work-budget';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { PayloadLimitError } from '../src/lib/types';
import { requireTessdata } from './helpers/ocr-fixtures';
import { oracleTest } from './helpers/oracle-test';
import { expectNoHangOnInput } from './helpers/timing';

/**
 * A scanned page costs the same however long the document is, so the OCR budget of a document grows with its pages
 * (a start-up allowance plus one page budget for each) and each page has a limit of its own. These cases shrink the
 * page budget with the environment override so that the outcome does not depend on how fast the machine is: 40 pages
 * of text cannot be read in that time on any machine.
 */

const TEST_TIMEOUT_MS = 120_000;
const TINY_PAGE_BUDGET_MS = 100;
/** The page limit plus the time to start the engine and to remove the render directory. */
const BUDGET_SLACK_MS = 12_000;
const LONG_DOCUMENT_PAGES = 40;
const LINES_PER_PAGE = 28;
const SENTENCE = 'The committee reviewed the quarterly report and approved the budget for the regional water project';

afterEach(async () => {
  vi.unstubAllEnvs();
  await shutdownOcrWorkerPool();
});

async function textPages(pageCount: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let page = 0; page < pageCount; page++) {
    const sheet = doc.addPage([612, 792]);
    for (let line = 0; line < LINES_PER_PAGE; line++) {
      sheet.drawText(`${SENTENCE} (page ${page + 1}, line ${line + 1}).`, { x: 36, y: 750 - line * 24, size: 11, font });
    }
  }
  return Buffer.from(await doc.save());
}

describe('the OCR work budget of one document', () => {
  it('is a named setting, with the budget of a page well above what a page of the real-world scans costs', () => {
    expect(OCR_PAGE_BUDGET_ENV).toBe('EASYCONVERT_OCR_PAGE_BUDGET_MS');
    // Measured on the 300 dpi CCITT scans of the real-world corpus, one page at a time: 1.0 to 1.5 s at the median and
    // 4.4 s at most on a 12-core machine. Twice the worst page, so that a slower, shared runner stays inside.
    expect(OCR_PAGE_BUDGET_MS).toBe(10_000);
    expect(OCR_PAGE_BUDGET_MS).toBeGreaterThanOrEqual(2 * 4_400);
    expect(OCR_PAGE_GUARD_PAGES * OCR_PAGE_BUDGET_MS).toBeLessThanOrEqual(60_000);
  });

  it('grows with the pages of the document, by an allowance and one page budget for each', () => {
    expect(ocrDocumentBudgetMs(1)).toBe((OCR_ALLOWANCE_PAGES + 1) * OCR_PAGE_BUDGET_MS);
    expect(ocrDocumentBudgetMs(70)).toBe(730_000);
    expect(ocrDocumentBudgetMs(500)).toBe(5_030_000);
    expect(ocrDocumentBudgetMs(500)).toBeGreaterThan(ocrDocumentBudgetMs(70));
  });

  it('never goes past the job deadline, and leaves the output a tenth of it', () => {
    expect(ocrDocumentBudgetMs(500, 180_000)).toBe(Math.floor(180_000 * OCR_JOB_DEADLINE_SHARE));
    expect(ocrDocumentBudgetMs(1, 3_600_000)).toBe((OCR_ALLOWANCE_PAGES + 1) * OCR_PAGE_BUDGET_MS);
    expect(ocrDocumentBudgetMs(500, 0)).toBe(ocrDocumentBudgetMs(500));
  });

  it('takes a non-positive or unreadable override as unset, so a mistyped value never lifts the limit', () => {
    for (const value of ['0', '-5', 'abc', '', '1.5']) {
      vi.stubEnv(OCR_PAGE_BUDGET_ENV, value);
      expect(ocrPageBudgetMs(), JSON.stringify(value)).toBe(OCR_PAGE_BUDGET_MS);
    }
    vi.stubEnv(OCR_PAGE_BUDGET_ENV, '4500');
    expect(ocrPageBudgetMs()).toBe(4_500);
    expect(ocrDocumentBudgetMs(10)).toBe((OCR_ALLOWANCE_PAGES + 10) * 4_500);
  });

  oracleTest(
    'refuses a long document whose pages are slow with a typed 413 inside the page limit, not after every page has been read',
    ['tesseract', 'pdftoppm'],
    async () => {
      requireTessdata('eng');
      const pdf = await textPages(LONG_DOCUMENT_PAGES);
      vi.stubEnv(OCR_PAGE_BUDGET_ENV, String(TINY_PAGE_BUDGET_MS));
      const outcome = await expectNoHangOnInput(
        `${LONG_DOCUMENT_PAGES} pages with a ${TINY_PAGE_BUDGET_MS} ms page budget`,
        (input: Buffer) => recognizeRenderedPdfPages(input, undefined, {}).then(
          () => null,
          (error: unknown) => error
        ),
        pdf,
        ocrDocumentBudgetMs(LONG_DOCUMENT_PAGES) + BUDGET_SLACK_MS
      );
      const error = outcome.largeResult;
      expect(error).toBeInstanceOf(OcrWorkLimitError);
      expect(error).toBeInstanceOf(PayloadLimitError);
      expect(error).toMatchObject({ name: 'OcrWorkLimitError', status: 413 });
      expect((error as Error).message).toContain(OCR_PAGE_BUDGET_ENV);
    },
    TEST_TIMEOUT_MS
  );

  // The text targets all read a scanned PDF through the same OCR; the refusal must reach the caller as the typed 413,
  // not as a generic failure. OCR is forced so that the pages, which carry text here, are read as images.
  it.each(['txt', 'docx', 'pdf'])('reaches the caller of a %s conversion as the typed 413', async (target) => {
    requireTessdata('eng');
    const pdf = await textPages(LONG_DOCUMENT_PAGES);
    vi.stubEnv(OCR_PAGE_BUDGET_ENV, String(TINY_PAGE_BUDGET_MS));
    const outcome = await expectNoHangOnInput(
      `${LONG_DOCUMENT_PAGES} pages to ${target} with a ${TINY_PAGE_BUDGET_MS} ms page budget`,
      (input: Buffer) => dispatchConversion(input, 'pdf', target, { ocrEnabled: true, ocrMode: 'force' }, 'long.pdf').then(
        () => null,
        (error: unknown) => error
      ),
      pdf,
      ocrDocumentBudgetMs(LONG_DOCUMENT_PAGES) + BUDGET_SLACK_MS
    );
    expect(outcome.largeResult).toBeInstanceOf(OcrWorkLimitError);
    expect(outcome.largeResult).toMatchObject({ status: 413 });
  }, TEST_TIMEOUT_MS);

  oracleTest(
    'reads a short document in full under the default budget, every page in order',
    ['tesseract', 'pdftoppm'],
    async () => {
      requireTessdata('eng');
      const pages = 3;
      const recognized = await recognizeRenderedPdfPages(await textPages(pages), undefined, {});
      expect([...recognized.keys()]).toEqual([1, 2, 3]);
      for (const [pageNumber, result] of recognized) {
        const words = result.text.replace(/\s+/g, ' ');
        expect(words, `page ${pageNumber}`).toContain('committee reviewed the quarterly report');
        expect(words, `page ${pageNumber}`).toMatch(new RegExp(`page ${pageNumber}, line 1\\b`));
      }
    },
    TEST_TIMEOUT_MS
  );
});
