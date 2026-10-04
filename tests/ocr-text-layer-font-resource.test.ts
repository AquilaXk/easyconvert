import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { PDFDocument, PDFName, PDFDict, PDFRawStream, decodePDFRawStream, PDFArray, PDFRef } from 'pdf-lib';
import { createLosslessSandwichPdfFromImage, type OcrResult } from '../src/lib/conversions/ocr-pdf-combiner';
import { oracleTest } from './helpers/oracle-test';
import { getOracleToolPath } from './helpers/differential-oracle';

/**
 * The invisible OCR text layer must select its font through a key that exists in the page's
 * /Resources /Font dictionary; otherwise PDF readers drop the text and the PDF is not searchable.
 */

const LINE_TEXT = 'Searchable invoice 7731';
const PAGE_WIDTH = 320;
const PAGE_HEIGHT = 120;

const OCR_RESULT: OcrResult = {
  text: LINE_TEXT,
  confidence: 0.9,
  wordCount: 3,
  lines: [LINE_TEXT],
  lineBlocks: [
    {
      text: LINE_TEXT,
      bbox: { x: 10, y: 40, width: 300, height: 24 },
      words: LINE_TEXT.split(' ').map((word, i) => ({
        text: word,
        bbox: { x: 10 + i * 100, y: 40, width: 90, height: 24 },
      })),
    },
  ],
};

async function sandwichPdf(): Promise<Buffer> {
  const png = await sharp({
    create: { width: PAGE_WIDTH, height: PAGE_HEIGHT, channels: 3, background: '#ffffff' },
  })
    .png()
    .toBuffer();
  return createLosslessSandwichPdfFromImage(png, OCR_RESULT, {}, 'font-resource');
}

function pageContent(doc: PDFDocument): string {
  const contents = doc.getPage(0).node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray() : [contents];
  return streams
    .map((ref) => doc.context.lookup(ref as PDFRef) as PDFRawStream)
    .map((stream) => Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1'))
    .join('\n');
}

describe('OCR text layer font resources', () => {
  it('every Tf operand names a font in the page resources', async () => {
    const doc = await PDFDocument.load(await sandwichPdf());
    const resources = doc.getPage(0).node.Resources() as PDFDict;
    const fontDict = resources.lookup(PDFName.of('Font'), PDFDict);
    const fontKeys = new Set(fontDict.keys().map((key) => key.decodeText()));

    const usedFonts = [...pageContent(doc).matchAll(/\/([^\s/]+)\s+[\d.]+\s+Tf/g)].map((m) => m[1]);

    expect(usedFonts.length).toBe(OCR_RESULT.lineBlocks!.length);
    for (const name of usedFonts) {
      expect(fontKeys).toContain(name);
    }
  });

  oracleTest('pdftotext extracts the text layer', ['pdftotext'], async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-font-'));
    try {
      const pdfPath = path.join(dir, 'out.pdf');
      fs.writeFileSync(pdfPath, await sandwichPdf());
      const pdftotext = getOracleToolPath('pdftotext') as string;
      const extracted = execFileSync(pdftotext, [pdfPath, '-'], { encoding: 'utf8' });
      expect(extracted.replace(/\s+/g, ' ').trim()).toBe(LINE_TEXT);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
