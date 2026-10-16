import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect } from 'vitest';
import { characterErrorRatePercent, wordF1 } from '../bench/text-metrics';
import { convertFile } from '../src/lib/conversions/index';
import { shutdownOcrWorkerPool } from '../src/lib/conversions/ocr';
import { getOracleToolPath, OracleToolMissingError } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';

/**
 * The bench's OCR row end to end: the scanned page converted to a searchable PDF, read back with the Poppler tools
 * (a text extractor and a PDF reader that share no code with this project) and scored against the text the page was
 * drawn from. A speed change to the OCR path must leave exactly this output intact.
 */

const CORPUS_DIR = path.join(__dirname, '..', 'bench', 'corpus');
/** The reference engine reads this page at 0.16 % character error; the product reads it without an error. */
const MAX_CHARACTER_ERROR_PERCENT = 0.2;
const MIN_WORD_F1 = 0.99;
const SCAN_WIDTH_PX = 840;
const SCAN_HEIGHT_PX = 260;

function tool(name: 'pdftotext' | 'pdfinfo'): string {
  const found = getOracleToolPath(name);
  if (!found) throw new OracleToolMissingError(name, `${name} is not installed`);
  return found;
}

describe('searchable PDF of the benchmark scan', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-scan-pdf-'));
  afterAll(async () => {
    await shutdownOcrWorkerPool();
    fs.rmSync(work, { recursive: true, force: true });
  });

  oracleTest(
    'reads back through Poppler as the page text, on one page the size of the scan',
    ['pdftotext', 'pdfinfo'],
    async () => {
      const truth = fs.readFileSync(path.join(CORPUS_DIR, 'scan.gt.txt'), 'utf8');
      const converted = await convertFile(fs.readFileSync(path.join(CORPUS_DIR, 'scan.png')), 'png', 'pdf', { ocrEnabled: true }, 'scan.png');
      const file = path.join(work, 'scan.pdf');
      fs.writeFileSync(file, converted.buffer);

      const text = execFileSync(tool('pdftotext'), ['-enc', 'UTF-8', file, '-'], { encoding: 'utf8' });
      expect(characterErrorRatePercent(truth, text)).toBeLessThanOrEqual(MAX_CHARACTER_ERROR_PERCENT);
      expect(wordF1(truth, text)).toBeGreaterThanOrEqual(MIN_WORD_F1);

      const info = execFileSync(tool('pdfinfo'), [file], { encoding: 'utf8' });
      expect(/Pages:\s+(\d+)/.exec(info)?.[1]).toBe('1');
      expect(/Page size:\s+(\S+) x (\S+) pts/.exec(info)?.slice(1, 3)).toEqual([String(SCAN_WIDTH_PX), String(SCAN_HEIGHT_PX)]);
    },
    120_000
  );
});
