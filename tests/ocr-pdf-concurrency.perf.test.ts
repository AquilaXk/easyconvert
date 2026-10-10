import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { performSmartMultiPagePdfOcr, recognizePdfPages, shutdownOcrWorkerPool } from '../src/lib/conversions/ocr';
import {
  mapWithConcurrency,
  OCR_MAX_INFLIGHT_PAGES,
  ocrPageConcurrency,
} from '../src/lib/conversions/ocr-page-batch';
import {
  getSharedOcrWorkerPool,
  OCR_POOL_MAX_WORKERS_PER_KEY,
  OCR_POOL_MAX_WORKERS_TOTAL,
} from '../src/lib/conversions/ocr-worker-pool';
import { oracleTest } from './helpers/oracle-test';
import { characterErrorRatePercent } from './helpers/ocr-cer';
import { fixtureImage, groundTruth, requireTessdata } from './helpers/ocr-fixtures';

/**
 * The pages of a PDF are recognized side by side, within the worker pool and the in-flight cap, and
 * their results come back in page order. The timing and memory figures are measured here: wall time
 * against sequential recognition of the same pages, and the peak resident memory a fresh process
 * adds for a 20-page document (kernel high-water mark, tests/helpers/measure-peak-ocr-pages.mts).
 */

const TEST_TIMEOUT_MS = 300_000;
const SLOW_RUNNER = process.env.EASYCONVERT_SLOW_RUNNER === '1';
const FOUR_PAGES = 4;
const TWENTY_PAGES = 20;
/**
 * At least a 1.25x speedup from parallel pages. Shards share runner CPUs with other test files, so the bound
 * leaves room for that load; the in-flight limit itself is asserted structurally above.
 */
const MAX_PARALLEL_TIME_RATIO = 0.8;
/** Best of this many runs: other test files share the CPUs, so a single pair of runs can be slowed unevenly. */
const TIMING_RUNS = 6;
const MIN_CPUS_FOR_TIMING = 4;
/**
 * Memory added per page in flight, measured on a 2000x490 page (about 1 MB decoded): a recognized
 * page costs the engine a few tens of MiB of working memory. The budget is deliberately generous so
 * that only a loop that holds every page at once (20 pages in flight) can exceed it.
 */
const PER_PAGE_BUDGET_MIB = 60;
/** Memory the first page costs that further pages do not: the module graph, the worker threads and the language data. */
const CONSTANT_BUDGET_MIB = 400;
const HAS_PROC = fs.existsSync('/proc/self/status');
const MEASURE_SCRIPT = path.join(__dirname, 'helpers', 'measure-peak-ocr-pages.mts');
const CHILD_TIMEOUT_MS = 250_000;

describe('mapWithConcurrency', () => {
  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  it('returns results in the order of the items, whichever finishes first', async () => {
    const finishOrder: number[] = [];
    const results = await mapWithConcurrency([30, 5, 20, 1], 4, async (ms, index) => {
      await delay(ms);
      finishOrder.push(index);
      return `item ${index}`;
    });
    expect(results).toEqual(['item 0', 'item 1', 'item 2', 'item 3']);
    expect(finishOrder).toEqual([3, 1, 2, 0]);
  });

  it('never runs more than the limit at once, and does use the whole limit', async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      active++;
      peak = Math.max(peak, active);
      await delay(5);
      active--;
    });
    expect(peak).toBe(3);
  });

  it('stops starting tasks after the first failure and rethrows it', async () => {
    const started: number[] = [];
    await expect(
      mapWithConcurrency([0, 1, 2, 3, 4, 5, 6, 7], 2, async (item) => {
        started.push(item);
        await delay(5);
        if (item === 1) throw new Error('page 1 failed');
        return item;
      })
    ).rejects.toThrow('page 1 failed');
    expect(started.length).toBeLessThan(8);
    expect(started).not.toContain(7);
  });

  it('handles no items and a limit larger than the items', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
    expect(await mapWithConcurrency(['a'], 8, async (item) => item.toUpperCase())).toEqual(['A']);
  });

  it('rejects a limit that is not a positive integer', async () => {
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      await expect(mapWithConcurrency([1], limit, async () => 1)).rejects.toThrow(RangeError);
    }
  });
});

describe('ocrPageConcurrency', () => {
  it('is the pool capacity, capped at the in-flight limit and never below one', () => {
    expect(ocrPageConcurrency()).toBe(Math.min(OCR_POOL_MAX_WORKERS_TOTAL, OCR_MAX_INFLIGHT_PAGES));
    expect(ocrPageConcurrency(100)).toBe(OCR_MAX_INFLIGHT_PAGES);
    expect(ocrPageConcurrency(0)).toBe(1);
  });
});

