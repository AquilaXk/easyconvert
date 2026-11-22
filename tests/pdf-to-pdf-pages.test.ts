import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions/index';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { QPDF_OUTPUT_FILE_MIN_BYTES } from '../src/lib/conversions/pdf-postprocess/qpdf-run';
import { InvalidPageRangeError } from '../src/lib/types';
import { captureError } from './helpers/capture-error';
import { pdfinfoPages, plainPdf, withTempDir } from './helpers/encrypted-pdf-fixtures';
import { requireOracleTool } from './helpers/differential-oracle';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * `pages` for PDF to PDF (policy entry 392): the result holds the selected pages, as the reference's qpdf `pages` option writes them.
 * The expected text of a page is what Poppler's `pdftotext -f N -l N` reads from the source, an independent reader.
 */

const SKIP = skipWithoutTools('pdftotext', 'pdfinfo', 'qpdf');
const REAL_SAMPLE = 'govdocs1-000562.pdf';
const LARGE_PAGES = 12;

/** The text of page `page` of `pdf` as `pdftotext -f page -l page` reads it. */
function pageText(pdf: Buffer, page: number): string {
  return withTempDir((dir) => {
    const file = path.join(dir, 'in.pdf');
    fs.writeFileSync(file, pdf);
    return execFileSync(requireOracleTool('pdftotext'), ['-f', String(page), '-l', String(page), file, '-'], { encoding: 'utf-8' });
  });
}

const pagesText = (pdf: Buffer, pages: readonly number[]): string[] => pages.map((page) => pageText(pdf, page));

/** A document of `LARGE_PAGES` pages, each with its own sentence, padded past the size from which qpdf writes to a file (entry 391). */
async function largeDocument(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let page = 1; page <= LARGE_PAGES; page++) doc.addPage([300, 300]).drawText(`Sheet ${page} carries the word LEXICON${page * 7}`, { x: 20, y: 200, size: 12, font });
  // Random bytes do not deflate, so the size of the file is the padding's.
  await doc.attach(randomBytes(QPDF_OUTPUT_FILE_MIN_BYTES), 'padding.bin', { mimeType: 'application/octet-stream' });
  return Buffer.from(await doc.save());
}

describe.skipIf(SKIP)('pages for PDF to PDF', () => {
  it('keeps exactly pages 2 to 4 of a real 10-page document', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, REAL_SAMPLE);
    const result = await convertFile(bytes, 'pdf', 'pdf', { pages: '2-4' }, REAL_SAMPLE);
    expect(pdfinfoPages(result.buffer)).toBe(3);
    expect(result.size).toBe(result.buffer.length);
    expect(pagesText(result.buffer, [1, 2, 3])).toEqual(pagesText(bytes, [2, 3, 4]));
  });

  it('keeps the pages of a document written through the dispatcher, with `page` naming one page', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, REAL_SAMPLE);
    const byPages = await dispatchConversion(bytes, 'pdf', 'pdf', { engine: 'easyconvert', pages: '3,5-6' }, REAL_SAMPLE);
    expect(pagesText(byPages.buffer, [1, 2, 3])).toEqual(pagesText(bytes, [3, 5, 6]));
    const byPage = await dispatchConversion(bytes, 'pdf', 'pdf', { engine: 'easyconvert', page: 7 }, REAL_SAMPLE);
    expect(pdfinfoPages(byPage.buffer)).toBe(1);
    expect(pagesText(byPage.buffer, [1])).toEqual(pagesText(bytes, [7]));
  });

  it('keeps every page when no page is named', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, REAL_SAMPLE);
    for (const options of [{}, { pages: '' }, { pages: '  ' }] as const) {
      expect(pdfinfoPages((await convertFile(bytes, 'pdf', 'pdf', options, REAL_SAMPLE)).buffer)).toBe(10);
    }
  });

  it('selects the pages of a document large enough for qpdf to write to a file', async () => {
    const source = await largeDocument();
    expect(source.length).toBeGreaterThanOrEqual(QPDF_OUTPUT_FILE_MIN_BYTES);
    const result = await convertFile(source, 'pdf', 'pdf', { pages: '2-4,9-' }, 'large.pdf');
    expect(pdfinfoPages(result.buffer)).toBe(3 + LARGE_PAGES - 8);
    expect(pagesText(result.buffer, [1, 2, 3, 4, 5, 6, 7])).toEqual(pagesText(source, [2, 3, 4, 9, 10, 11, 12]));
  });

  it.each([
    ['a page past the end', '13'],
    ['a range past the end', '10-13'],
    ['a backward range', '4-2'],
    ['a character that is no digit', '1-x'],
    ['page 0', '0'],
  ])('refuses %s with invalid_pages', async (_name, pages) => {
    const source = await largeDocument();
    const error = await captureError(() => convertFile(source, 'pdf', 'pdf', { pages }, 'large.pdf'));
    expect(error).toBeInstanceOf(InvalidPageRangeError);
    expect((error as InvalidPageRangeError).refusalCode).toBe('invalid_pages');
  });

  it('refuses a `page` and a `pages` that name different pages', async () => {
    const source = await largeDocument();
    const error = await captureError(() => convertFile(source, 'pdf', 'pdf', { page: 2, pages: '3' }, 'large.pdf'));
    expect(error).toBeInstanceOf(InvalidPageRangeError);
    expect(error.message).toBe('The "page" option (2) and the "pages" option ("3") select different pages');
  });
});

describe.skipIf(SKIP)('pages for PDF to Markdown', () => {
  it('writes the text of the selected pages only', async () => {
    const source = await plainPdf(['ALPHAONE', 'BRAVOTWO', 'CHARLIETHREE']);
    const text = (await convertFile(source, 'pdf', 'md', { pages: '2-3' }, 'a.pdf')).buffer.toString('utf8');
    expect(text.split(/\s+/).filter((word) => word !== '')).toEqual(['BRAVOTWO', 'CHARLIETHREE']);
  });
});
