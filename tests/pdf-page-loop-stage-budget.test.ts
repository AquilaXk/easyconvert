import { afterEach, expect, vi } from 'vitest';
import JSZip from 'jszip';
import { PDFDocument, rgb } from 'pdf-lib';
import { oracleTest } from './helpers/oracle-test';

/**
 * The page loops of a PDF (the SVG pages, and the PNG pages re-encoded as AVIF, BMP, GIF or WebP) take the limit of the whole loop from the
 * pages they have to do, not from the fixed 45 s stage default: the regression corpus's `gd-621452.pdf` (657 pages) needs 74 s of encoding
 * on four cores and was refused at 45 s while the job deadline allowed 5 minutes. The limit of one process in the loop stays the stage default.
 */

const PAGES = 7;
const NATIVE_TIMEOUT_MS = 120_000;

const seen = vi.hoisted(() => ({ pages: [] as number[], force: undefined as number | undefined }));

vi.mock('../src/lib/conversions/job-time', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/conversions/job-time')>();
  return {
    ...actual,
    pagedStageTimeoutMs: (...args: Parameters<typeof actual.pagedStageTimeoutMs>) => {
      seen.pages.push(args[1]);
      return seen.force ?? actual.pagedStageTimeoutMs(...args);
    },
  };
});

async function document(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let index = 0; index < PAGES; index++) {
    const page = doc.addPage([200, 140]);
    page.drawRectangle({ x: 10 + index, y: 10, width: 60, height: 40, color: rgb(0.2, 0.4, 0.8) });
  }
  return Buffer.from(await doc.save());
}

afterEach(() => {
  seen.pages = [];
  seen.force = undefined;
});

for (const target of ['svg', 'bmp', 'eps']) {
  oracleTest(
    `the loop of ${target} pages is limited by its ${PAGES} pages`,
    target === 'svg' ? ['pdftocairo'] : target === 'eps' ? ['pdftocairo', 'pdftops'] : ['pdftoppm'],
    async () => {
      const { dispatchConversion } = await import('../src/lib/conversions/dispatch');
      const pdf = await document();
      const result = await dispatchConversion(pdf, 'pdf', target, {}, 'long.pdf');
      expect(Object.keys((await JSZip.loadAsync(result.buffer)).files)).toHaveLength(PAGES);
      expect(seen.pages).toContain(PAGES);
    },
    NATIVE_TIMEOUT_MS
  );

  oracleTest(
    `the loop of ${target} pages ends when the limit the pages give it has passed`,
    target === 'svg' ? ['pdftocairo'] : target === 'eps' ? ['pdftocairo', 'pdftops'] : ['pdftoppm'],
    async () => {
      const { dispatchConversion } = await import('../src/lib/conversions/dispatch');
      seen.force = 0;
      await expect(dispatchConversion(await document(), 'pdf', target, {}, 'long.pdf')).rejects.toThrow(/timed out|time limit/);
    },
    NATIVE_TIMEOUT_MS
  );
}
