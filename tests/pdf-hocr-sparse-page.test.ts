import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { requireRealworldSample } from './helpers/realworld-sample';

/**
 * A PDF page whose text layer is below the density threshold (a page that holds only its number) is recognized instead of read.
 * When recognition finds nothing on it, the page kept its text but not the word boxes, and the whole document was refused with
 * "hOCR/ALTO need word geometry: page 2 has text but no recognized lines" (govdocs1-002473.pdf, 32 pages, page 2 holds a "2").
 * The page now takes its word boxes from its own text layer, as the pages above the threshold do.
 */

async function bookWithNumberPage(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const first = doc.addPage([612, 792]);
  const sentence = 'The purpose of this publication is to showcase the efforts of ten cities that built programs for families.';
  for (let line = 0; line < 12; line += 1) first.drawText(sentence, { x: 54, y: 700 - line * 20, size: 10, font });
  // Recognition sees a blank page: the number is in the text layer only.
  doc.addPage([612, 792]).drawText('2', { x: 54, y: 700, size: 24, font, color: rgb(1, 1, 1) });
  return Buffer.from(await doc.save());
}

describe('a PDF page that holds only its number is written as hOCR and ALTO', () => {
  for (const target of ['hocr', 'alto'] as const) {
    it(`gives page 2 of a synthetic book its word box in ${target}`, async () => {
      const result = (await dispatchConversion(await bookWithNumberPage(), 'pdf', target, {}, 'book.pdf')).buffer.toString('utf8');
      expect(result).toContain('publication');
      expect(result).toMatch(target === 'hocr' ? /<span class=['"]ocrx_word['"][^>]*>\s*2\s*</ : /CONTENT=['"]2['"]/);
    }, 120_000);
  }

  it('converts the real report govdocs1-002473.pdf to hOCR', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'govdocs1-002473.pdf');
    const hocr = (await dispatchConversion(bytes, 'pdf', 'hocr', {}, 'govdocs1-002473.pdf')).buffer.toString('utf8');
    expect((hocr.match(/class=['"]ocr_page['"]/g) ?? []).length).toBe(32);
  }, 300_000);
});
