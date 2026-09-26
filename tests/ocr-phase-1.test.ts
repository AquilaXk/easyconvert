import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '../src/app/api/convert/route';
import { convertFile } from '../src/lib/conversions/index';
import { parseConverterSlug } from '../src/lib/slug-parser';
import { FORMAT_REGISTRY } from '../src/lib/registry';

// Self-contained standard PDF-1.4 blank page without dependencies
const BLANK_PDF_STREAM = Buffer.from(
  '%PDF-1.4\n' +
  '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
  '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n' +
  '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] >> endobj\n' +
  'xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n' +
  'trailer << /Size 4 /Root 1 0 R >>\nstartxref\n190\n%%EOF'
);

describe('Phase 1: Fail-Closed Enforcement & Schema Sync', () => {
  it('throws clear error instead of silently returning input buffer when OCR is requested on blank/unsupported PDF', async () => {
    // Converting blank document with ocrEnabled: true must FAIL-CLOSED
    await expect(
      convertFile(BLANK_PDF_STREAM, 'pdf', 'pdf', { ocrEnabled: true }, 'sample.pdf')
    ).rejects.toThrow(/PDF OCR failed/);
  });

  it('returns HTTP 400 in API route when PDF OCR fails or unsupported compression is encountered', async () => {
    const formData = new FormData();
    formData.append('file', new File([BLANK_PDF_STREAM], 'document.pdf', { type: 'application/pdf' }));
    formData.append('targetFormat', 'pdf');
    formData.append('options', JSON.stringify({ ocrEnabled: true }));

    const req = new NextRequest('http://localhost:3000/api/convert', {
      method: 'POST',
      body: formData,
    });

    const res = await POST(req);
    expect(res.status).toBe(400);

    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error).toMatch(/PDF OCR failed/);
  });

  it('registers /pdf-ocr and /ocr-pdf in slug-parser with correct metadata', () => {
    const parsed = parseConverterSlug('/pdf-ocr');
    expect(parsed.isInfoPage).toBe(false);
    expect(parsed.sourceFormat).toBe('pdf');
    expect(parsed.targetFormat).toBe('pdf');
    expect(parsed.pageTitle).toBe('PDF OCR Converter');

    const parsedNoSlash = parseConverterSlug('pdf-ocr');
    expect(parsedNoSlash.sourceFormat).toBe('pdf');
    expect(parsedNoSlash.targetFormat).toBe('pdf');

    const parsedAlt = parseConverterSlug('ocr-pdf');
    expect(parsedAlt.pageTitle).toBe('PDF OCR Converter');
  });

  it('synchronizes ocrEnabled and ocrLanguage across all primary image formats in FORMAT_REGISTRY', () => {
    const imageFormatsToCheck = ['png', 'jpg', 'jpeg', 'webp', 'avif', 'tiff', 'tif', 'bmp', 'gif', 'ico', 'heic', 'raw'];

    for (const fmt of imageFormatsToCheck) {
      const def = FORMAT_REGISTRY[fmt];
      expect(def, `Format ${fmt} must be registered`).toBeDefined();
      expect(def.optionsSchema?.ocrEnabled, `Format ${fmt} must have ocrEnabled in optionsSchema`).toBe(true);
      expect(def.optionsSchema?.ocrLanguage, `Format ${fmt} must have ocrLanguage in optionsSchema`).toBe(true);
    }
  });
});
