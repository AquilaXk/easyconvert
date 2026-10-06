import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { OcrWord } from '../src/lib/conversions/ocr-pdf-combiner';
import { rawPdf, run } from './helpers/raw-pdf';

/**
 * Hostile and oversized PDFs: per-page limits, one pass over each page, a bounded operator-list read,
 * a wall-clock deadline that stops runaway documents, and sub-quadratic grouping.
 */

const counts = { textContent: 0, operatorList: 0 };

// Count how often the pdfjs page methods are called; behaviour is otherwise unchanged.
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pdfjs-dist/legacy/build/pdf.mjs')>();
  return {
    ...actual,
    getDocument: (options: Parameters<typeof actual.getDocument>[0]) => {
      const task = actual.getDocument(options);
      const promise = task.promise.then((doc) => {
        const getPage = doc.getPage.bind(doc);
        (doc as unknown as { getPage: unknown }).getPage = async (pageNumber: number) => {
          const page = await getPage(pageNumber);
          const getTextContent = page.getTextContent.bind(page);
          const getOperatorList = page.getOperatorList.bind(page);
          (page as unknown as { getTextContent: unknown }).getTextContent = (...args: Parameters<typeof getTextContent>) => {
            counts.textContent++;
            return getTextContent(...args);
          };
          (page as unknown as { getOperatorList: unknown }).getOperatorList = (...args: Parameters<typeof getOperatorList>) => {
            counts.operatorList++;
            return getOperatorList(...args);
          };
          return page;
        };
        return doc;
      });
      return { promise, destroy: () => task.destroy() };
    },
  };
});

import {
  analyzePdfPagesInProcess,
  layoutItemRuns,
  PDF_TEXT_MAX_ITEM_CHARS,
  PDF_TEXT_MAX_ITEMS_PER_PAGE,
  PDF_TEXT_MAX_WORDS_PER_PAGE,
  PDF_TEXT_OPERATOR_LIST_MAX_ITEMS,
  PdfTextGeometryError,
  type ItemRun,
} from '../src/lib/conversions/pdf-text-geometry';

const TEST_TIMEOUT_MS = 120_000;
/** pdfjs drops text beyond the page, so a very long item needs a very wide page. */
const WIDE_PAGE_PT = 2_000_000;
const GROUPING_CPU_BUDGET_MS = 1_000;
const MANY_RUNS = 96_000;

beforeEach(() => {
  counts.textContent = 0;
  counts.operatorList = 0;
});

/** `count` one-character text items, each on its own baseline so pdfjs reports them as separate items. */
function manyItems(count: number): Buffer {
  const content = Array.from({ length: count }, (_, i) => `BT /F1 1 Tf 1 0 0 1 1 ${i + 1} Tm (a) Tj ET`).join('\n');
  return rawPdf([{ width: 100, height: count + 10, content }]);
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (err: unknown) => err
  );
}

describe('per-page limits', () => {
  it(
    `rejects a page with more than ${PDF_TEXT_MAX_ITEMS_PER_PAGE} text items`,
    async () => {
      const err = await failure(analyzePdfPagesInProcess(manyItems(PDF_TEXT_MAX_ITEMS_PER_PAGE + 1), { geometry: [1] }));
      expect(err).toBeInstanceOf(PdfTextGeometryError);
      expect((err as Error).message).toBe(`PDF page 1 has more than ${PDF_TEXT_MAX_ITEMS_PER_PAGE} text items.`);
    },
    TEST_TIMEOUT_MS
  );

  it(
    `rejects a single item of more than ${PDF_TEXT_MAX_WORDS_PER_PAGE} words before laying it out`,
    async () => {
      const words = Array.from({ length: PDF_TEXT_MAX_WORDS_PER_PAGE + 1 }, () => 'a').join(' ');
      const pdf = rawPdf([{ width: WIDE_PAGE_PT, height: 100, content: run(words, 1, 50, 1) }]);
      const err = await failure(analyzePdfPagesInProcess(pdf, { geometry: [1] }));
      expect(err).toBeInstanceOf(PdfTextGeometryError);
      expect((err as Error).message).toBe(`PDF page 1 has more than ${PDF_TEXT_MAX_WORDS_PER_PAGE} words.`);
    },
    TEST_TIMEOUT_MS
  );

  it(
    `rejects an item longer than ${PDF_TEXT_MAX_ITEM_CHARS} characters before allocating per-character data`,
    async () => {
      const pdf = rawPdf([{ width: WIDE_PAGE_PT, height: 100, content: run('a'.repeat(PDF_TEXT_MAX_ITEM_CHARS + 1), 1, 50, 1) }]);
      const err = await failure(analyzePdfPagesInProcess(pdf, { geometry: [1] }));
      expect(err).toBeInstanceOf(PdfTextGeometryError);
      expect((err as Error).message).toBe(`PDF page 1 has a text item longer than ${PDF_TEXT_MAX_ITEM_CHARS} characters.`);
    },
    TEST_TIMEOUT_MS
  );
});

