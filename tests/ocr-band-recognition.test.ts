import { afterAll, afterEach, beforeAll, describe, expect, vi, type TestContext } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateSearchablePdf, performOcr, recognizePage, shutdownOcrWorkerPool } from '../src/lib/conversions/ocr';
import { OCR_BAND_MAX_BANDS } from '../src/lib/conversions/ocr-bands';
import { getSharedOcrWorkerPool, OCR_POOL_MAX_WORKERS_PER_KEY, type OcrWorkerSpec } from '../src/lib/conversions/ocr-worker-pool';
import { locateLanguageData } from '../src/lib/conversions/ocr-language-data';
import { extractTextWithExternalPdftotext, OracleToolMissingError } from './helpers/differential-oracle';
import { characterErrorRatePercent } from './helpers/ocr-cer';
import { fixtureImage, groundTruth, requireTessdata } from './helpers/ocr-fixtures';
import { oracleTest } from './helpers/oracle-test';

/**
 * A page of plain text lines is read in bands by the idle workers of the pool, and the bands make one reading. The
 * page is the nine-line scan of the benchmark corpus, drawn from the text in scan.gt.txt. What is asserted is the
 * number of engine runs a reading took (the runs the pool was asked for), never a time.
 */

const CORPUS_DIR = path.join(__dirname, '..', 'bench', 'corpus');
const scan = fs.readFileSync(path.join(CORPUS_DIR, 'scan.png'));
const scanTruth = fs.readFileSync(path.join(CORPUS_DIR, 'scan.gt.txt'), 'utf-8');
const TEST_TIMEOUT_MS = 120_000;
const WORKERS_READY_TIMEOUT_MS = 60_000;
const POLL_MS = 50;
/** Boxes of a band and of the whole read may differ by the pixels a different layout pass moves them. */
const MAX_BOX_DRIFT_PX = 4;

/** The worker set the pipeline uses for English: its data is found where the pipeline finds it. */
function engineSpec(): OcrWorkerSpec {
  requireTessdata('eng');
  const data = locateLanguageData('eng');
  if (!data) throw new OracleToolMissingError('eng.traineddata', 'eng.traineddata is not installed where the pipeline reads it');
  return {
    langs: 'eng',
    langPath: data.dir,
    gzip: data.gzip,
    engineMode: 1,
    parameters: { tessedit_pageseg_mode: '3' },
  };
}

/** Reads a page whole once, which starts the workers a banded page needs, and waits until they are idle. */
async function warmedWorkers(): Promise<number> {
  const spec = engineSpec();
  const pool = getSharedOcrWorkerPool();
  const wanted = Math.min(OCR_BAND_MAX_BANDS, os.availableParallelism(), OCR_POOL_MAX_WORKERS_PER_KEY);
  await recognizePage(scan, 'eng');
  const deadline = Date.now() + WORKERS_READY_TIMEOUT_MS;
  while (pool.idleWorkers(spec) < wanted && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return pool.idleWorkers(spec);
}

/** A single-CPU machine reads every page whole by design; the tests of banded reading have nothing to show there. */
function needsSeveralCpus(ctx: TestContext): boolean {
  if (os.availableParallelism() >= 2) return false;
  // skip-ok: bands need at least two CPUs to be planned at all (os.availableParallelism() < 2).
  ctx.skip();
  return true;
}

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await shutdownOcrWorkerPool();
});

