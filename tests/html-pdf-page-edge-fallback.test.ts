import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { shutdownPdfTextThreads } from '../src/lib/conversions/pdf-text-host';
import { PDF_TEXT_DEADLINE_ENV } from '../src/lib/conversions/pdf-text-types';
import { executeWorkerConversion } from '../src/worker/engines';
import type { WorkerConversionResult } from '../src/worker/worker-types';
import { htmlText, lostCharacters, pdfWordBoxes, withCapturingSoffice, wordsOutsidePage } from './helpers/html-pdf-oracle';
import { pdfFacts } from './helpers/corpus-facts';
import { oracleTest } from './helpers/oracle-test';
import { pdfWithWords } from './helpers/page-edge-pdf';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipUnless } from './helpers/strict-skip';

/**
 * When the PDF the office suite draws for an HTML page has words past the edge of its page, the in-process renderer's PDF is
 * handed out instead, as a print engine never leaves a word off the page (docs/policy-decisions.md entry 90). Everything that
 * keeps the office suite's PDF is tested next to it: no word past the edge, a page the in-process renderer refuses, a check
 * that runs out of time, and the conversions that may not leave the office suite.
 *
 * Most tests answer for the office suite with a PDF of a known layout (a stand-in executable that copies it), so what is under
 * test is the decision and never the version of the suite. One test per real page of the corpus runs the real suite; it
 * skips where the suite does not draw a word past the edge of that page.
 */

const LIBREOFFICE_TIMEOUT_MS = 180_000;
/** The engine name of an office suite run, one-shot or in the pool. */
const OFFICE_SUITE_ENGINE = /^native-soffice/;
const A4: readonly [number, number] = [595, 842];
const HTML = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>page</title></head><body><p>alpha beta gamma delta</p></body></html>';
/** Wider than the page can be shrunk to: the in-process renderer refuses it (a column floor of 24 pt, a shrink of at most 1.5). */
const TOO_WIDE_HTML = `<!DOCTYPE html><html><body><p>alpha beta</p><table><tr>${Array.from({ length: 40 }, (_, i) => `<td>cell${i}</td>`).join('')}</tr></table></body></html>`;

let deadlineBefore: string | undefined;

beforeAll(() => {
  deadlineBefore = process.env[PDF_TEXT_DEADLINE_ENV];
});

afterEach(() => {
  if (deadlineBefore === undefined) delete process.env[PDF_TEXT_DEADLINE_ENV];
  else process.env[PDF_TEXT_DEADLINE_ENV] = deadlineBefore;
});

afterAll(() => shutdownPdfTextThreads());

/** A page with `beyond` ending 27 pt past the right edge, and a page of the same words all inside. */
const pdfWithWordPastEdge = (): Promise<Buffer> =>
  pdfWithWords([{ size: A4, words: [{ text: 'alpha', right: 120, baseline: 700 }, { text: 'beyond', right: A4[0] + 27, baseline: 680 }] }]);
/** Pages enough that no read of them, however warm the thread, ends within a millisecond. */
const MANY_PAGES = 300;
const pdfWithinPage = (): Promise<Buffer> =>
  pdfWithWords([{ size: A4, words: [{ text: 'alpha', right: 120, baseline: 700 }, { text: 'inside', right: 300, baseline: 680 }] }]);

/** Converts `html` while the office suite answers with `officePdf`. */
async function convertWithOfficePdf(html: string, officePdf: Buffer, options: Record<string, unknown> = {}): Promise<WorkerConversionResult> {
  let result: WorkerConversionResult | undefined;
  await withCapturingSoffice(async () => {
    result = await executeWorkerConversion(Buffer.from(html, 'utf-8'), 'html', 'pdf', options, 'page.html');
  }, officePdf);
  return result as WorkerConversionResult;
}

