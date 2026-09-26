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
import { extractRasterImagesFromPdf } from '../src/lib/conversions/pdf-rasterizer';
import { performOcr } from '../src/lib/conversions/ocr';

describe('Phase 2: WASM Inference Engine & 300 DPI Rasterizer', () => {
  it('rasterizes and extracts embedded images from multi-page PDFs at 300 DPI using pdfjs-dist', async () => {
    // Generate synthetic 2-page scanned PDF with embedded bitmaps
    const makePng = async (label: string) =>
      sharp({
        create: { width: 120, height: 60, channels: 3, background: { r: 255, g: 255, b: 255 } },
      })
        .composite([
          {
            input: Buffer.from(`<svg width="120" height="60"><text x="10" y="35" font-size="16" fill="black">${label}</text></svg>`),
            top: 0,
            left: 0,
          },
        ])
        .png()
        .toBuffer();

    const [img1, img2] = await Promise.all([makePng('PAGE1'), makePng('PAGE2')]);

    const pdfDoc = await PDFDocument.create();
    const emb1 = await pdfDoc.embedPng(img1);
    const emb2 = await pdfDoc.embedPng(img2);

    const p1 = pdfDoc.addPage([300, 400]);
    p1.drawImage(emb1, { x: 20, y: 150, width: 120, height: 60 });

    const p2 = pdfDoc.addPage([300, 400]);
    p2.drawImage(emb2, { x: 20, y: 150, width: 120, height: 60 });

    const pdfBytes = await pdfDoc.save();
    const pdfBuffer = Buffer.from(pdfBytes);

    const extracted = await extractRasterImagesFromPdf(pdfBuffer, 300);
    expect(extracted.length).toBe(2);
    expect(extracted[0].pageNumber).toBe(1);
    expect(extracted[1].pageNumber).toBe(2);
    expect(extracted[0].buffer.length).toBeGreaterThan(0);
    expect(extracted[1].buffer.length).toBeGreaterThan(0);
  });

  it('extracts structured lineBlocks, bounding boxes, and words with performOcr', async () => {
    const testImage = await sharp({
      create: { width: 300, height: 100, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .composite([
        {
          input: Buffer.from('<svg width="300" height="100"><text x="20" y="45" font-family="monospace" font-size="24" fill="black">EASYCONVERT</text></svg>'),
          top: 0,
          left: 0,
        },
      ])
      .png()
      .toBuffer();

    const ocrResult = await performOcr(testImage, 'auto');
    expect(ocrResult.text).toBeDefined();
    expect(ocrResult.confidence).toBeGreaterThan(0.5);
    expect(ocrResult.lines.length).toBeGreaterThan(0);
    if (ocrResult.lineBlocks && ocrResult.lineBlocks.length > 0) {
      const block = ocrResult.lineBlocks[0];
      expect(block.bbox.width).toBeGreaterThan(0);
      expect(block.bbox.height).toBeGreaterThan(0);
    }
  });

  it('decodes 1bpp bilevel raster images without memory area mismatch', async () => {
    const pdfRaw = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 1 /Length 8 >>
stream
\xaa\x55\xaa\x55\xaa\x55\xaa\x55
endstream
endobj
5 0 obj
<< /Length 27 >>
stream
q 8 0 0 8 0 0 cm /Im1 Do Q
endstream
endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000250 00000 n 
0000000395 00000 n 
trailer
<< /Size 6 /Root 1 0 R >>
startxref
475
%%EOF`;

    const images = await extractRasterImagesFromPdf(Buffer.from(pdfRaw, 'binary'), 300);
    expect(images.length).toBe(1);
    expect(images[0].width).toBe(8);
    expect(images[0].height).toBe(8);
    expect(images[0].buffer.length).toBeGreaterThan(0);
  });

  it('throws fail-closed error when encountering corrupted or invalid PDF stream', async () => {
    const corruptedBytes = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\ncorrupted garbage bytes\n%%EOF');
    await expect(extractRasterImagesFromPdf(corruptedBytes, 300)).rejects.toThrow(/PDF OCR failed/);
  });
});