describe('a page read in bands', () => {
  let idle = 0;
  beforeAll(async () => {
    try {
      idle = await warmedWorkers();
    } catch {
      idle = 0;
    }
  }, TEST_TIMEOUT_MS);

  oracleTest(
    'takes one engine run per band and reads the same words as one run on the whole page',
    ['tesseract'],
    async (ctx) => {
      if (needsSeveralCpus(ctx)) return;
      engineSpec();
      expect(idle).toBeGreaterThanOrEqual(2);
      const pool = getSharedOcrWorkerPool();
      const run = vi.spyOn(pool, 'run');

      const whole = await recognizePage(scan, 'eng', { parallelBands: false });
      expect(whole.preparation?.bands).toBe(1);
      expect(run).toHaveBeenCalledTimes(1);

      run.mockClear();
      const banded = await recognizePage(scan, 'eng');
      const bands = banded.preparation?.bands ?? 0;
      expect(bands).toBe(Math.min(idle, OCR_BAND_MAX_BANDS, 9 / 3));
      expect(bands).toBeGreaterThanOrEqual(2);
      expect(run).toHaveBeenCalledTimes(bands);

      const norm = (text: string) => text.replace(/\s+/g, ' ').trim();
      expect(norm(banded.result.text)).toBe(norm(whole.result.text));
      expect(characterErrorRatePercent(scanTruth, banded.result.text)).toBeLessThanOrEqual(
        characterErrorRatePercent(scanTruth, whole.result.text)
      );
      const bandedLines = banded.result.lineBlocks ?? [];
      const wholeLines = whole.result.lineBlocks ?? [];
      expect(bandedLines).toHaveLength(wholeLines.length);
      expect(bandedLines.length).toBeGreaterThan(0);
      bandedLines.forEach((line, index) => {
        const reference = wholeLines[index];
        expect(line.text).toBe(reference.text);
        expect(Math.abs(line.bbox.y - reference.bbox.y)).toBeLessThanOrEqual(MAX_BOX_DRIFT_PX);
        expect(Math.abs(line.bbox.x - reference.bbox.x)).toBeLessThanOrEqual(MAX_BOX_DRIFT_PX);
        expect(line.words.map((word) => word.text)).toEqual(reference.words.map((word) => word.text));
      });
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'gives the searchable PDF the text layer of the same single reading, read back by pdftotext',
    ['tesseract', 'pdftotext'],
    async (ctx) => {
      if (needsSeveralCpus(ctx)) return;
      engineSpec();
      expect(idle).toBeGreaterThanOrEqual(2);
      const run = vi.spyOn(getSharedOcrWorkerPool(), 'run');
      const result = await performOcr(scan, 'eng');
      const bands = Math.min(idle, OCR_BAND_MAX_BANDS, 9 / 3);
      expect(run).toHaveBeenCalledTimes(bands);
      const pdf = await generateSearchablePdf(scan, result, {}, 'scan');
      expect(run).toHaveBeenCalledTimes(bands);
      const layer = extractTextWithExternalPdftotext(pdf);
      expect(layer).not.toBeNull();
      expect(characterErrorRatePercent(scanTruth, layer ?? '')).toBe(0);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'reads a page with a gap between its columns whole',
    ['tesseract'],
    async (ctx) => {
      if (needsSeveralCpus(ctx)) return;
      engineSpec();
      expect(idle).toBeGreaterThanOrEqual(2);
      const run = vi.spyOn(getSharedOcrWorkerPool(), 'run');
      const page = await recognizePage(fixtureImage('twocol', 'clean300'), 'eng');
      expect(page.preparation?.bands).toBe(1);
      expect(run).toHaveBeenCalledTimes(1);
      expect(characterErrorRatePercent(groundTruth('twocol'), page.result.text)).toBeLessThanOrEqual(1);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'reads the page whole on the one idle worker and starts the workers the next page can use',
    ['tesseract'],
    async () => {
      const spec = engineSpec();
      const pool = getSharedOcrWorkerPool();
      vi.spyOn(pool, 'idleWorkers').mockReturnValue(1);
      const warm = vi.spyOn(pool, 'warm').mockImplementation(() => undefined);
      const run = vi.spyOn(pool, 'run');
      const page = await recognizePage(scan, 'eng');
      expect(page.preparation?.bands).toBe(1);
      expect(run).toHaveBeenCalledTimes(1);
      const wanted = Math.min(OCR_BAND_MAX_BANDS, os.availableParallelism(), OCR_POOL_MAX_WORKERS_PER_KEY);
      expect(warm).toHaveBeenCalledExactlyOnceWith(spec, wanted);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'reads a Korean page whole however many workers are idle',
    ['tesseract'],
    async () => {
      requireTessdata('kor');
      const run = vi.spyOn(getSharedOcrWorkerPool(), 'run');
      const page = await recognizePage(fixtureImage('ko_a', 'clean300'), 'kor');
      expect(page.preparation?.bands).toBe(1);
      expect(run).toHaveBeenCalledTimes(1);
    },
    TEST_TIMEOUT_MS
  );
});
