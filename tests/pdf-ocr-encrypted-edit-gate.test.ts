import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { PdfPermissionDeniedError } from '../src/lib/types';
import { captureError } from './helpers/capture-error';
import { AES_256, pdftotext, qpdfEncrypt, qpdfEncryptionReport } from './helpers/encrypted-pdf-fixtures';
import { skipUnless, skipWithoutTools } from './helpers/strict-skip';
import { hasTesseractLanguage } from './helpers/tessdata';

/**
 * OCR to PDF writes a new PDF from a decrypted copy, so it is an edit of the document: an owner-restricted file is
 * rebuilt only with the owner password or the confirmation of the right to edit, as unlock and protect require.
 */

const WORD = 'HARBOR';
const PAGE_WIDTH = 480;
const PAGE_HEIGHT = 160;
const OCR_TIMEOUT_MS = 120_000;
const OWNER_PASSWORD = 'owner-secret-1';
const HTTP_UNPROCESSABLE = 422;
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
  doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]).drawImage(image, { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT });
  return Buffer.from(await doc.save());
}

/** The scan with an empty open password, an owner password, and every edit forbidden. */
async function ownerRestrictedScan(): Promise<Buffer> {
  return qpdfEncrypt(await buildImageOnlyPdf(), { variant: AES_256, ownerPassword: OWNER_PASSWORD, modify: 'none' });
}

const skipped = skipUnless('eng.traineddata (Tesseract English data)', hasTesseractLanguage('eng')) || skipWithoutTools('qpdf', 'pdftotext');

describe.skipIf(skipped)('OCR of a PDF to PDF (needs eng.traineddata, qpdf, pdftotext)', () => {
  it('refuses an owner-restricted PDF without the owner password or the confirmation, so no unprotected copy is made', async () => {
    const error = await captureError(async () => dispatchConversion(await ownerRestrictedScan(), 'pdf', 'pdf', { ocrEnabled: true }, 'scan.pdf'));
    expect(error).toBeInstanceOf(PdfPermissionDeniedError);
    expect((error as PdfPermissionDeniedError).status).toBe(HTTP_UNPROCESSABLE);
  }, OCR_TIMEOUT_MS);

  it('refuses the rebuild of a scanned owner-restricted PDF when OCR was not requested either', async () => {
    const error = await captureError(async () => dispatchConversion(await ownerRestrictedScan(), 'pdf', 'pdf', {}, 'scan.pdf'));
    expect(error).toBeInstanceOf(PdfPermissionDeniedError);
    expect((error as PdfPermissionDeniedError).status).toBe(HTTP_UNPROCESSABLE);
  }, OCR_TIMEOUT_MS);

  it.each([
    ['the owner password', { password: OWNER_PASSWORD }],
    ['the confirmation of the right to edit', { confirmEditRights: true }],
  ])('rebuilds an owner-restricted PDF searchable with %s, as an unencrypted file', async (_label, access) => {
    const result = await dispatchConversion(await ownerRestrictedScan(), 'pdf', 'pdf', { ocrEnabled: true, ...access }, 'scan.pdf');
    expect(qpdfEncryptionReport(result.buffer).encrypted).toBe(false);
    expect(pdftotext(result.buffer).toUpperCase()).toContain(WORD);
  }, OCR_TIMEOUT_MS);

  it('rebuilds a PDF that is not encrypted searchable without any access option', async () => {
    const result = await dispatchConversion(await buildImageOnlyPdf(), 'pdf', 'pdf', { ocrEnabled: true }, 'scan.pdf');
    expect(pdftotext(result.buffer).toUpperCase()).toContain(WORD);
  }, OCR_TIMEOUT_MS);
});