describe('one read of each page', () => {
  async function digitalPdf(): Promise<Buffer> {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([300, 200]).drawText('First page has enough text for a layer', { x: 20, y: 100, size: 12, font });
    doc.addPage([300, 200]).drawText('Second page has enough text as well', { x: 20, y: 100, size: 12, font });
    return Buffer.from(await doc.save());
  }

  it('reads the text content once per page when density analysis and geometry run together', async () => {
    const result = await analyzePdfPagesInProcess(await digitalPdf(), { densityThreshold: 15, geometry: 'text-pages' });
    expect(result.analyses.map((a) => [a.pageNumber, a.hasTextLayer])).toEqual([
      [1, true],
      [2, true],
    ]);
    expect([...result.geometry.keys()]).toEqual([1, 2]);
    expect(counts.textContent).toBe(2);
    expect(counts.operatorList).toBe(2);
  });

  it('does not read the operator list for pages that need no geometry', async () => {
    const result = await analyzePdfPagesInProcess(await digitalPdf(), { densityThreshold: 15, geometry: [2] });
    expect([...result.geometry.keys()]).toEqual([2]);
    expect(counts.textContent).toBe(2);
    expect(counts.operatorList).toBe(1);
  });

  it(
    `skips the operator list above ${PDF_TEXT_OPERATOR_LIST_MAX_ITEMS} text items and lays words out with equal shares`,
    async () => {
      const items = PDF_TEXT_OPERATOR_LIST_MAX_ITEMS + 1;
      const result = await analyzePdfPagesInProcess(manyItems(items), { geometry: [1] });
      expect(counts.operatorList).toBe(0);
      expect(result.geometry.get(1)?.wordCount).toBe(items);
    },
    TEST_TIMEOUT_MS
  );
});

describe('grouping many runs', () => {
  function tinyRun(x0: number, baselineY: number): ItemRun {
    const word: OcrWord = { text: 'a', bbox: { x: x0, y: baselineY - 9, width: 4, height: 12 } };
    return {
      words: [word],
      box: { x0, y0: baselineY - 9, x1: x0 + 4, y1: baselineY + 3 },
      baseline: { x0, y0: baselineY, x1: x0 + 4, y1: baselineY },
      horizontal: true,
      rtl: false,
      size: 12,
      baselineY,
    };
  }

  function cpuMs(work: () => void): number {
    const start = process.cpuUsage();
    work();
    const used = process.cpuUsage(start);
    return (used.user + used.system) / 1000;
  }

  const wordsIn = (blocks: ReturnType<typeof layoutItemRuns>): number => blocks.reduce((sum, block) => sum + block.words.length, 0);

  it(`groups ${MANY_RUNS} runs on two rows of tens of thousands of separate lines in under ${GROUPING_CPU_BUDGET_MS} ms of CPU`, () => {
    // Alternating 1 pt and 500 pt gaps: the median gap is small, so every wide gap separates two lines.
    const perRow = MANY_RUNS / 2;
    const row = (baselineY: number): ItemRun[] =>
      Array.from({ length: perRow }, (_, i) => tinyRun(Math.floor(i / 2) * 1000 + (i % 2) * 5, baselineY));
    const runs = [...row(100), ...row(114)];
    let blocks: ReturnType<typeof layoutItemRuns> = [];
    const used = cpuMs(() => {
      blocks = layoutItemRuns(runs);
    });
    expect(wordsIn(blocks)).toBe(MANY_RUNS);
    expect(blocks).toHaveLength(MANY_RUNS / 2);
    expect(used).toBeLessThan(GROUPING_CPU_BUDGET_MS);
  });

  it(`groups ${MANY_RUNS} evenly spaced runs on one row into one line without exhausting the call stack`, () => {
    const runs = Array.from({ length: MANY_RUNS }, (_, i) => tinyRun(i * 5, 100));
    let blocks: ReturnType<typeof layoutItemRuns> = [];
    const used = cpuMs(() => {
      blocks = layoutItemRuns(runs);
    });
    expect(blocks.map((block) => block.words.length)).toEqual([MANY_RUNS]);
    expect(used).toBeLessThan(GROUPING_CPU_BUDGET_MS);
  });

  it(`groups ${MANY_RUNS} rows one above the other without a quadratic look-back`, () => {
    const runs = Array.from({ length: MANY_RUNS }, (_, i) => tinyRun(0, 100 + i * 12));
    let blocks: ReturnType<typeof layoutItemRuns> = [];
    const used = cpuMs(() => {
      blocks = layoutItemRuns(runs);
    });
    expect(wordsIn(blocks)).toBe(MANY_RUNS);
    expect(used).toBeLessThan(GROUPING_CPU_BUDGET_MS);
  });
});
