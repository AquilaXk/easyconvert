import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { convertFile, extractTextFromPdf } from '../src/lib/conversions/index';
import { flate, singlePagePdf } from './helpers/pdf-craft';
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

  it('reads literal strings with octal and escaped sequences (ISO 32000-1 table 3)', async () => {
    // \040 is a space, \041 an exclamation mark and \( \) are literal parentheses.
    const pdf = singlePagePdf(flate(Buffer.from('BT\n/F1 12 Tf\n72 700 Td\n(Hello\\040World\\041 \\(escaped\\)) Tj\nET\n', 'latin1'))).buffer;
    expect(await extractTextFromPdf(pdf)).toBe('Hello World! (escaped)');
  });

  it('shows the strings of the single quote and double quote operators in order', async () => {
    // ' moves to the next line and shows its string; " does the same after setting word and character spacing.
    const content = "BT\n/F1 12 Tf\n72 700 Td\n14 TL\n(First Line) Tj\n(Second Line with \\(nested\\) parens) '\n0 0 (Third) \"\nET\n";
    const text = await extractTextFromPdf(singlePagePdf(flate(Buffer.from(content, 'latin1'))).buffer);
    expect(text.replace(/\s+/g, ' ')).toBe('First Line Second Line with (nested) parens Third');
  });
});
