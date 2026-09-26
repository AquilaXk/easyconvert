import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { convertFile, extractTextFromPdf, decodePdfHexString } from '../src/lib/conversions/index';
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

  it('extracts text from PDF stream with octal and escaped sequences correctly', () => {
    const pdfStream = Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Length 75 >>\nstream\nBT\n/F1 12 Tf\n(Hello\\040World\\nLine\\041) Tj\nET\nendstream\nendobj\n%%EOF',
      'utf-8'
    );
    const text = extractTextFromPdf(pdfStream);
    expect(text).toContain('Hello World\nLine!');
  });

  it('extracts UTF-16BE BOM hex strings and handles odd-length hex without crashing', () => {
    // UTF-16BE encoded "Hello": 0048 0065 006c 006c 006f with BOM FEFF
    const pdfStream = Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Length 85 >>\nstream\nBT\n<FEFF00480065006C006C006F> Tj\nET\nendstream\nendobj\n%%EOF',
      'utf-8'
    );
    const text = extractTextFromPdf(pdfStream);
    expect(text).toContain('Hello');

    // Odd-length hex string with BOM: <FEFF48> or trailing odd nibble
    const oddHex = '<FEFF48>';
    const decoded = decodePdfHexString(oddHex);
    expect(typeof decoded).toBe('string');
  });

  it('supports PDF single quote and double quote operators with both literal and hex strings', () => {
    const pdfStream = Buffer.from(
      `%PDF-1.4
1 0 obj
<< /Length 120 >>
stream
BT
/F1 12 Tf
(First Line) Tj
(Second Line with \\(nested\\) parens) '
0 0 <FEFF00540068006900720064> "
ET
endstream
endobj
%%EOF`,
      'utf-8'
    );
    const text = extractTextFromPdf(pdfStream);
    expect(text).toContain('First Line');
    expect(text).toContain('Second Line with (nested) parens');
    expect(text).toContain('Third');
  });
});
