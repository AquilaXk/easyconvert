import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { convertFile, createZipArchive } from '../src/lib/conversions/index.ts';

describe('Conversion Engine Integration Tests', () => {
  // Helper to generate a valid test PNG image
  async function createTestPngBuffer(): Promise<Buffer> {
    return sharp({
      create: {
        width: 100,
        height: 100,
        channels: 4,
        background: { r: 92, g: 107, b: 192, alpha: 1 }, // Lavender brand color
      },
    })
      .png()
      .toBuffer();
  }

  describe('Image Conversions', () => {
    it('converts PNG to JPG with quality settings', async () => {
      const pngBuffer = await createTestPngBuffer();
      const result = await convertFile(pngBuffer, 'png', 'jpg', { quality: 80 }, 'test.png');

      expect(result.mimeType).toBe('image/jpeg');
      expect(result.filename).toBe('test.jpg');
      expect(result.size).toBeGreaterThan(0);

      // Verify converted buffer is valid JPEG via sharp metadata
      const meta = await sharp(result.buffer).metadata();
      expect(meta.format).toBe('jpeg');
      expect(meta.width).toBe(100);
      expect(meta.height).toBe(100);
    });

    it('converts PNG to WEBP with custom dimensions', async () => {
      const pngBuffer = await createTestPngBuffer();
      const result = await convertFile(
        pngBuffer,
        'png',
        'webp',
        { width: 50, height: 50, fit: 'cover' },
        'icon.png'
      );

      expect(result.mimeType).toBe('image/webp');
      expect(result.filename).toBe('icon.webp');

      const meta = await sharp(result.buffer).metadata();
      expect(meta.format).toBe('webp');
      expect(meta.width).toBe(50);
      expect(meta.height).toBe(50);
    });

    it('converts PNG to PDF document', async () => {
      const pngBuffer = await createTestPngBuffer();
      const result = await convertFile(pngBuffer, 'png', 'pdf', {}, 'photo.png');

      expect(result.mimeType).toBe('application/pdf');
      expect(result.filename).toBe('photo.pdf');
      expect(result.buffer.toString('utf-8', 0, 4)).toBe('%PDF');
    });
  });

  describe('Document Conversions', () => {
    it('converts Markdown to HTML with typography styling', async () => {
      const mdContent = '# EasyConvert\n\n**Universal** file converter with `lavender` theme.';
      const buffer = Buffer.from(mdContent, 'utf-8');

      const result = await convertFile(buffer, 'md', 'html', {}, 'sample.md');
      expect(result.mimeType).toBe('text/html');
      expect(result.filename).toBe('sample.html');

      const html = result.buffer.toString('utf-8');
      expect(html).toContain('<h1>EasyConvert</h1>');
      expect(html).toContain('<strong>Universal</strong>');
      expect(html).toContain('<code>lavender</code>');
    });

    it('converts Markdown to PDF document', async () => {
      const mdContent = '# Report\n\nTesting PDF generation via EasyConvert.';
      const buffer = Buffer.from(mdContent, 'utf-8');

      const result = await convertFile(buffer, 'md', 'pdf', { orientation: 'portrait' }, 'report.md');
      expect(result.mimeType).toBe('application/pdf');
      expect(result.filename).toBe('report.pdf');
      expect(result.buffer.toString('utf-8', 0, 4)).toBe('%PDF');
    });

    it('converts Plain Text to HTML', async () => {
      const textContent = 'Simple line 1\nSimple line 2';
      const buffer = Buffer.from(textContent, 'utf-8');

      const result = await convertFile(buffer, 'txt', 'html', {}, 'notes.txt');
      expect(result.mimeType).toBe('text/html');
      expect(result.filename).toBe('notes.html');
      expect(result.buffer.toString('utf-8')).toContain('Simple line 1');
    });
  });

  describe('Data Conversions', () => {
    it('converts CSV to JSON structure', async () => {
      const csvContent = 'id,name,role\n1,Alice,Engineer\n2,Bob,Designer';
      const buffer = Buffer.from(csvContent, 'utf-8');

      const result = await convertFile(buffer, 'csv', 'json', {}, 'users.csv');
      expect(result.mimeType).toBe('application/json');
      expect(result.filename).toBe('users.json');

      const parsed = JSON.parse(result.buffer.toString('utf-8'));
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].name).toBe('Alice');
      expect(parsed[1].role).toBe('Designer');
    });

    it('converts JSON to CSV table', async () => {
      const jsonData = [{ product: 'Widget A', price: 10 }, { product: 'Widget B', price: 20 }];
      const buffer = Buffer.from(JSON.stringify(jsonData), 'utf-8');

      const result = await convertFile(buffer, 'json', 'csv', {}, 'pricing.json');
      expect(result.mimeType).toBe('text/csv');
      expect(result.filename).toBe('pricing.csv');

      const csv = result.buffer.toString('utf-8');
      expect(csv).toContain('product,price');
      expect(csv).toContain('Widget A,10');
    });

    it('converts JSON to YAML', async () => {
      const jsonData = { server: { port: 8080, host: '0.0.0.0' } };
      const buffer = Buffer.from(JSON.stringify(jsonData), 'utf-8');

      const result = await convertFile(buffer, 'json', 'yaml', {}, 'config.json');
      expect(result.mimeType).toBe('application/x-yaml');
      expect(result.filename).toBe('config.yaml');

      const yaml = result.buffer.toString('utf-8');
      expect(yaml).toContain('port: 8080');
      expect(yaml).toContain('host: 0.0.0.0');
    });
  });

  describe('Archive Packaging', () => {
    it('packages multiple files into a valid ZIP archive', async () => {
      const file1 = { filename: 'file1.txt', buffer: Buffer.from('hello 1', 'utf-8') };
      const file2 = { filename: 'file2.txt', buffer: Buffer.from('hello 2', 'utf-8') };

      const zipResult = await createZipArchive([file1, file2], { compressionLevel: 9 }, 'test.zip');
      expect(zipResult.mimeType).toBe('application/zip');
      expect(zipResult.filename).toBe('test.zip');
      expect(zipResult.size).toBeGreaterThan(0);
      // ZIP magic bytes: PK (0x50, 0x4B)
      expect(zipResult.buffer[0]).toBe(0x50);
      expect(zipResult.buffer[1]).toBe(0x4b);
    });

    it('converts any single file to ZIP archive', async () => {
      const buffer = Buffer.from('single file content', 'utf-8');
      const result = await convertFile(buffer, 'txt', 'zip', {}, 'single.txt');

      expect(result.mimeType).toBe('application/zip');
      expect(result.filename).toBe('single.zip');
      expect(result.buffer[0]).toBe(0x50);
    });
  });

  describe('Fail-Closed Boundary & Error Tests', () => {
    it('rejects empty input buffer with clear error', async () => {
      const emptyBuffer = Buffer.alloc(0);
      await expect(
        convertFile(emptyBuffer, 'png', 'jpg', {}, 'empty.png')
      ).rejects.toThrow(/empty/i);
    });

    it('rejects unknown source format', async () => {
      const buffer = Buffer.from('content', 'utf-8');
      await expect(
        convertFile(buffer, 'unknown_format_xyz', 'jpg', {}, 'file.xyz')
      ).rejects.toThrow(/unsupported source format/i);
    });

    it('rejects forbidden/unsupported conversion pairing', async () => {
      const buffer = Buffer.from('some text', 'utf-8');
      await expect(
        convertFile(buffer, 'csv', 'gif', {}, 'file.csv')
      ).rejects.toThrow(/cannot convert from/i);
    });

    it('rejects corrupted JSON during JSON conversion', async () => {
      const badJson = Buffer.from('{"unclosed: 123', 'utf-8');
      await expect(
        convertFile(badJson, 'json', 'csv', {}, 'bad.json')
      ).rejects.toThrow(/JSON parsing failed/i);
    });
  });
});
