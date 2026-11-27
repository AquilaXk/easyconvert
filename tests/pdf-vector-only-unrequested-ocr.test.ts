import { describe, expect, it } from 'vitest';
import { PDFDocument, rgb } from 'pdf-lib';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { convertFile } from '../src/lib/conversions/index';
import { captureError } from './helpers/capture-error';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * A drawing with no text is not a scan. A PDF target with no OCR options returns the document, and the recognition that the
 * request did not ask for is best effort: no image to read, no word found and a render over the pixel limit leave the
 * document as it is and say so in the conversion warnings. Requested OCR keeps refusing. Illustrator files are PDFs, so
 * `ai` takes the same branch; the real files are the PDF-compatible Illustrator artwork of bench/realworld/manifest.json.
 */

const toolsMissing = skipWithoutTools('pdftoppm', 'pdftotext');
const TEST_TIMEOUT_MS = 180_000;
const SMALL_PAGE_POINTS = 200;
const OVER_PIXEL_LIMIT_PAGE_POINTS = 12_000;
const PDF_MAGIC = '%PDF';

/** Two pages with a filled rectangle and no text (a curve would read as letters to the recognizer). */
async function vectorOnlyPdf(pageSide = SMALL_PAGE_POINTS): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let page = 0; page < 2; page++) {
    const drawn = doc.addPage([pageSide, pageSide]);
    drawn.drawRectangle({ x: pageSide / 10, y: pageSide / 10, width: pageSide / 2, height: pageSide / 3, color: rgb(0.8, 0.1, 0.1) });
  }
  return Buffer.from(await doc.save());
}

async function pageCountOf(pdf: Buffer): Promise<number> {
  return (await PDFDocument.load(pdf)).getPageCount();
}

describe.skipIf(toolsMissing)('PDF target of a document with no text, OCR not requested', () => {
  it('returns a vector-only PDF as it is, with a warning', async () => {
    const input = await vectorOnlyPdf();
    const result = await convertFile(input, 'pdf', 'pdf', {}, 'drawing.pdf');
    expect(result.buffer.subarray(0, PDF_MAGIC.length).toString('latin1')).toBe(PDF_MAGIC);
    expect(await pageCountOf(result.buffer)).toBe(2);
    expect((result.metadata?.warnings as string[] | undefined)?.some((line) => line.includes('did not ask for'))).toBe(true);
  }, TEST_TIMEOUT_MS);

  it('converts the same bytes named .ai to a PDF', async () => {
    const result = await dispatchConversion(await vectorOnlyPdf(), 'ai', 'pdf', {}, 'logo.ai');
    expect(result.buffer.subarray(0, PDF_MAGIC.length).toString('latin1')).toBe(PDF_MAGIC);
    expect(await pageCountOf(result.buffer)).toBe(2);
  }, TEST_TIMEOUT_MS);

  it('returns an artboard that is over the pixel limit at the OCR resolution, with a warning', async () => {
    const result = await convertFile(await vectorOnlyPdf(OVER_PIXEL_LIMIT_PAGE_POINTS), 'pdf', 'pdf', {}, 'artboard.pdf');
    expect(result.buffer.subarray(0, PDF_MAGIC.length).toString('latin1')).toBe(PDF_MAGIC);
    expect(await pageCountOf(result.buffer)).toBe(2);
    expect((result.metadata?.warnings as string[] | undefined)?.some((line) => line.includes('did not ask for'))).toBe(true);
  }, TEST_TIMEOUT_MS);

  it('still refuses a drawing with no text when OCR is requested', async () => {
    const error = await captureError(async () => dispatchConversion(await vectorOnlyPdf(), 'pdf', 'pdf', { ocrEnabled: true }, 'drawing.pdf'));
    expect(error.message).toMatch(/PDF OCR failed|pixel/i);
  }, TEST_TIMEOUT_MS);
});

/** The Illustrator files whose conversion to PDF was refused for OCR that nobody asked for. */
const REAL_ILLUSTRATOR_FILES = [
  'asf-feather_logo_cmyk.ai',
  'asf-apache-20th-badge-1-cmyk.ai',
  'asf-crimson-the_apache_way_badge-rgb.ai',
  'jupyter-jupiter.ai',
  'jupyter-julia.ai',
  'nps-area-map-starter.ai',
  'nps-we-map-starter.ai',
] as const;

describe.skipIf(toolsMissing)('real Illustrator files to PDF', () => {
  for (const id of REAL_ILLUSTRATOR_FILES) {
    it(`${id} converts to a PDF`, async (ctx) => {
      const sample = await requireRealworldSample(ctx, id);
      const result = await dispatchConversion(sample.bytes, 'ai', 'pdf', {}, id);
      expect(result.buffer.subarray(0, PDF_MAGIC.length).toString('latin1')).toBe(PDF_MAGIC);
      expect(await pageCountOf(result.buffer)).toBe(await pageCountOf(sample.bytes));
    }, TEST_TIMEOUT_MS);
  }
});
