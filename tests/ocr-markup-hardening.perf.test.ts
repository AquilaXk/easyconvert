import { describe, expect, it } from 'vitest';
import { readMarkup, type MarkupHandler } from '../src/lib/conversions/ocr-markup';
import { parseHocr } from '../src/lib/conversions/ocr-import';

/**
 * Running time of the hOCR / ALTO reader. It lives in the perf suite, which runs one file at a time: the
 * growth ratio is CPU time over CPU time, and a sharded run that shares the runner's cores moved it past the
 * bound once (8.05 against 8) on a reader that is linear.
 */
const NOOP: MarkupHandler = { open: () => {}, text: () => {}, close: () => {} };
/**
 * Running time is checked by growth, not by an absolute budget that depends on the machine: the same
 * work at four times the size must cost well under the sixteen times a quadratic reader would. CPU time
 * is measured, the median of a few runs is taken, and one run first warms the code up. The quadratic
 * reader took 13 s and 27 s of CPU on the inputs below; the linear one a second or less.
 */
const SIZE_FACTOR = 4;
/** Linear growth is a factor of 4; quadratic is 16. */
const MAX_GROWTH_RATIO = 8;
const GROWTH_RUNS = 5;
const TEST_TIMEOUT_MS = 120_000;
// Large enough that the base run costs well over 100 ms of CPU, so scheduler noise cannot dominate the ratio.
const MANY_TEXT_NODES = 800_000;
const MANY_LINES = 20_000;

function cpuMs(run: () => void): number {
  const start = process.cpuUsage();
  run();
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1000;
}

function medianCpuMs(run: () => void): number {
  const samples = Array.from({ length: GROWTH_RUNS }, () => cpuMs(run)).sort((p, q) => p - q);
  return samples[Math.floor(GROWTH_RUNS / 2)];
}

/** CPU time at `SIZE_FACTOR` times the size over CPU time at the base size. */
function growthRatio(workAt: (size: number) => () => void, size: number): number {
  const base = workAt(size);
  const large = workAt(size * SIZE_FACTOR);
  base();
  const baseMs = medianCpuMs(base);
  const largeMs = medianCpuMs(large);
  return largeMs / Math.max(baseMs, 1);
}

describe('reader running time', () => {
  it(
    `reading small text nodes grows linearly with their number, not with the document (${MANY_TEXT_NODES} against ${SIZE_FACTOR}x as many)`,
    () => {
      let texts = 0;
      const readNodes = (count: number) => {
        const xml = `<r>${'<a>x</a>'.repeat(count)}</r>`;
        return () => {
          texts = 0;
          readMarkup(xml, {
            open: () => {},
            text: () => {
              texts++;
            },
            close: () => {},
          });
        };
      };
      const ratio = growthRatio(readNodes, MANY_TEXT_NODES);
      expect(texts).toBe(MANY_TEXT_NODES * SIZE_FACTOR);
      expect(ratio).toBeLessThan(MAX_GROWTH_RATIO);
    },
    TEST_TIMEOUT_MS
  );

  it(
    `parsing an hOCR page grows linearly with its lines (${MANY_LINES} against ${SIZE_FACTOR}x as many)`,
    () => {
      let wordCount = 0;
      const parseLines = (count: number) => {
        const lines: string[] = [];
        for (let i = 0; i < count; i++) {
          const top = (i % 900) * 2;
          lines.push(
            `<span class="ocr_line" title="bbox 10 ${top} 90 ${top + 1}"><span class="ocrx_word" title="bbox 10 ${top} 90 ${top + 1}; x_wconf 90">w${i}</span></span>\n`
          );
        }
        const hocr = `<div class="ocr_page" title="bbox 0 0 100 2000">\n${lines.join('')}</div>`;
        return () => {
          wordCount = parseHocr(hocr).wordCount;
        };
      };
      const ratio = growthRatio(parseLines, MANY_LINES);
      expect(wordCount).toBe(MANY_LINES * SIZE_FACTOR);
      expect(ratio).toBeLessThan(MAX_GROWTH_RATIO);
    },
    TEST_TIMEOUT_MS
  );
});
