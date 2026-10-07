import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { convertFile } from '../src/lib/conversions';
import { ConversionFailedError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';

/**
 * PDF to PDF with OCR returns the input unchanged only when OCR had nothing to do (skip_text and every page
 * already has text), and says so. A page OCR could not read is an error, never the original file.
 */

const TEXT_PDF = path.resolve(__dirname, 'fixtures', 'sample.pdf');
const BLANK_SIDE = 400;

async function blankScanPdf(): Promise<Buffer> {
  const png = await sharp({ create: { width: BLANK_SIDE, height: BLANK_SIDE, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const doc = await PDFDocument.create();
  const page = doc.addPage([BLANK_SIDE, BLANK_SIDE]);
  page.drawImage(await doc.embedPng(png), { x: 0, y: 0, width: BLANK_SIDE, height: BLANK_SIDE });
  return Buffer.from(await doc.save());
}

describe('PDF to PDF with OCR', () => {
  oracleTest('a scan with no recognisable text is refused with a typed 400 error', ['tesseract'], async () => {
    const run = convertFile(await blankScanPdf(), 'pdf', 'pdf', { ocrEnabled: true }, 'blank.pdf');
    await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(run).rejects.toThrow(/PDF OCR failed/);
  }, 120_000);

  it('skip_text on a PDF whose pages all have text returns the input and reports ocrSkipped', async () => {
    const input = fs.readFileSync(TEXT_PDF);
    const result = await convertFile(input, 'pdf', 'pdf', { ocrEnabled: true, ocrMode: 'skip_text' }, 'sample.pdf');
    expect(result.ocrSkipped).toBe(true);
    expect(result.buffer.equals(input)).toBe(true);
  }, 120_000);

  it('a plain PDF to PDF conversion without OCR does not claim that OCR was skipped', async () => {
    const result = await convertFile(fs.readFileSync(TEXT_PDF), 'pdf', 'pdf', {}, 'sample.pdf');
    expect(result.ocrSkipped).toBeUndefined();
  }, 120_000);
});
