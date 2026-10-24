import { describe, expect, it } from 'vitest';
import { PDFDocument, rgb } from 'pdf-lib';
import { pdfFirstPageHasInk } from '../src/worker/pdf-ink';
import { requireOracleTool } from './helpers/differential-oracle';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * Whether the first page of a PDF holds anything but paper, judged by drawing it with Poppler (`pdftoppm`) at 72 dpi and looking
 * for a pixel that is not white. The PDFs are written here with pdf-lib, so what each page draws is known from the drawing calls.
 */

const haveRenderer = !skipWithoutTools('pdftoppm');
const NATIVE_TIMEOUT_MS = 60_000;

async function pdfOf(draw: (page: ReturnType<PDFDocument['addPage']>) => void, size: [number, number] = [200, 120]): Promise<Buffer> {
  const document = await PDFDocument.create();
  draw(document.addPage(size));
  return Buffer.from(await document.save());
}

function hasInk(pdf: Buffer): Promise<boolean> {
  return pdfFirstPageHasInk({ buffer: pdf }, requireOracleTool('pdftoppm'), {});
}

describe.skipIf(!haveRenderer)('the ink of the first page of a PDF', () => {
  it('is none on a page nothing is drawn on, or one painted white all over like the page the office suite writes for a metafile it cannot draw', async () => {
    expect(await hasInk(await pdfOf(() => undefined))).toBe(false);
    expect(await hasInk(await pdfOf((page) => page.drawRectangle({ x: 0, y: 0, width: 200, height: 120, color: rgb(1, 1, 1) })))).toBe(false);
  }, NATIVE_TIMEOUT_MS);

  it('is found in a filled shape, a hairline and a barely grey rectangle', async () => {
    expect(await hasInk(await pdfOf((page) => page.drawRectangle({ x: 20, y: 20, width: 60, height: 40, color: rgb(0, 0, 0) })))).toBe(true);
    expect(await hasInk(await pdfOf((page) => page.drawLine({ start: { x: 10, y: 10 }, end: { x: 190, y: 110 }, thickness: 0.1, color: rgb(0, 0, 0) })))).toBe(true);
    expect(await hasInk(await pdfOf((page) => page.drawRectangle({ x: 20, y: 20, width: 60, height: 40, color: rgb(0.98, 0.98, 0.98) })))).toBe(true);
  }, NATIVE_TIMEOUT_MS);

  it('is found on a page of 3,000 by 3,000 points, whose raster is the largest a metafile page can have', async () => {
    const page = (draw: boolean) => pdfOf((p) => draw && p.drawRectangle({ x: 2900, y: 2900, width: 50, height: 50, color: rgb(0, 0, 0) }), [3000, 3000]);
    expect(await hasInk(await page(true))).toBe(true);
    expect(await hasInk(await page(false))).toBe(false);
  }, NATIVE_TIMEOUT_MS);

  it('is not guessed for a file that is no PDF: the failure of the renderer stands', async () => {
    await expect(hasInk(Buffer.from('not a pdf at all'))).rejects.toThrow(/Couldn't find trailer dictionary/);
  }, NATIVE_TIMEOUT_MS);
});
