if (typeof (Promise as any).withResolvers === 'undefined') {
  (Promise as any).withResolvers = function <T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: any) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import zlib from 'zlib';
import { convertFile } from '../src/lib/conversions/index';
import { performOcr } from '../src/lib/conversions/ocr';
import { createLosslessSandwichPdfFromImage } from '../src/lib/conversions/ocr-pdf-combiner';

describe('Phase 3: Lossless Sandwich PDF Injection & Metadata Preservation', () => {
  it('preserves 100% of original PDF metadata and injects 3 Tr transparent text stream', async () => {
    // 1. Build original document with distinct metadata
    const origDoc = await PDFDocument.create();
    origDoc.setTitle('Confidential Enterprise Report');
    origDoc.setAuthor('AquilaXk Engineering');
    origDoc.setSubject('Zero Data Retention Parity');

    // Add visual image to page
    const testImg = await sharp({
      create: { width: 200, height: 100, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .composite([
        {
          input: Buffer.from('<svg width="200" height="100"><text x="10" y="50" font-size="20" fill="black">INVOICE</text></svg>'),
          top: 0,
          left: 0,
        },
      ])
      .png()
      .toBuffer();

    const emb = await origDoc.embedPng(testImg);
    const page = origDoc.addPage([400, 600]);
    page.drawImage(emb, { x: 50, y: 400, width: 200, height: 100 });

    const origBytes = await origDoc.save();
    const origBuffer = Buffer.from(origBytes);

    // 2. Perform conversion to searchable PDF via convertFile
    const converted = await convertFile(
      origBuffer,
      'pdf',
      'pdf',
      { ocrEnabled: true },
      'invoice.pdf'
    );

    expect(converted.mimeType).toBe('application/pdf');
    expect(converted.size).toBeGreaterThan(0);

    // 3. Inspect final PDF with pdf-lib to prove 100% metadata preservation
    const finalDoc = await PDFDocument.load(converted.buffer);
    expect(finalDoc.getTitle()).toBe('Confidential Enterprise Report');
    expect(finalDoc.getAuthor()).toBe('AquilaXk Engineering');
    expect(finalDoc.getSubject()).toBe('Zero Data Retention Parity');

    // 4. Verify that the stream contains invisible text rendering mode (3 Tr) and matrix (Tm)
    const binary = converted.buffer.toString('binary');
    const streamRegex = /stream[\r\n]+([\s\S]*?)[\r\n]+endstream/g;
    let match: RegExpExecArray | null;
    let has3Tr = false;
    let hasTm = false;

    while ((match = streamRegex.exec(binary)) !== null) {
      let inflated = '';
      try {
        inflated = zlib.inflateSync(Buffer.from(match[1], 'binary')).toString('latin1');
      } catch {
        try {
          inflated = zlib.inflateRawSync(Buffer.from(match[1], 'binary')).toString('latin1');
        } catch {
          inflated = match[1];
        }
      }

      if (inflated.includes('3 Tr')) has3Tr = true;
      if (inflated.includes('Tm')) hasTm = true;
    }

    expect(has3Tr).toBe(true);
    expect(hasTm).toBe(true);
  });

  it('creates lossless searchable PDF directly from bitmap image using pdf-lib', async () => {
    const testImage = await sharp({
      create: { width: 250, height: 80, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .composite([
        {
          input: Buffer.from('<svg width="250" height="80"><text x="10" y="40" font-size="18" fill="black">SEARCHABLE</text></svg>'),
          top: 0,
          left: 0,
        },
      ])
      .png()
      .toBuffer();

    const ocrResult = await performOcr(testImage);
    const searchablePdfBuffer = await createLosslessSandwichPdfFromImage(testImage, ocrResult, {}, 'Receipt');

    expect(searchablePdfBuffer.length).toBeGreaterThan(0);
    const loaded = await PDFDocument.load(searchablePdfBuffer);
    expect(loaded.getPageCount()).toBe(1);
    expect(loaded.getTitle()).toBe('Receipt');
  });

  it('merges multiple raster images on the same page into unified searchable text', async () => {
    const imgTop = await sharp({
      create: { width: 140, height: 50, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .composite([{ input: Buffer.from('<svg width="140" height="50"><text x="10" y="30" font-size="16" fill="black">TOP_SECTION</text></svg>'), top: 0, left: 0 }])
      .png().toBuffer();

    const imgBottom = await sharp({
      create: { width: 140, height: 50, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .composite([{ input: Buffer.from('<svg width="140" height="50"><text x="10" y="30" font-size="16" fill="black">BOTTOM_SECTION</text></svg>'), top: 0, left: 0 }])
      .png().toBuffer();

    const doc = await PDFDocument.create();
    const emb1 = await doc.embedPng(imgTop);
    const emb2 = await doc.embedPng(imgBottom);

    const p1 = doc.addPage([300, 400]);
    p1.drawImage(emb1, { x: 20, y: 250, width: 140, height: 50 });
    p1.drawImage(emb2, { x: 20, y: 50, width: 140, height: 50 });

    const pdfBytes = await doc.save();
    const converted = await convertFile(Buffer.from(pdfBytes), 'pdf', 'txt', { ocrEnabled: true }, 'multi_img.pdf');
    const text = converted.buffer.toString('utf-8');
    expect(text.length).toBeGreaterThan(0);
  });

  it('safely handles non-WinAnsi and CJK characters in sandwich PDF without crashing', async () => {
    const cjkImage = await sharp({
      create: { width: 200, height: 60, channels: 3, background: { r: 255, g: 255, b: 255 } },
    }).png().toBuffer();

    const ocrResult = {
      text: '영수증 10,000원 Receipt',
      confidence: 0.95,
      wordCount: 3,
      lines: ['영수증 10,000원 Receipt'],
      lineBlocks: [
        {
          text: '영수증 10,000원 Receipt',
          bbox: { x: 10, y: 10, width: 180, height: 40 },
          words: [
            { text: '영수증', bbox: { x: 10, y: 10, width: 50, height: 40 } },
            { text: '10,000원', bbox: { x: 70, y: 10, width: 60, height: 40 } },
            { text: 'Receipt', bbox: { x: 140, y: 10, width: 50, height: 40 } },
          ],
        },
      ],
    };

    const sandwich = await createLosslessSandwichPdfFromImage(cjkImage, ocrResult, {}, 'CJK Document');
    expect(sandwich.length).toBeGreaterThan(0);
    const loaded = await PDFDocument.load(sandwich);
    expect(loaded.getPageCount()).toBe(1);
  });
});
