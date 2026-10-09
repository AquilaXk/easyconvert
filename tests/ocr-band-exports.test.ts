import { afterAll, afterEach, beforeAll, describe, expect, vi, type TestContext } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recognizePage, shutdownOcrWorkerPool } from '../src/lib/conversions/ocr';
import { convertImage } from '../src/lib/conversions/image';
import { convertDocument } from '../src/lib/conversions/document';
import { requireMagick } from './helpers/imagemagick';
import { execFileSync } from 'node:child_process';
import { OCR_BAND_MAX_BANDS } from '../src/lib/conversions/ocr-bands';
import { getSharedOcrWorkerPool, OCR_POOL_MAX_WORKERS_PER_KEY, type OcrWorkerSpec } from '../src/lib/conversions/ocr-worker-pool';
import { locateLanguageData } from '../src/lib/conversions/ocr-language-data';
import { OracleToolMissingError } from './helpers/differential-oracle';
import { requireTessdata } from './helpers/ocr-fixtures';
import { oracleTest } from './helpers/oracle-test';

/**
 * hOCR and ALTO carry the paragraph and block structure of a page, which reading it in bands can change, so the
 * two exports read the page whole. The searchable PDF carries only words and lines, so it still reads in bands.
 * The page is the nine-line single-column scan of the benchmark corpus. What is asserted is the number of engine
 * runs the pool was asked for.
 */

const scan = fs.readFileSync(path.join(__dirname, '..', 'bench', 'corpus', 'scan.png'));
const TEST_TIMEOUT_MS = 120_000;
const WORKERS_READY_TIMEOUT_MS = 60_000;
const POLL_MS = 50;

function engineSpec(): OcrWorkerSpec {
  requireTessdata('eng');
  const data = locateLanguageData('eng');
  if (!data) throw new OracleToolMissingError('eng.traineddata', 'eng.traineddata is not installed where the pipeline reads it');
  return { langs: 'eng', langPath: data.dir, gzip: data.gzip, engineMode: 1, parameters: { tessedit_pageseg_mode: '3' } };
}

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

describe('the OCR exports of an image page that could be read in bands', () => {
  let idle = 0;
  beforeAll(async () => {
    try {
      idle = await warmedWorkers();
    } catch {
      idle = 0;
    }
  }, TEST_TIMEOUT_MS);

  for (const [format, marker] of [
    ['hocr', 'ocr_page'],
    ['alto', '<alto'],
  ] as const) {
    oracleTest(
      `reads the page whole for ${format}`,
      ['tesseract'],
      async (ctx) => {
        if (needsSeveralCpus(ctx)) return;
        engineSpec();
        expect(idle).toBeGreaterThanOrEqual(2);
        const run = vi.spyOn(getSharedOcrWorkerPool(), 'run');
        const result = await convertImage(scan, format, {}, 'scan.png');
        expect(run).toHaveBeenCalledTimes(1);
        expect(result.buffer.toString('utf-8')).toContain(marker);
        expect(result.ocrExtractedText ?? '').toContain('the');
      },
      TEST_TIMEOUT_MS
    );
  }

  oracleTest(
    'still reads the page in bands for the searchable PDF',
    ['tesseract'],
    async (ctx) => {
      if (needsSeveralCpus(ctx)) return;
      engineSpec();
      expect(idle).toBeGreaterThanOrEqual(2);
      const run = vi.spyOn(getSharedOcrWorkerPool(), 'run');
      const result = await convertImage(scan, 'pdf', { ocrEnabled: true }, 'scan.png');
      expect(run).toHaveBeenCalledTimes(Math.min(idle, OCR_BAND_MAX_BANDS, 9 / 3));
      expect(result.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    },
    TEST_TIMEOUT_MS
  );

  for (const [format, marker] of [
    ['hocr', 'ocr_page'],
    ['alto', '<alto'],
  ] as const) {
    oracleTest(
      `reads each page of a PDF whole for ${format}`,
      ['tesseract', 'pdftoppm', 'magick'],
      async (ctx) => {
        if (needsSeveralCpus(ctx)) return;
        engineSpec();
        expect(idle).toBeGreaterThanOrEqual(2);
        // The PDF is made by ImageMagick, not by the converter under test.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-band-pdf-'));
        try {
          const pdfPath = path.join(dir, 'scan.pdf');
          execFileSync(requireMagick(), [path.join(__dirname, '..', 'bench', 'corpus', 'scan.png'), '-density', '150', pdfPath]);
          const pdf = fs.readFileSync(pdfPath);
          const run = vi.spyOn(getSharedOcrWorkerPool(), 'run');
          const result = await convertDocument(pdf, 'pdf', format, { ocrEnabled: true }, 'scan.pdf');
          expect(run).toHaveBeenCalledTimes(1);
          expect(result.buffer.toString('utf-8')).toContain(marker);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT_MS
    );
  }
});
