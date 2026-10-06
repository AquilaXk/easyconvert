import { describe, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { performOcr } from '../src/lib/conversions/ocr';
import { oracleTest } from './helpers/oracle-test';
import { OracleToolMissingError } from './helpers/differential-oracle';
import { characterErrorRatePercent } from './helpers/ocr-cer';

/**
 * Single-column pages rendered by tests/fixtures/ocr/generate_golden.py from known text and then
 * degraded (uneven shading, 72 dpi, 3 degree skew, noise). The expected text is the text that was
 * drawn, so no expectation comes from the recognizer under test.
 */
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'ocr');
const PAGE_TIMEOUT_MS = 120_000;
const ENGLISH_PAGES = ['en_a', 'en_b', 'en_c'] as const;
const MAX_SHADED_CER_PERCENT = 1;

const TESSDATA_DIRS = [
  ...(process.env.TESSDATA_PREFIX ? [process.env.TESSDATA_PREFIX] : []),
  process.cwd(),
  '/usr/share/tesseract-ocr/5/tessdata',
  '/usr/share/tesseract-ocr/4.00/tessdata',
  '/usr/share/tessdata',
];

function requireData(lang: string): void {
  const found = TESSDATA_DIRS.some(
    (dir) =>
      fs.existsSync(path.join(dir, `${lang}.traineddata`)) || fs.existsSync(path.join(dir, `${lang}.traineddata.gz`))
  );
  if (!found) throw new OracleToolMissingError(`${lang}.traineddata`, `${lang}.traineddata is not installed`);
}

function truthFor(page: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, `${page}.gt.txt`), 'utf-8');
}

function pageImage(page: string, variant: string): Buffer {
  return fs.readFileSync(path.join(FIXTURE_DIR, `${page}__${variant}.png`));
}

describe('degraded English pages', () => {
  for (const page of ENGLISH_PAGES) {
    oracleTest(
      `reads the shaded ${page} page with CER <= ${MAX_SHADED_CER_PERCENT}%`,
      ['tesseract'],
      async () => {
        requireData('eng');
        const result = await performOcr(pageImage(page, 'shade'), 'eng');
        expect(characterErrorRatePercent(truthFor(page), result.text)).toBeLessThanOrEqual(MAX_SHADED_CER_PERCENT);
      },
      PAGE_TIMEOUT_MS
    );
  }
});
