import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { isClientEdgeOcrSupported, runClientEdgeOcr } from '../src/lib/edge-ocr/index';

describe('Phase 4: Client-Side Browser Edge OCR & Zero-Data Retention', () => {
  it('detects client edge OCR environment support', () => {
    const supported = isClientEdgeOcrSupported();
    expect(typeof supported).toBe('boolean');
    expect(supported).toBe(true);
  });

  it('transforms bitmap image to searchable PDF entirely in-memory', async () => {
    const pngBuffer = await sharp({
      create: { width: 160, height: 80, channels: 3, background: '#3b82f6' },
    })
      .png()
      .toBuffer();

    const mockFile = new File([pngBuffer], 'scan_receipt.png', { type: 'image/png' });

    let reportedProgress = 0;
    const result = await runClientEdgeOcr(mockFile, { ocrEnabled: true, clientEdgeMode: true }, (p) => {
      reportedProgress = p;
    });

    expect(result.blob).toBeInstanceOf(Blob);
    expect(result.blob.type).toBe('application/pdf');
    expect(result.blob.size).toBeGreaterThan(0);
    expect(result.filename).toBe('scan_receipt.pdf');
    expect(reportedProgress).toBe(100);

    const pdfArrayBuffer = await result.blob.arrayBuffer();
    const loadedPdf = await PDFDocument.load(pdfArrayBuffer);
    expect(loadedPdf.getPageCount()).toBe(1);
    expect(loadedPdf.getTitle()).toBe('scan_receipt');
  });

  it('processes multi-page PDF documents locally preserving original vector catalog', async () => {
    const doc = await PDFDocument.create();
    doc.setTitle('Edge Encrypted Invoice');
    doc.addPage([300, 500]);
    doc.addPage([300, 500]);
    const pdfBytes = await doc.save();

    const pdfFile = new File([pdfBytes], 'encrypted_invoice.pdf', { type: 'application/pdf' });

    const result = await runClientEdgeOcr(pdfFile, { ocrEnabled: true, clientEdgeMode: true });

    expect(result.filename).toBe('encrypted_invoice.pdf');
    expect(result.blob.size).toBeGreaterThan(0);

    const loaded = await PDFDocument.load(await result.blob.arrayBuffer());
    expect(loaded.getPageCount()).toBe(2);
    expect(loaded.getTitle()).toBe('Edge Encrypted Invoice');
  });
});
