import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { recognizeRenderedPdfPages, shutdownOcrWorkerPool } from '../src/lib/conversions/ocr';
import { getSharedOcrWorkerPool } from '../src/lib/conversions/ocr-worker-pool';
import { OCR_PAGE_BUDGET_ENV, OCR_PAGE_GUARD_PAGES, ocrDocumentBudgetMs, OcrWorkLimitError } from '../src/lib/conversions/ocr-work-budget';
import type { PdfPageRenderer, RenderedOcrPage } from '../src/lib/conversions/pdf-page-render';
import { requireTessdata } from './helpers/ocr-fixtures';
import { oracleTest } from './helpers/oracle-test';
import { expectNoHangOnInput } from './helpers/timing';

/**
 * The OCR budget scales with the pages of the document and each page has a limit of its own. The renderer is the one
 * thing replaced: every page is the same real render of a page of text (read by the real engine) and only the time
 * it takes to produce is chosen per case, so that cheap, slow and endless pages are exact rather than a matter of
 * how fast the machine is.
 */

const mocks = vi.hoisted(() => ({ renderer: null as null | ((pageCount: number) => unknown) }));

vi.mock('../src/lib/conversions/pdf-page-render', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/conversions/pdf-page-render')>();
  return {
    ...actual,
    openPdfPageRenderer: async (...args: Parameters<typeof actual.openPdfPageRenderer>) => {
      if (mocks.renderer === null) return actual.openPdfPageRenderer(...args);
      return mocks.renderer(args[0].length);
    },
  };
});

const TEST_TIMEOUT_MS = 240_000;
const SENTENCE = 'The committee reviewed the quarterly report and approved the budget for the regional water project';
const CHEAP_PAGES = 80;
const SLOW_PAGES = 40;
const MIXED_PAGES = 12;
const PATHOLOGICAL_PAGE = 5;
/** Page budgets (ms) of the cases: generous for the cheap case, tight for the slow ones. */
const CHEAP_PAGE_BUDGET_MS = 1_000;
const SLOW_PAGE_BUDGET_MS = 500;
/** A slow page takes 5.2 page budgets to draw: under its own limit of 6, but 4 pages at a time cost more than the budget of each. */
const SLOW_PAGE_RENDER_MS = 2_200;
const MIXED_PAGE_BUDGET_MS = 500;
const SLACK_MS = 12_000;
const NEVER_MS = 600_000;
const ABANDON_PAGE_BUDGET_MS = 300;
/** How long after the refusal the other pages finish drawing, and how long the test then waits to see whether one reads. */
const ABANDON_DRAW_MARGIN_MS = 1_200;
const ABANDON_SETTLE_MS = 1_500;

let pageImage: RenderedOcrPage;
const releases: Array<() => void> = [];

async function fixturePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sheet = doc.addPage([612, 792]);
  for (let line = 0; line < 20; line++) sheet.drawText(`${SENTENCE} (line ${line + 1}).`, { x: 36, y: 750 - line * 24, size: 11, font });
  return Buffer.from(await doc.save());
}

/** A renderer of `pageCount` pages that all draw as the fixture page, each after `delayMs(index)`; a delay of NEVER_MS waits for the test to end. */
function fakeRenderer(pageCount: number, delayMs: (index: number) => number): PdfPageRenderer {
  const pageNumbers = Array.from({ length: pageCount }, (_, index) => index + 1);
  return {
    plan: { pageNumbers, frames: pageNumbers.map(() => pageImage.page.frame), dpi: pageImage.page.dpi },
    async render(index: number): Promise<RenderedOcrPage> {
      const wait = delayMs(index);
      if (wait > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, wait);
          releases.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      return { ...pageImage, pageNumber: index + 1 };
    },
    async close(): Promise<void> {},
  };
}

beforeAll(async () => {
  mocks.renderer = null;
  const { openPdfPageRenderer } = await import('../src/lib/conversions/pdf-page-render');
  const renderer = await openPdfPageRenderer(await fixturePdf(), undefined, undefined);
  try {
    pageImage = await renderer.render(0);
  } finally {
    await renderer.close();
  }
}, TEST_TIMEOUT_MS);

afterEach(async () => {
  mocks.renderer = null;
  vi.unstubAllEnvs();
  for (const release of releases.splice(0)) release();
  await shutdownOcrWorkerPool();
});

async function outcomeOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error
  );
}

