import { afterAll, describe, expect } from 'vitest';
import { performOcr, shutdownOcrWorkerPool } from '../src/lib/conversions/ocr';
import { oracleTest } from './helpers/oracle-test';
import { fixtureImage, requireTessdata } from './helpers/ocr-fixtures';

/**
 * Lazy orientation detection must cost almost nothing on a page that already reads well. This is a
 * wall-clock ratio of two native OCR runs, so it lives in the perf suite, which CI runs one file at a
 * time instead of beside CPU-heavy shards.
 */

const TEST_TIMEOUT_MS = 300_000;
const SLOW_RUNNER = process.env.EASYCONVERT_SLOW_RUNNER === '1';
const TIMING_RUNS = 5;
const MAX_OVERHEAD_RATIO = 1.15;

afterAll(async () => {
  await shutdownOcrWorkerPool();
});

describe('cost', () => {
  oracleTest(
    `a page that reads well costs no more than ${MAX_OVERHEAD_RATIO}x what it costs with detection off`,
    ['tesseract'],
    async (ctx) => {
      if (SLOW_RUNNER) {
        // skip-ok: explicit opt-out on a slow runner (EASYCONVERT_SLOW_RUNNER=1), never set in CI.
        ctx.skip();
        return;
      }
      requireTessdata('eng');
      requireTessdata('osd');
      const image = fixtureImage('en_a', 'noise');
      await performOcr(image, 'eng', undefined, false);
      let off = Infinity;
      let on = Infinity;
      for (let run = 0; run < TIMING_RUNS; run++) {
        let started = performance.now();
        await performOcr(image, 'eng', undefined, false);
        off = Math.min(off, performance.now() - started);
        started = performance.now();
        await performOcr(image, 'eng');
        on = Math.min(on, performance.now() - started);
      }
      expect(on / off).toBeLessThanOrEqual(MAX_OVERHEAD_RATIO);
    },
    TEST_TIMEOUT_MS
  );
});
