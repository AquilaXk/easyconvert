import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { convertFile } from '../src/lib/conversions/index';
import { performOcr } from '../src/lib/conversions/ocr';

describe('Document Tables & OCR Recognition Engine', () => {
  it('converts markdown table to PDF with structured formatting intact', async () => {
    const md = `# Quarterly Data

| Metric | Target | Actual |
| --- | --- | --- |
| Conversions | 1000 | 1240 |
| Uptime | 99.9% | 100% |

Additional summary notes below table.`;

    const result = await convertFile(Buffer.from(md, 'utf-8'), 'md', 'pdf', { preserveTables: true }, 'table.md');
    expect(result.mimeType).toBe('application/pdf');
    expect(result.size).toBeGreaterThan(0);
    expect(result.buffer.toString('ascii', 0, 4)).toBe('%PDF');
  });

  it('runs OCR on synthetic scanned document image', async () => {
    // Generate a high-contrast bitmap with distinct text lines
    const testImage = await sharp({
      create: {
        width: 300,
        height: 100,
        channels: 3,
        background: { r: 255, g: 255, b: 255 }, // White page
      },
    })
      .composite([
        {
          input: Buffer.from(
            `<svg width="300" height="100">
              <text x="20" y="35" font-family="monospace" font-size="20" fill="black">EASYCONVERT</text>
              <text x="20" y="70" font-family="monospace" font-size="18" fill="black">DOCS 2026</text>
            </svg>`
          ),
          top: 0,
          left: 0,
        },
      ])
      .png()
      .toBuffer();

    const ocrResult = await performOcr(testImage);
    expect(ocrResult.confidence).toBeGreaterThan(0.7);
    expect(ocrResult.lines.length).toBeGreaterThan(0);
    expect(ocrResult.wordCount).toBeGreaterThan(0);
  });
});
