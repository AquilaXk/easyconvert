import { describe, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { performOcr } from '../src/lib/conversions/ocr';
import { oracleTest } from './helpers/oracle-test';
import { OracleToolMissingError } from './helpers/differential-oracle';
import { characterErrorRatePercent } from './helpers/ocr-cer';

/**
 * The page preparation runs before recognition, so the native CLI fallback reads the same prepared
 * image as the WebAssembly engine. The pool is made to fail so that `performOcr` takes the CLI
 * path; the expected text is the text drawn into the fixture by generate_golden.py.
 */
const poolRun = vi.hoisted(() => vi.fn());

vi.mock('../src/lib/conversions/ocr-worker-pool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/conversions/ocr-worker-pool')>();
  return { ...actual, getSharedOcrWorkerPool: () => ({ run: poolRun }) };
});

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'ocr');
const PAGE_TIMEOUT_MS = 120_000;
const MAX_CER_PERCENT = 1;
const TESSDATA_DIRS = [
  ...(process.env.TESSDATA_PREFIX ? [process.env.TESSDATA_PREFIX] : []),
  process.cwd(),
  '/usr/share/tesseract-ocr/5/tessdata',
  '/usr/share/tesseract-ocr/4.00/tessdata',
  '/usr/share/tessdata',
];

function requireEnglishData(): void {
  const found = TESSDATA_DIRS.some(
    (dir) =>
      fs.existsSync(path.join(dir, 'eng.traineddata')) || fs.existsSync(path.join(dir, 'eng.traineddata.gz'))
  );
  if (!found) throw new OracleToolMissingError('eng.traineddata', 'eng.traineddata is not installed');
}

describe('page preparation on the native CLI path', () => {
  // en_c is read at 2.0% at 72 dpi (and en_a at 0.8%) without the preparation steps.
  for (const [page, variant] of [
    ['en_a', 'shade'],
    ['en_c', 'dpi72'],
    ['en_a', 'skew3'],
  ]) {
    oracleTest(
      `reads the ${variant} ${page} page through the CLI with CER <= ${MAX_CER_PERCENT}%`,
      ['tesseract'],
      async () => {
        requireEnglishData();
        poolRun.mockReset();
        poolRun.mockRejectedValue(new Error('WebAssembly engine unavailable in this test'));
        const source = fs.readFileSync(path.join(FIXTURE_DIR, `${page}__${variant}.png`));
        const result = await performOcr(source, 'eng');
        expect(poolRun).toHaveBeenCalledTimes(1);
        const truth = fs.readFileSync(path.join(FIXTURE_DIR, `${page}.gt.txt`), 'utf-8');
        expect(characterErrorRatePercent(truth, result.text)).toBeLessThanOrEqual(MAX_CER_PERCENT);
        const { width, height } = await sharp(source).metadata();
        expect([result.imageWidth, result.imageHeight]).toEqual([width, height]);
        for (const block of result.lineBlocks ?? []) {
          expect(block.bbox.x + block.bbox.width).toBeLessThanOrEqual(width as number);
          expect(block.bbox.y + block.bbox.height).toBeLessThanOrEqual(height as number);
        }
      },
      PAGE_TIMEOUT_MS
    );
  }
});
