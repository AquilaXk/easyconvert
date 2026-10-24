import { afterAll, describe, expect, it } from 'vitest';
import { shutdownPdfTextThreads } from '../src/lib/conversions/pdf-text-host';
import { PAGE_EDGE_TOLERANCE_PT, wordsPastPageEdge } from '../src/lib/conversions/pdf-page-edge';
import { pdfWithWords, type DrawnWord } from './helpers/page-edge-pdf';

/**
 * Words past the edge of the page, from the geometry of the PDF itself: pdf.js gives each word the box its glyph advances
 * make, in the page as displayed (rotation applied, the viewport being the CropBox inside the MediaBox).
 */

const A4: readonly [number, number] = [595, 842];
const DEADLINE_MS = 30_000;
const BASELINE = 400;
const MANY_PAGES = 300;

const word = (text: string, right: number, baseline = BASELINE): DrawnWord => ({ text, right, baseline });

afterAll(() => shutdownPdfTextThreads());

describe('wordsPastPageEdge', () => {
  it('counts the words whose box ends past the right edge, and the pages that hold them', async () => {
    const pdf = await pdfWithWords([
      { size: A4, words: [word('inside', 300), word('beyond', 622), word('further', 625, 380)] },
      { size: A4, words: [word('fine', 200)] },
      { size: A4, words: [word('last', 611)] },
    ]);
    expect(await wordsPastPageEdge(pdf, DEADLINE_MS)).toEqual({ words: 3, pages: [1, 3] });
  });

  it('counts a word that starts before the left edge, and words past the top and the bottom', async () => {
    const pdf = await pdfWithWords([
      { size: A4, words: [word('leftward', 20), word('high', 200, A4[1]), word('low', 200, 0)] },
    ]);
    expect(await wordsPastPageEdge(pdf, DEADLINE_MS)).toEqual({ words: 3, pages: [1] });
  });

  it('leaves a word that ends at the edge or within the rounding of its numbers, and counts one that ends 0.5 pt past it', async () => {
    const pdf = await pdfWithWords([
      { size: A4, words: [word('edge', A4[0])] },
      { size: A4, words: [word('edge', A4[0] + PAGE_EDGE_TOLERANCE_PT / 2)] },
      { size: A4, words: [word('edge', A4[0] + 0.5)] },
    ]);
    expect(await wordsPastPageEdge(pdf, DEADLINE_MS)).toEqual({ words: 1, pages: [3] });
  });

  it('measures against the page as displayed: a rotated page swaps its sides', async () => {
    // Displayed 842 wide and 595 high: a baseline at 700 of the 842 high page lands at x = 700, inside; at 838 the box ends past the right edge.
    const pdf = await pdfWithWords([{ size: A4, rotate: 90, words: [word('rotated', 300, 700)] }]);
    expect(await wordsPastPageEdge(pdf, DEADLINE_MS)).toEqual({ words: 0, pages: [] });
    const outside = await pdfWithWords([{ size: A4, rotate: 90, words: [word('rotated', 300, 838)] }]);
    expect(await wordsPastPageEdge(outside, DEADLINE_MS)).toEqual({ words: 1, pages: [1] });
  });

  it('measures against the CropBox, which is the page that is shown', async () => {
    const pdf = await pdfWithWords([{ size: A4, cropBox: [0, 0, 400, 842], words: [word('between', 430)] }]);
    expect(await wordsPastPageEdge(pdf, DEADLINE_MS)).toEqual({ words: 1, pages: [1] });
  });

  it('answers no words for a PDF without text', async () => {
    expect(await wordsPastPageEdge(await pdfWithWords([{ size: A4, words: [] }]), DEADLINE_MS)).toEqual({ words: 0, pages: [] });
  });

  it('fails with the deadline instead of waiting past it', async () => {
    // Many pages, so that the read takes longer than the deadline however warm the thread is.
    const pdf = await pdfWithWords(Array.from({ length: MANY_PAGES }, () => ({ size: A4, words: [word('page', 300)] })));
    await expect(wordsPastPageEdge(pdf, 1)).rejects.toMatchObject({ name: 'PdfTextGeometryError', message: 'PDF text extraction exceeded its 1 ms limit.' });
  });

  it('fails for bytes that are not a PDF', async () => {
    await expect(wordsPastPageEdge(Buffer.from('not a pdf'), DEADLINE_MS)).rejects.toMatchObject({
      name: 'PdfTextGeometryError',
      message: expect.stringContaining('could not be read'),
    });
  });
});
