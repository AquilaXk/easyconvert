import { afterAll, describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import { writeTransientWorkbook } from '../src/lib/conversions/data';
import { DATA_SOURCE_LIMITS } from '../src/lib/conversions/data-limits';
import { PayloadLimitError } from '../src/lib/types';
import { shutdownCpuPool } from '../src/lib/workers/cpu-pool';

/**
 * The event loop of the caller keeps turning while a sheet is read and written (entry 369): a hostile text is refused before it is parsed
 * and a large honest one is converted on a pool thread. The loop is measured by the longest wall-clock gap between two ticks of a 5 ms
 * timer; before the change a refusal held it 0.4 to 1.0 s and a 10 MiB CSV about 0.5 s.
 */
const MIB = 1024 * 1024;
const TICK_INTERVAL_MS = 5;
const LOOP_GAP_BUDGET_MS = 250;
const TEST_TIMEOUT_MS = 120_000;

async function widestGapMs(work: () => Promise<unknown>): Promise<{ outcome: unknown; gapMs: number }> {
  let last = performance.now();
  let gapMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    gapMs = Math.max(gapMs, now - last);
    last = now;
  }, TICK_INTERVAL_MS);
  let outcome: unknown = null;
  try {
    await work();
  } catch (error) {
    outcome = error;
  } finally {
    clearInterval(timer);
  }
  return { outcome, gapMs: Math.max(gapMs, performance.now() - last) };
}

const toSheet = (input: Buffer, src: string, tgt: string): Promise<unknown> => convertFile(input, src, tgt, {}, `input.${src}`);
const rows = (count: number): string => ['id,name,note', ...Array.from({ length: count }, (_, i) => `${i},item ${i},some note text ${i}`)].join('\n');

describe('event loop while a sheet is read and written', () => {
  afterAll(() => shutdownCpuPool());

  describe.each(['xlsx', 'ods'])('to %s', (tgt) => {
    it.each([
      ['a 16 MB TSV of line ends', Buffer.from('a\n'.repeat(DATA_SOURCE_LIMITS.delimited.maxItems + 1)), 'tsv'],
      ['a JSON array of empty objects over the count', Buffer.from(`[${'{},'.repeat(DATA_SOURCE_LIMITS.json.maxItems / 2 + 1)}{}]`), 'json'],
      ['a 20 MB CSV of one-letter cells', Buffer.from('a,'.repeat(10 * MIB)), 'csv'],
    ] as const)('refuses %s without holding the loop', async (_name, input, src) => {
      const { outcome, gapMs } = await widestGapMs(() => toSheet(input, src, tgt));
      expect(outcome).toBeInstanceOf(PayloadLimitError);
      expect(gapMs).toBeLessThan(LOOP_GAP_BUDGET_MS);
    }, TEST_TIMEOUT_MS);

    it('writes a 10 MiB CSV without holding the loop', async () => {
      const { outcome, gapMs } = await widestGapMs(() => toSheet(Buffer.from(rows(330_000)), 'csv', tgt));
      expect(outcome).toBeNull();
      expect(gapMs).toBeLessThan(LOOP_GAP_BUDGET_MS);
    }, TEST_TIMEOUT_MS);

    it('writes a 6 MiB JSON table without holding the loop', async () => {
      const records = Array.from({ length: 60_000 }, (_, i) => ({ id: i, name: `item ${i}`, note: `some note text ${i}` }));
      const { outcome, gapMs } = await widestGapMs(() => toSheet(Buffer.from(JSON.stringify(records)), 'json', tgt));
      expect(outcome).toBeNull();
      expect(gapMs).toBeLessThan(LOOP_GAP_BUDGET_MS);
    }, TEST_TIMEOUT_MS);
  });

  it('writes a 10 MiB CSV for xls without holding the loop', async () => {
    const { outcome, gapMs } = await widestGapMs(() => writeTransientWorkbook(Buffer.from(rows(330_000)), 'csv', {}));
    expect(outcome).toBeNull();
    expect(gapMs).toBeLessThan(LOOP_GAP_BUDGET_MS);
  }, TEST_TIMEOUT_MS);

  it('refuses a JSON array over the count for xls without holding the loop', async () => {
    const input = Buffer.from(`[${'{},'.repeat(DATA_SOURCE_LIMITS.json.maxItems / 2 + 1)}{}]`);
    const { outcome, gapMs } = await widestGapMs(() => writeTransientWorkbook(input, 'json', {}));
    expect(outcome).toBeInstanceOf(PayloadLimitError);
    expect(gapMs).toBeLessThan(LOOP_GAP_BUDGET_MS);
  }, TEST_TIMEOUT_MS);
});
