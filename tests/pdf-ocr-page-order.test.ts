import { describe, expect } from 'vitest';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { convertFile } from '../src/lib/conversions';
import { oracleTest } from './helpers/oracle-test';

/**
 * A scanned PDF read with OCR keeps its pages in order. Each page is one word at the same height; the first
 * page's word sits to the right of the second page's, so a reader that sorts the words of all pages together by
 * position puts page two first. The expected order is simply the page order of the file.
 */

const OCR_TIMEOUT_MS = 240_000;
const PAGE_WIDTH_PX = 900;
const PAGE_HEIGHT_PX = 320;
const WORD_BASELINE_PX = 200;
const FONT_SIZE_PX = 96;

/** A page picture with `word` at horizontal position `x`. */
async function wordPage(word: string, x: number): Promise<Buffer> {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_WIDTH_PX}" height="${PAGE_HEIGHT_PX}"><rect width="100%" height="100%" fill="white"/>` +
    `<text x="${x}" y="${WORD_BASELINE_PX}" font-size="${FONT_SIZE_PX}" font-weight="bold" fill="black">${word}</text></svg>`;
  return sharp(Buffer.from(svg)).flatten({ background: '#ffffff' }).png().toBuffer();
}

async function scannedPdf(pages: Array<{ word: string; x: number }>): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (const { word, x } of pages) {
    const image = await doc.embedPng(await wordPage(word, x));
    const page = doc.addPage([image.width / 2, image.height / 2]);
    page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  }
  return Buffer.from(await doc.save());
}

describe('a scanned PDF read with OCR', () => {
  oracleTest('puts page one before page two in the text, wherever their words sit', ['tesseract'], async () => {
    const pdf = await scannedPdf([{ word: 'HELLO', x: 300 }, { word: 'WORLD', x: 20 }]);
    const text = (await convertFile(pdf, 'pdf', 'txt', {}, 'scan.pdf')).buffer.toString('utf-8').toUpperCase();
    expect(text.replace(/\s+/g, ' ').trim()).toBe('HELLO WORLD');
  }, OCR_TIMEOUT_MS);
});
