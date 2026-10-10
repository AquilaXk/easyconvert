import { describe, expect, it } from 'vitest';
import { AB_LIGHT_PAIRS } from '../bench/ab-config';
import { type AbTiming, type Side } from '../bench/ab-speed';
import { type AbRows, createContext } from '../bench/context';
import { BaseRowError } from '../bench/ab-host';
import { ReferenceCache } from '../bench/ref-cache';

/**
 * The job path of a speed row: `ctx.time` with a head and a base process, as `bench/run.ts` sets it up, with scripted
 * processes in place of the real ones. The threshold of the row must reach the sampling (extra pairs, the confirmation
 * set), not only the verdict.
 */

const ROW = 'compression/case/throughput';

/** A scripted process: every call or sample takes `ms(k)` for its k-th request; it records the ids of the rows it was asked for. */
function process(ms: (k: number) => number, options: { refuse?: boolean } = {}): AbRows & { asked: string[]; requests: number; nexts: number } {
  const state = { asked: [] as string[], requests: 0, nexts: 0 };
  const side: Side = {
    call: async () => {
      if (options.refuse) throw new BaseRowError('this version cannot run the row');
      return ms(state.requests++);
    },
    sample: async () => {
      if (options.refuse) throw new BaseRowError('this version cannot run the row');
      return ms(state.requests++);
    },
  };
  return {
    row: async (id) => {
      state.asked.push(id);
    },
    side: () => side,
    next: () => {
      state.nexts++;
    },
    get asked() {
      return state.asked;
    },
    get requests() {
      return state.requests;
    },
    get nexts() {
      return state.nexts;
    },
  };
}

function contextWith(head: AbRows, base: AbRows, regression?: Record<string, { delta: number }>, remainingMs = 1e9) {
  const logged: string[] = [];
  const ctx = createContext({
    resolve: () => null,
    strict: false,
    runs: 1,
    heavyRuns: 1,
    warmup: 0,
    injection: null,
    parity: true,
    quality: false,
    speed: true,
    quick: false,
    refCache: new ReferenceCache({ dir: null, toolVersion: () => null, fileHash: () => '', harnessHash: () => '', log: () => undefined }),
    work: '/nonexistent',
    log: (message) => logged.push(message),
    ab: { head, base, extra: { remainingMs }, regression },
  });
  return { ctx, logged };
}

const reference = (): void => undefined;

describe('the threshold of a row in the job path', () => {
  it('asks both processes for the row by its id, and lets both go on to the next row afterwards', async () => {
    const head = process(() => 100);
    const base = process(() => 100);
    const { ctx } = contextWith(head, base);
    await ctx.time(ROW, () => undefined, reference, 'light');
    expect(head.asked).toEqual([ROW]);
    expect(base.asked).toEqual([ROW]);
    expect([head.nexts, base.nexts]).toEqual([1, 1]);
  });

  it('confirms a failure with a second set only when the first shows the row slower than its own threshold', async () => {
    // The head takes 8 percent longer than the base: past a 5 percent threshold, not past the default 10 percent.
    const run = async (regression?: Record<string, { delta: number }>): Promise<AbTiming> => {
      const { ctx } = contextWith(process(() => 108), process(() => 100), regression);
      return (await ctx.time(ROW, () => undefined, reference, 'light')) as AbTiming;
    };
    const defaultRow = await run();
    expect(defaultRow.ab.confirmed).toEqual({});
    const strictRow = await run({ [ROW]: { delta: 0.05 } });
    expect(strictRow.ab.confirmed.slower).toBe(true);
  });

  it('sizes the extra pairs on the threshold of the row: a narrower threshold needs a narrower bound', async () => {
    // The head's time alternates around the base's by 2 percent: a bound too wide for a 5 percent threshold, narrow enough for 10.
    const alternating = (k: number): number => (k % 2 === 0 ? 98 : 102);
    const extraPairs = async (regression?: Record<string, { delta: number }>): Promise<number> => {
      const { ctx } = contextWith(process(alternating), process(() => 100), regression);
      const timing = (await ctx.time(ROW, () => undefined, reference, 'light')) as AbTiming;
      return timing.ab.extraPairs;
    };
    expect(await extraPairs()).toBe(0);
    expect(await extraPairs({ [ROW]: { delta: 0.05 } })).toBeGreaterThan(0);
  });

  it('spends the one extra budget of the job over the rows in order: a row after it is spent keeps the fixed pairs', async () => {
    const wide = (k: number): number => (k % 2 === 0 ? 70 : 130);
    const head = process(wide);
    const base = process(() => 100);
    const { ctx } = contextWith(head, base, undefined, 1);
    const first = (await ctx.time(ROW, () => undefined, reference, 'light')) as AbTiming;
    const second = (await ctx.time('compression/other/throughput', () => undefined, reference, 'light')) as AbTiming;
    expect(first.ab.pairs).toBeGreaterThan(AB_LIGHT_PAIRS);
    expect(second.ab.extraPairs).toBe(0);
    expect(second.ab.pairs).toBe(AB_LIGHT_PAIRS);
  });

  it('measures a row the base cannot run against the reference alone, and says why', async () => {
    const { ctx, logged } = contextWith(process(() => 100), process(() => 100, { refuse: true }));
    const timing = await ctx.time(ROW, () => undefined, reference, 'light');
    expect('ab' in timing).toBe(false);
    expect((timing as { abFallback?: string }).abFallback).toContain('cannot run the row');
    expect(logged.some((line) => line.includes('measured against the reference alone'))).toBe(true);
  });
});
