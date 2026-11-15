import { afterAll, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { renderPlainTextPdf, renderPlainTextPdfInline } from '../src/lib/conversions/text-pdf-render';
import { EVENT_LOOP_BLOCK_BUDGET_MS, shutdownCpuPool } from '../src/lib/workers/cpu-pool';
import { sourceText } from './helpers/archive-corpus';

/**
 * A large plain text drawn as a PDF leaves the event loop free: the heartbeat of a running job (every 5 s, expiring after 30 s) shares that
 * loop. The case runs in the nightly performance workflow with the other budget measurements (`tests/event-loop-budget.test.ts` measures the
 * same way): a timer fires every few milliseconds and records how much CPU time the loop thread used since the previous tick, and the
 * largest value is the longest stretch of work the loop did without turning. A control draws the same text on the loop thread, to show that the
 * monitor sees the hold.
 */

const SAMPLE_INTERVAL_MS = 5;
const US_PER_MS = 1000;
const BYTES_PER_MB = 1024 * 1024;
const TEST_TIMEOUT_MS = 600_000;
const BUDGET_MS = EVENT_LOOP_BLOCK_BUDGET_MS + SAMPLE_INTERVAL_MS;

const threadCpuMs = (): number => {
  const { user, system } = (process as unknown as { threadCpuUsage: () => NodeJS.CpuUsage }).threadCpuUsage();
  return (user + system) / US_PER_MS;
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function withLoopMonitor<T>(work: () => Promise<T>): Promise<{ value: T; heldMs: number }> {
  let previous = threadCpuMs();
  let heldMs = 0;
  const timer = setInterval(() => {
    const now = threadCpuMs();
    heldMs = Math.max(heldMs, now - previous);
    previous = now;
  }, SAMPLE_INTERVAL_MS);
  try {
    await sleep(SAMPLE_INTERVAL_MS * 3);
    const value = await work();
    await sleep(SAMPLE_INTERVAL_MS * 2);
    return { value, heldMs };
  } finally {
    clearInterval(timer);
  }
}

afterAll(shutdownCpuPool);

describe('a large plain text drawn as a PDF', () => {
  it('keeps the loop delay under the budget and has the pages of the render on the loop thread', async () => {
    const payload = { text: sourceText(3 * BYTES_PER_MB, 81).toString('utf8'), title: 'budget' };
    const control = await withLoopMonitor(() => renderPlainTextPdfInline(payload));
    expect(control.heldMs).toBeGreaterThan(BUDGET_MS);
    const { value, heldMs } = await withLoopMonitor(() => renderPlainTextPdf(payload));
    expect(heldMs).toBeLessThan(BUDGET_MS);
    expect(value.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const pages = async (pdf: Buffer): Promise<number> => (await PDFDocument.load(pdf)).getPageCount();
    expect(await pages(value)).toBe(await pages(control.value));
  }, TEST_TIMEOUT_MS);
});
