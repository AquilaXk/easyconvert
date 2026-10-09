import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recognizeRenderedPdfPages, shutdownOcrWorkerPool } from '../src/lib/conversions/ocr';
import { OCR_DOCUMENT_DEADLINE_ENV, OCR_DOCUMENT_DEADLINE_MS, OcrWorkLimitError } from '../src/lib/conversions/ocr-work-budget';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { PayloadLimitError } from '../src/lib/types';
import { requireTessdata } from './helpers/ocr-fixtures';
import { oracleTest } from './helpers/oracle-test';
import { expectNoHangOnInput } from './helpers/timing';

/**
 * Scanned documents cost the same per page however long they are (render, read, sometimes a second read), so a long
 * one is bounded by a work budget for the whole document instead of by whoever kills the job. The budget is a
 * wall-clock figure; these cases shrink it with the environment override so that the outcome does not depend on how
 * fast the machine is: a document of this many pages cannot be read in the shortened budget on any machine.
 */

const TEST_TIMEOUT_MS = 120_000;
const SHORT_BUDGET_MS = 1_500;
/** The budget plus the time to finish the pages in flight and to remove the render directory. */
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
  it('is far above what a normal scanned document needs, and is a named setting', () => {
    expect(OCR_DOCUMENT_DEADLINE_ENV).toBe('EASYCONVERT_OCR_DEADLINE_MS');
    // Below the 180 s a caller waits for a conversion, above the roughly 40 s a 70-page scan takes on a 12-core machine.
    expect(OCR_DOCUMENT_DEADLINE_MS).toBeGreaterThanOrEqual(120_000);
    expect(OCR_DOCUMENT_DEADLINE_MS).toBeLessThan(180_000);
  });

  oracleTest(
    'refuses a long document with a typed 413 inside the budget, not after every page has been read',
    ['tesseract', 'pdftoppm'],
    async () => {
      requireTessdata('eng');
      const pdf = await textPages(LONG_DOCUMENT_PAGES);
      vi.stubEnv(OCR_DOCUMENT_DEADLINE_ENV, String(SHORT_BUDGET_MS));
      const outcome = await expectNoHangOnInput(
        `${LONG_DOCUMENT_PAGES} pages with a ${SHORT_BUDGET_MS} ms budget`,
        (input: Buffer) => recognizeRenderedPdfPages(input, undefined, {}).then(
          () => null,
          (error: unknown) => error
        ),
        pdf,
        SHORT_BUDGET_MS + BUDGET_SLACK_MS
      );
      const error = outcome.largeResult;
      expect(error).toBeInstanceOf(OcrWorkLimitError);
      expect(error).toBeInstanceOf(PayloadLimitError);
      expect(error).toMatchObject({ name: 'OcrWorkLimitError', status: 413 });
      expect((error as Error).message).toContain(OCR_DOCUMENT_DEADLINE_ENV);
      expect((error as Error).message).toContain(String(SHORT_BUDGET_MS));
    },
    TEST_TIMEOUT_MS
  );

  // The text targets all read a scanned PDF through the same OCR; the refusal must reach the caller as the typed 413,
  // not as a generic failure. OCR is forced so that the pages, which carry text here, are read as images.
  it.each(['txt', 'docx', 'pdf'])('reaches the caller of a %s conversion as the typed 413', async (target) => {
    requireTessdata('eng');
    const pdf = await textPages(LONG_DOCUMENT_PAGES);
    vi.stubEnv(OCR_DOCUMENT_DEADLINE_ENV, String(SHORT_BUDGET_MS));
    const outcome = await expectNoHangOnInput(
      `${LONG_DOCUMENT_PAGES} pages to ${target} with a ${SHORT_BUDGET_MS} ms budget`,
      (input: Buffer) => dispatchConversion(input, 'pdf', target, { ocrEnabled: true, ocrMode: 'force' }, 'long.pdf').then(
        () => null,
        (error: unknown) => error
      ),
      pdf,
      SHORT_BUDGET_MS + BUDGET_SLACK_MS
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

  it('takes a non-positive or unreadable override as unset, so a mistyped value never lifts the limit', async () => {
    const { ocrDocumentDeadlineMs } = await import('../src/lib/conversions/ocr-work-budget');
    for (const value of ['0', '-5', 'abc', '', '1.5']) {
      vi.stubEnv(OCR_DOCUMENT_DEADLINE_ENV, value);
      expect(ocrDocumentDeadlineMs(), JSON.stringify(value)).toBe(OCR_DOCUMENT_DEADLINE_MS);
    }
    vi.stubEnv(OCR_DOCUMENT_DEADLINE_ENV, '45000');
    expect(ocrDocumentDeadlineMs()).toBe(45_000);
  });
});
