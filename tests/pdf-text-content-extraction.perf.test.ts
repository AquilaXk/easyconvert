import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { convertFile } from '../src/lib/conversions/index';
import { shutdownPdfTextThreads } from '../src/lib/conversions/pdf-text-host';

/**
 * Cost of reading a one-page PDF's text through the pooled pdf.js thread: the first call pays for starting the
 * thread and loading the library, later calls reuse it. Budgets are absolute (wall time and resident memory growth),
 * measured as the best of several runs so a busy machine does not fail the test.
 */

const FIXTURE = path.join(__dirname, 'fixtures', 'pdf-text', 'latin.pdf');
const RUNS = 5;
const MAX_WARM_MS = 400;
const MAX_RSS_GROWTH_BYTES = 150 * 1024 * 1024;
const TEST_TIMEOUT_MS = 120_000;

afterAll(() => {
  shutdownPdfTextThreads();
});

describe('PDF text extraction cost', () => {
  it(
    'reads a one-page PDF within the warm time and memory budget',
    async () => {
      const pdf = fs.readFileSync(FIXTURE);
      const first = await convertFile(pdf, 'pdf', 'txt', {}, 'latin.pdf');
      const rssBefore = process.memoryUsage().rss;
      let best = Number.POSITIVE_INFINITY;
      let text = '';
      for (let run = 0; run < RUNS; run++) {
        const started = performance.now();
        const converted = await convertFile(pdf, 'pdf', 'txt', {}, 'latin.pdf');
        best = Math.min(best, performance.now() - started);
        text = converted.buffer.toString('utf8');
      }
      const growth = process.memoryUsage().rss - rssBefore;
      expect(text).toBe(first.buffer.toString('utf8'));
      expect(text.length).toBeGreaterThan(0);
      expect(best).toBeLessThan(MAX_WARM_MS);
      expect(growth).toBeLessThan(MAX_RSS_GROWTH_BYTES);
    },
    TEST_TIMEOUT_MS
  );
});