async function scannedPdf(pages: Buffer[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (const png of pages) {
    const image = await doc.embedPng(png);
    const page = doc.addPage([image.width / 4, image.height / 4]);
    page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  }
  return Buffer.from(await doc.save());
}

describe('recognizing the pages of a scanned PDF', () => {
  oracleTest(
    'runs as many recognitions at once as the pool has workers, and one at a time when asked to',
    ['tesseract'],
    async () => {
      requireTessdata('eng');
      const pool = getSharedOcrWorkerPool();
      const run = pool.run.bind(pool);
      let active = 0;
      let peak = 0;
      // Counts jobs that hold a worker, not the ones still waiting for one.
      vi.spyOn(pool, 'run').mockImplementation((spec, job) =>
        run(spec, (recognize, recognizeWith, detect) => {
          active++;
          peak = Math.max(peak, active);
          return job(recognize, recognizeWith, detect).finally(() => {
            active--;
          });
        })
      );
      const pages = Array.from({ length: FOUR_PAGES }, () => ({ buffer: fixtureImage('en_a', 'clean300') }));
      try {
        await recognizePdfPages(pages, 'eng', 1, false);
        expect(peak).toBe(1);
        peak = 0;
        await recognizePdfPages(pages, 'eng', ocrPageConcurrency(), false);
        expect(peak).toBe(OCR_POOL_MAX_WORKERS_PER_KEY);
      } finally {
        vi.restoreAllMocks();
        await shutdownOcrWorkerPool();
      }
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'keeps the text of each page with its page, with the pages in a different size order than their reading time',
    ['tesseract'],
    async () => {
      requireTessdata('eng');
      // The second page is long and slow to read, the others short; page order must not follow finish order.
      const pdf = await scannedPdf([
        fixtureImage('en_b', 'clean300'),
        fixtureImage('en_a', 'clean300'),
        fixtureImage('en_c', 'clean300'),
      ]);
      const { ocrResults } = await performSmartMultiPagePdfOcr(pdf, { ocrMode: 'force' });
      const pageTexts = [1, 2, 3].map((page) => ocrResults.get(page)?.text ?? '');
      expect(characterErrorRatePercent(groundTruth('en_b'), pageTexts[0])).toBeLessThanOrEqual(1);
      expect(characterErrorRatePercent(groundTruth('en_a'), pageTexts[1])).toBeLessThanOrEqual(1);
      expect(characterErrorRatePercent(groundTruth('en_c'), pageTexts[2])).toBeLessThanOrEqual(1);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    `a ${FOUR_PAGES}-page document takes at most ${MAX_PARALLEL_TIME_RATIO}x the sequential time`,
    ['tesseract'],
    async (ctx) => {
      if (SLOW_RUNNER) {
        // skip-ok: explicit opt-out on a slow runner, or hardware capability: the speedup ratio is defined for a 4-CPU runner, and /proc is Linux only.
        ctx.skip();
        return;
      }
      requireTessdata('eng');
      // The ratio is defined for a 4-vCPU runner; on fewer CPUs two workers and the main thread compete.
      if (os.availableParallelism() < MIN_CPUS_FOR_TIMING) {
        // skip-ok: explicit opt-out on a slow runner, or hardware capability: the speedup ratio is defined for a 4-CPU runner, and /proc is Linux only.
        ctx.skip();
        return;
      }
      const pages = Array.from({ length: FOUR_PAGES }, () => ({ buffer: fixtureImage('en_a', 'noise') }));
      // Start every worker the concurrent run will use, so neither run pays for starting one.
      await recognizePdfPages(pages, 'eng', ocrPageConcurrency());
      let sequential = Infinity;
      let concurrent = Infinity;
      for (let run = 0; run < TIMING_RUNS; run++) {
        let started = performance.now();
        const one = await recognizePdfPages(pages, 'eng', 1);
        sequential = Math.min(sequential, performance.now() - started);
        started = performance.now();
        const many = await recognizePdfPages(pages, 'eng', ocrPageConcurrency());
        concurrent = Math.min(concurrent, performance.now() - started);
        expect(many.map((r) => r.text)).toEqual(one.map((r) => r.text));
      }
      expect(ocrPageConcurrency()).toBeGreaterThan(1);
      expect(concurrent / sequential).toBeLessThanOrEqual(MAX_PARALLEL_TIME_RATIO);
      await shutdownOcrWorkerPool();
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    `a ${TWENTY_PAGES}-page document adds at most ${OCR_MAX_INFLIGHT_PAGES} x ${PER_PAGE_BUDGET_MIB} MiB plus ${CONSTANT_BUDGET_MIB} MiB of resident memory`,
    ['tesseract'],
    async (ctx) => {
      if (!HAS_PROC || SLOW_RUNNER) {
        // skip-ok: explicit opt-out on a slow runner, or hardware capability: the speedup ratio is defined for a 4-CPU runner, and /proc is Linux only.
        ctx.skip();
        return;
      }
      requireTessdata('eng');
      const image = path.join(os.tmpdir(), `ocr-pages-${process.pid}.png`);
      fs.writeFileSync(image, fixtureImage('en_a', 'clean300'));
      try {
        const run = (concurrency: number): { elapsedMs: number; addedMiB: number; textHashes: string[] } =>
          JSON.parse(
            execFileSync(
              process.execPath,
              ['--import', 'tsx', MEASURE_SCRIPT, image, 'eng', String(TWENTY_PAGES), String(concurrency)],
              { cwd: path.join(__dirname, '..'), timeout: CHILD_TIMEOUT_MS, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
            )
              .trim()
              .split('\n')
              .pop() as string
          );
        const sequential = run(1);
        const concurrent = run(ocrPageConcurrency());
        // The same twenty pages read the same way, side by side or one by one.
        expect(concurrent.textHashes).toEqual(sequential.textHashes);
        expect(new Set(concurrent.textHashes).size).toBe(1);
        expect(concurrent.addedMiB).toBeLessThanOrEqual(ocrPageConcurrency() * PER_PAGE_BUDGET_MIB + CONSTANT_BUDGET_MIB);
        // Twenty pages in flight would hold twenty pages' working memory; the cap keeps it from growing with the page count.
        expect(concurrent.addedMiB).toBeLessThanOrEqual(sequential.addedMiB + OCR_MAX_INFLIGHT_PAGES * PER_PAGE_BUDGET_MIB);
      } finally {
        fs.rmSync(image, { force: true });
      }
    },
    TEST_TIMEOUT_MS
  );
});