describe('an office suite PDF with a word past the page edge', () => {
  it('is replaced by the in-process PDF, which holds every word of the page inside its pages', async () => {
    const office = await pdfWithWordPastEdge();
    const result = await convertWithOfficePdf(HTML, office);
    expect(result.engineUsed).toBe('internal-fallback');
    expect(result.buffer.equals(office)).toBe(false);
    expect(result.fallbackReason).toMatch(/1 word past the page edge on page 1/);
    expect(result.fallbackChain).toEqual([expect.stringContaining('native-soffice')]);
    // Poppler reads the PDF that was handed out: no word box leaves its page, and no letter or digit of the page is missing.
    expect(wordsOutsidePage(pdfWordBoxes(result.buffer))).toEqual([]);
    expect(lostCharacters(htmlText(HTML), pdfFacts(result.buffer).text)).toBe(0);
  });

  it('is kept when the in-process renderer refuses the page', async () => {
    const office = await pdfWithWordPastEdge();
    const result = await convertWithOfficePdf(TOO_WIDE_HTML, office);
    expect(result.engineUsed).toMatch(OFFICE_SUITE_ENGINE);
    expect(result.buffer.equals(office)).toBe(true);
    expect(result.fallbackReason).toBeUndefined();
  });

  it('is kept when the check runs out of its time', async () => {
    process.env[PDF_TEXT_DEADLINE_ENV] = '1';
    const office = await pdfWithWords([
      { size: A4, words: [{ text: 'beyond', right: A4[0] + 27, baseline: 680 }] },
      ...Array.from({ length: MANY_PAGES }, () => ({ size: A4, words: [{ text: 'page', right: 300, baseline: 700 }] })),
    ]);
    const result = await convertWithOfficePdf(HTML, office);
    expect(result.engineUsed).toMatch(OFFICE_SUITE_ENGINE);
    expect(result.buffer.equals(office)).toBe(true);
  });

  it('is kept when the PDF cannot be read', async () => {
    const result = await convertWithOfficePdf(HTML, Buffer.from('%PDF-1.4\nnot a document\n%%EOF\n'));
    expect(result.engineUsed).toMatch(OFFICE_SUITE_ENGINE);
  });

  it('is kept when the request needs the office suite (a PDF/A standard)', async () => {
    const office = await pdfWithWordPastEdge();
    const result = await convertWithOfficePdf(HTML, office, { pdfStandard: 'pdfa-2b' });
    expect(result.engineUsed).toMatch(OFFICE_SUITE_ENGINE);
    expect(result.buffer.equals(office)).toBe(true);
  });

  it('is kept when the in-process renderer may not be used', async () => {
    const office = await pdfWithWordPastEdge();
    const result = await convertWithOfficePdf(HTML, office, { inProcessFallback: false });
    expect(result.engineUsed).toMatch(OFFICE_SUITE_ENGINE);
    expect(result.buffer.equals(office)).toBe(true);
  });
});

describe('an office suite PDF with every word inside its page', () => {
  it('is the PDF that is handed out', async () => {
    const office = await pdfWithinPage();
    const result = await convertWithOfficePdf(HTML, office);
    expect(result.engineUsed).toMatch(OFFICE_SUITE_ENGINE);
    expect(result.buffer.equals(office)).toBe(true);
    expect(result.fallbackReason).toBeUndefined();
  });
});

describe('a real page of the public corpus that the office suite draws past the edge', () => {
  // 001794: a data table without widths whose least width is more than the text area. 000640 is the same layout.
  for (const id of ['govdocs1-001794.html', 'govdocs1-000640.html']) {
    oracleTest(
      `${id} is handed out as the in-process PDF with no word past the edge`,
      ['soffice', 'pdftotext'],
      async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, id);
        const office = await executeWorkerConversion(bytes, 'html', 'pdf', { inProcessFallback: false }, id);
        const drawsWordPastEdge = wordsOutsidePage(pdfWordBoxes(office.buffer)).length > 0;
        if (skipUnless(`an office suite that draws a word of ${id} past the page edge`, drawsWordPastEdge)) ctx.skip();
        const result = await executeWorkerConversion(bytes, 'html', 'pdf', {}, id);
        expect({ engine: result.engineUsed, outside: wordsOutsidePage(pdfWordBoxes(result.buffer)) }).toEqual({ engine: 'internal-fallback', outside: [] });
      },
      LIBREOFFICE_TIMEOUT_MS
    );
  }
});
