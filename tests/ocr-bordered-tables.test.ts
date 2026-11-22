import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { recognizePage, shutdownOcrWorkerPool } from '../src/lib/conversions/ocr';
import { locateLanguageData } from '../src/lib/conversions/ocr-language-data';
import { onnxOcrUnavailableReason } from '../src/lib/conversions/ocr-onnx-helper';
import { characterErrorRatePercent, wordRecall } from './helpers/ocr-cer';
import { skipUnless } from './helpers/strict-skip';

/**
 * The bordered tables of tests/fixtures/ocr-tables (tests/fixtures/ocr-tables/generate_bordered_tables.py), drawn from known text, 16 pages in
 * typefaces, sizes, resolutions, rule widths, shading and degradations that differ. Tesseract reads a ruled grid as a few confident words and
 * leaves out the other cells, scoring 0.9 and more on the words that remain, so the score does not see the loss; the second reading by the ONNX
 * engine does, and the detector of ocr-ruled-table.ts is what asks for it (policy decisions 317 and 392).
 */
const TABLES = path.join(__dirname, 'fixtures', 'ocr-tables');
const TIMEOUT_MS = 180_000;
const engMissing = skipUnless('eng.traineddata (Tesseract English data)', locateLanguageData('eng') !== null);
const onnxMissing = skipUnless('the ONNX English OCR models and runtime', onnxOcrUnavailableReason(undefined, 'eng') === null);

const pages = fs
  .readdirSync(TABLES)
  .filter((file) => /\.(png|jpg)$/.test(file))
  .sort()
  .map((file) => ({ name: file.replace(/\.(png|jpg)$/, ''), image: path.join(TABLES, file), truth: path.join(TABLES, file.replace(/\.(png|jpg)$/, '.gt.txt')) }));

afterAll(async () => {
  await shutdownOcrWorkerPool();
});

describe('the bordered-table corpus', () => {
  it('holds 16 pages, each with its transcription', () => {
    expect(pages).toHaveLength(16);
    for (const page of pages) expect(fs.readFileSync(page.truth, 'utf8').split('\n').length, page.name).toBeGreaterThanOrEqual(5);
  });

  describe.skipIf(engMissing || onnxMissing)('read by the product', () => {
    for (const page of pages) {
      it(
        `${page.name}: every cell is read (character error at most 2%)`,
        async () => {
          const truth = fs.readFileSync(page.truth, 'utf8');
          const read = await recognizePage(fs.readFileSync(page.image), 'eng', { detectOrientation: false });
          expect(characterErrorRatePercent(truth, read.result.text)).toBeLessThanOrEqual(2);
          expect(wordRecall(truth, read.result.text)).toBeGreaterThanOrEqual(0.98);
        },
        TIMEOUT_MS
      );
    }
  });

  describe.skipIf(engMissing)('read by Tesseract alone (what the second reading is for)', () => {
    it('loses 20% or more of the characters of the pages on the whole, though it scores most of them above 0.85', async () => {
      let errors = 0;
      let confident = 0;
      for (const page of pages) {
        const truth = fs.readFileSync(page.truth, 'utf8');
        const read = await recognizePage(fs.readFileSync(page.image), 'eng', { detectOrientation: false, enginePath: 'wasm' });
        errors += characterErrorRatePercent(truth, read.result.text);
        if ((read.result.confidence ?? 0) > 0.85) confident++;
      }
      expect(errors / pages.length).toBeGreaterThanOrEqual(20);
      expect(confident).toBeGreaterThanOrEqual(8);
    }, TIMEOUT_MS);
  });
});
