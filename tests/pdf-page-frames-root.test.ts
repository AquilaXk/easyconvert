import { describe, expect, it } from 'vitest';
import { PdfPageFrameError, readPdfPageFrames } from '../src/lib/conversions/pdf-page-geometry';
import { buildPdf } from './helpers/pdf-craft';
import { requireRealworldSample } from './helpers/realworld-sample';

/**
 * The frames of a PDF are read from its page tree. A catalog whose /Pages entry is not a page tree has no pages to frame:
 * Poppler ("Page count in top-level pages object is wrong type") and qpdf ("root of pages tree has no /Kids array") refuse
 * it, and so must the reader, with a message that names the page tree and not a TypeError of the parser.
 */

const CATALOG_ID = 1;
const PAGES_ID = 2;
const PAGE_ID = 3;
const MEDIA_BOX = '[0 0 200 100]';
const PARSER_TYPE_ERROR = /is not a function|undefined|TypeError/;

function pdfWithPagesEntry(pagesDict: string): Buffer {
  return buildPdf(
    [
      { id: CATALOG_ID, dict: `/Type /Catalog /Pages ${PAGES_ID} 0 R` },
      { id: PAGES_ID, dict: pagesDict },
      { id: PAGE_ID, dict: `/Type /Page /Parent ${PAGES_ID} 0 R /MediaBox ${MEDIA_BOX}` },
    ],
    CATALOG_ID
  ).buffer;
}

describe('the frames of a PDF whose catalog has no page tree', () => {
  it('refuses a /Pages entry that is a plain dictionary with a typed error that names the page tree', async () => {
    const error = await readPdfPageFrames(pdfWithPagesEntry('/S /JavaScript /JS (func=function(){};func();)')).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PdfPageFrameError);
    const message = (error as PdfPageFrameError).message;
    expect(message).toMatch(/\/Pages entry of the catalog is not a page tree/);
    expect(message).not.toMatch(PARSER_TYPE_ERROR);
  });

  it('still reads the frame of a page tree that has one page', async () => {
    const frames = await readPdfPageFrames(pdfWithPagesEntry(`/Type /Pages /Kids [${PAGE_ID} 0 R] /Count 1`));
    expect(frames).toEqual([{ cropBox: { x0: 0, y0: 0, x1: 200, y1: 100 }, rotation: 0 }]);
  });

  it('refuses pdfjs-issue15590.pdf, whose /Pages is the dictionary of a JavaScript action, the same way', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'pdfjs-issue15590.pdf');
    const error = await readPdfPageFrames(bytes).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PdfPageFrameError);
    expect((error as PdfPageFrameError).message).toMatch(/\/Pages entry of the catalog is not a page tree/);
    expect((error as PdfPageFrameError).message).not.toMatch(PARSER_TYPE_ERROR);
  });
});
