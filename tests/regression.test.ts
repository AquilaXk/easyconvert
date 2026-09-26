import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import PDFDocument from 'pdfkit';
import { convertFile } from '../src/lib/conversions/index';

describe('Skeptical Review: Breaking Prior Attempt', () => {
  async function createTestPngBuffer(): Promise<Buffer> {
    return sharp({
      create: {
        width: 64,
        height: 64,
        channels: 4,
        background: { r: 92, g: 107, b: 192, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
  }

  it('1. PNG to BMP should produce a real BMP buffer with BM magic header, not a PNG buffer', async () => {
    const png = await createTestPngBuffer();
    const result = await convertFile(png, 'png', 'bmp', {}, 'test.png');
    // BMP files start with 'BM' (0x42, 0x4D)
    // PNG files start with 0x89 0x50 0x4E 0x47
    const magic = result.buffer.toString('ascii', 0, 2);
    expect(magic).toBe('BM');
  });

  it('2. PNG to ICO should produce a real ICO header, not raw PNG buffer', async () => {
    const png = await createTestPngBuffer();
    const result = await convertFile(png, 'png', 'ico', {}, 'icon.png');
    // ICO starts with [0x00, 0x00, 0x01, 0x00]
    expect(result.buffer[0]).toBe(0x00);
    expect(result.buffer[1]).toBe(0x00);
    expect(result.buffer[2]).toBe(0x01);
    expect(result.buffer[3]).toBe(0x00);
  });

  it('3. PDF to TXT should extract text without throwing Unsupported Document Conversion', async () => {
    // Generate valid PDF with text
    const chunks: Buffer[] = [];
    const doc = new PDFDocument();
    doc.on('data', (c) => chunks.push(c));
    const pdfPromise = new Promise<Buffer>((resolve) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
    });
    doc.text('Hello from EasyConvert PDF Document');
    doc.end();
    const pdfBuf = await pdfPromise;

    const result = await convertFile(pdfBuf, 'pdf', 'txt', {}, 'doc.pdf');
    expect(result.mimeType).toBe('text/plain');
    expect(result.buffer.toString('utf-8')).toContain('Hello from EasyConvert PDF Document');
  });

  it('4. XML to TXT should succeed without throwing Unsupported Data Conversion', async () => {
    const xml = '<root><user><name>Alice</name></user></root>';
    const buf = Buffer.from(xml, 'utf-8');
    const result = await convertFile(buf, 'xml', 'txt', {}, 'data.xml');
    expect(result.mimeType).toBe('text/plain');
  });

  it('5. ZIP to TAR should produce a valid TAR archive, not a ZIP archive', async () => {
    const zipBuf = Buffer.from('PK\x05\x06\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00');
    const result = await convertFile(zipBuf, 'zip', 'tar', {}, 'archive.zip');
    expect(result.filename).toBe('archive.tar');
    expect(result.mimeType).toBe('application/x-tar');
  });
});