describe('the OCR budget scales with the pages', () => {
  oracleTest(
    `reads ${CHEAP_PAGES} cheap pages in full, in order, though the same page budget refuses a document of ${SLOW_PAGES} slow ones`,
    ['tesseract', 'pdftoppm'],
    async () => {
      requireTessdata('eng');
      vi.stubEnv(OCR_PAGE_BUDGET_ENV, String(CHEAP_PAGE_BUDGET_MS));
      mocks.renderer = (pageCount) => fakeRenderer(pageCount, () => 0);
      const pdf = Buffer.alloc(CHEAP_PAGES);
      const recognized = await recognizeRenderedPdfPages(pdf, undefined, {});
      expect([...recognized.keys()]).toEqual(Array.from({ length: CHEAP_PAGES }, (_, index) => index + 1));
      for (const [pageNumber, result] of recognized) {
        expect(result.text.replace(/\s+/g, ' '), `page ${pageNumber}`).toContain('committee reviewed the quarterly report');
      }
      // The same budget would refuse this document if it were a flat figure: one page's worth is a fraction of the time taken.
      expect(ocrDocumentBudgetMs(1)).toBeLessThan(ocrDocumentBudgetMs(CHEAP_PAGES));
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    `refuses ${SLOW_PAGES} pages that each take more than their share with a typed 413 once the document budget is gone`,
    ['tesseract', 'pdftoppm'],
    async () => {
      requireTessdata('eng');
      vi.stubEnv(OCR_PAGE_BUDGET_ENV, String(SLOW_PAGE_BUDGET_MS));
      mocks.renderer = (pageCount) => fakeRenderer(pageCount, () => SLOW_PAGE_RENDER_MS);
      const budget = ocrDocumentBudgetMs(SLOW_PAGES);
      const { largeResult } = await expectNoHangOnInput(
        `${SLOW_PAGES} slow pages with a ${budget} ms document budget`,
        (input: Buffer) => outcomeOf(recognizeRenderedPdfPages(input, undefined, {})),
        Buffer.alloc(SLOW_PAGES),
        budget + SLACK_MS
      );
      expect(largeResult).toBeInstanceOf(OcrWorkLimitError);
      expect(largeResult).toMatchObject({ name: 'OcrWorkLimitError', status: 413 });
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'refuses one page that never ends within its own limit, long before the budget of the document',
    ['tesseract', 'pdftoppm'],
    async () => {
      requireTessdata('eng');
      vi.stubEnv(OCR_PAGE_BUDGET_ENV, String(MIXED_PAGE_BUDGET_MS));
      mocks.renderer = (pageCount) => fakeRenderer(pageCount, (index) => (index + 1 === PATHOLOGICAL_PAGE ? NEVER_MS : 0));
      const pageLimit = OCR_PAGE_GUARD_PAGES * MIXED_PAGE_BUDGET_MS;
      expect(pageLimit).toBeLessThan(ocrDocumentBudgetMs(MIXED_PAGES));
      const { largeResult } = await expectNoHangOnInput(
        'one page that never ends',
        (input: Buffer) => outcomeOf(recognizeRenderedPdfPages(input, undefined, {})),
        Buffer.alloc(MIXED_PAGES),
        pageLimit + SLACK_MS
      );
      expect(largeResult).toBeInstanceOf(OcrWorkLimitError);
      expect(largeResult).toMatchObject({ status: 413 });
      expect((largeResult as Error).message).toContain(`Page ${PATHOLOGICAL_PAGE} needs more than ${pageLimit} ms`);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'starts no reading once the document is refused, for the pages that were still being drawn',
    ['tesseract', 'pdftoppm'],
    async () => {
      requireTessdata('eng');
      vi.stubEnv(OCR_PAGE_BUDGET_ENV, String(ABANDON_PAGE_BUDGET_MS));
      const drawnLate = ABANDON_PAGE_BUDGET_MS * OCR_PAGE_GUARD_PAGES + ABANDON_DRAW_MARGIN_MS;
      mocks.renderer = (pageCount) => fakeRenderer(pageCount, (index) => (index === 0 ? NEVER_MS : drawnLate));
      const pool = getSharedOcrWorkerPool();
      const reads = vi.spyOn(pool, 'run');
      const refusal = await outcomeOf(recognizeRenderedPdfPages(Buffer.alloc(MIXED_PAGES), undefined, {}));
      expect(refusal).toBeInstanceOf(OcrWorkLimitError);
      const readsAtRefusal = reads.mock.calls.length;
      // The pages drawn after the refusal finish drawing during this wait; none may start a reading.
      await new Promise((resolve) => setTimeout(resolve, ABANDON_DRAW_MARGIN_MS + ABANDON_SETTLE_MS));
      expect(reads.mock.calls.length - readsAtRefusal).toBe(0);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'stops before the job deadline when the job has one, even though the pages would fit the budget of the document',
    ['tesseract', 'pdftoppm'],
    async () => {
      requireTessdata('eng');
      vi.stubEnv(OCR_PAGE_BUDGET_ENV, String(CHEAP_PAGE_BUDGET_MS));
      mocks.renderer = (pageCount) => fakeRenderer(pageCount, () => 400);
      const jobDeadlineMs = 6_000;
      const reserve = ocrDocumentBudgetMs(CHEAP_PAGES, jobDeadlineMs);
      expect(reserve).toBeLessThan(jobDeadlineMs);
      const { largeResult } = await expectNoHangOnInput(
        `${CHEAP_PAGES} pages under a ${jobDeadlineMs} ms job deadline`,
        (input: Buffer) => outcomeOf(recognizeRenderedPdfPages(input, undefined, { jobDeadlineMs })),
        Buffer.alloc(CHEAP_PAGES),
        jobDeadlineMs
      );
      expect(largeResult).toBeInstanceOf(OcrWorkLimitError);
      expect(largeResult).toMatchObject({ status: 413 });
    },
    TEST_TIMEOUT_MS
  );
});
