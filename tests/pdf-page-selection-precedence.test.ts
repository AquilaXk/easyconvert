import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { skipWithoutTools } from './helpers/strict-skip';
import { captureError } from './helpers/capture-error';

/**
 * PDF page selection follows the same precedence as image page selection: `page` and `pages` must agree
 * when both are given, otherwise the request is refused with InvalidPageRangeError (HTTP 400).
 *
 * Oracle: the three-page PDF is written by pdf-lib; the rendered page count is read from the ZIP.
 */

const PAGE_COUNT = 3;
const SKIP = skipWithoutTools('pdftoppm');

async function threePagePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let page = 0; page < PAGE_COUNT; page += 1) doc.addPage([200, 100]);
  return Buffer.from(await doc.save());
}

describe('pdf to png page selection', () => {
  it.skipIf(SKIP)('page 2 with pages "3" is rejected as ambiguous', async () => {
    const error = await captureError(async () => dispatchConversion(await threePagePdf(), 'pdf', 'png', { page: 2, pages: '3' }, 'doc.pdf'));
    expect(error.name).toBe('InvalidPageRangeError');
    expect(error.message).toMatch(/The "page" option \(2\) and the "pages" option \("3"\) select different pages/);
  });

  it.skipIf(SKIP)('page 2 with pages "2" selects one page', async () => {
    const result = await dispatchConversion(await threePagePdf(), 'pdf', 'png', { page: 2, pages: '2' }, 'doc.pdf');
    expect(result.mimeType).toBe('image/png');
    expect(result.buffer.subarray(1, 4).toString('latin1')).toBe('PNG');
  });

  it.skipIf(SKIP)('null page counts as absent and every page is rendered', async () => {
    const result = await dispatchConversion(await threePagePdf(), 'pdf', 'png', { page: null } as never, 'doc.pdf');
    expect(result.mimeType).toBe('application/zip');
    const zip = await JSZip.loadAsync(result.buffer);
    expect(Object.keys(zip.files).sort()).toEqual(['doc-p001.png', 'doc-p002.png', 'doc-p003.png']);
  });
});
