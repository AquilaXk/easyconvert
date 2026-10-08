import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { convertFile, extractTextFromPdf, decodePdfHexString } from '../src/lib/conversions/index';
import { performOcr } from '../src/lib/conversions/ocr';
import { oracleTest } from './helpers/oracle-test';
import { characterErrorRatePercent, normalizeOcrText } from './helpers/ocr-cer';

const OCR_FIXTURES = path.join(__dirname, 'fixtures', 'ocr');
/** Budget for clean 300 dpi English (measured 0.00 on all three fixture pages). */
const MAX_CLEAN_ENGLISH_CER_PERCENT = 2;
const MIN_CLEAN_CONFIDENCE = 0.7;

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

  oracleTest('recognizes the text of a 300 dpi scanned page within the clean-English error budget', ['tesseract'], async () => {
    // tests/fixtures/ocr/en_a__clean300.png is rendered from en_a.gt.txt (see generate_golden.py), so the ground truth
    // is the text the page was drawn from, not anything the OCR engine produced.
    const image = fs.readFileSync(path.join(OCR_FIXTURES, 'en_a__clean300.png'));
    const groundTruth = fs.readFileSync(path.join(OCR_FIXTURES, 'en_a.gt.txt'), 'utf-8');

    const ocrResult = await performOcr(image, 'en');

    expect(characterErrorRatePercent(groundTruth, ocrResult.text)).toBeLessThanOrEqual(MAX_CLEAN_ENGLISH_CER_PERCENT);
    // The word and line counts describe the recognised text rather than an arbitrary non-zero number.
    expect(ocrResult.wordCount).toBe(normalizeOcrText(ocrResult.text).split(' ').length);
    expect(ocrResult.lines.map((line) => normalizeOcrText(line))).toEqual(
      ocrResult.text.split('\n').map((line) => normalizeOcrText(line)).filter((line) => line !== '')
    );
    expect(ocrResult.confidence).toBeGreaterThan(MIN_CLEAN_CONFIDENCE);
  });

  it('extracts text from PDF stream with octal and escaped sequences correctly', () => {
    const pdfStream = Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Length 75 >>\nstream\nBT\n/F1 12 Tf\n(Hello\\040World\\nLine\\041) Tj\nET\nendstream\nendobj\n%%EOF',
      'utf-8'
    );
    const text = extractTextFromPdf(pdfStream);
    // PDF 32000-1 Table 3: \040 is a space, \n a line feed and \041 an exclamation mark.
    expect(text).toBe('Hello World\nLine!');
  });

  it('extracts UTF-16BE BOM hex strings and handles odd-length hex without crashing', () => {
    // UTF-16BE encoded "Hello": 0048 0065 006c 006c 006f with BOM FEFF
    const pdfStream = Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Length 85 >>\nstream\nBT\n<FEFF00480065006C006C006F> Tj\nET\nendstream\nendobj\n%%EOF',
      'utf-8'
    );
    const text = extractTextFromPdf(pdfStream);
    expect(text).toBe('Hello');

    // PDF 32000-1 7.3.4.3: a final hex digit with no partner is taken as followed by 0, so FEFF 004 reads as FEFF 0040.
    expect(decodePdfHexString('FEFF004')).toBe('@');
    // A UTF-16BE string that ends in half a code unit loses the stray byte instead of inventing a character.
    expect(decodePdfHexString('FEFF48')).toBe('');
    expect(decodePdfHexString('FEFF0048')).toBe('H');
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
    // ' moves to the next line and shows its string; " does the same after setting word and character spacing.
    expect(text).toBe('First Line\nSecond Line with (nested) parens\nThird');
  });
});
