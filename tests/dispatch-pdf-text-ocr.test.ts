import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { skipUnless, skipWithoutTools } from './helpers/strict-skip';
import { hasTesseractLanguage } from './helpers/tessdata';

const WORD = 'HARBOR';
const PAGE_WIDTH = 480;
const PAGE_HEIGHT = 160;
const OCR_TIMEOUT_MS = 120_000;
const TEXT_SVG = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_WIDTH}" height="${PAGE_HEIGHT}">` +
    `<rect width="${PAGE_WIDTH}" height="${PAGE_HEIGHT}" fill="#ffffff"/>` +
    `<text x="40" y="105" font-family="DejaVu Sans, sans-serif" font-size="72" fill="#000000">${WORD}</text></svg>`,
  'utf-8'
);

/** A PDF whose only page content is a raster image of rendered text: it has no text layer. */
async function buildImageOnlyPdf(): Promise<Buffer> {
  const png = await sharp(TEXT_SVG).flatten({ background: '#ffffff' }).png().toBuffer();
  const doc = await PDFDocument.create();
  const image = await doc.embedPng(png);
  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  page.drawImage(image, { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT });
  return Buffer.from(await doc.save());
}

describe.skipIf(skipUnless('eng.traineddata (Tesseract English data)', hasTesseractLanguage('eng')) || skipWithoutTools('pdftotext'))('pdf to txt on an image-only PDF (needs eng.traineddata, pdftotext)', () => {
  it('recognizes the page text when OCR is requested instead of returning the empty text layer', async () => {
    const pdf = await buildImageOnlyPdf();
    const result = await dispatchConversion(pdf, 'pdf', 'txt', { ocrEnabled: true }, 'scan.pdf');
    expect(result.engineUsed).toBe('internal-fallback');
    expect(result.buffer.toString('utf-8').toUpperCase()).toContain(WORD);
  }, OCR_TIMEOUT_MS);

  it('falls back to scanned-page OCR when pdftotext finds no text without OCR being requested', async () => {
    const pdf = await buildImageOnlyPdf();
    const result = await dispatchConversion(pdf, 'pdf', 'txt', {}, 'scan.pdf');
    expect(result.engineUsed).toBe('internal-fallback');
    expect(result.buffer.toString('utf-8').toUpperCase()).toContain(WORD);
  }, OCR_TIMEOUT_MS);
});
