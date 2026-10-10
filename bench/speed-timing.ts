import { performance } from 'node:perf_hooks';
import { AB_HEAVY_PAIRS, AB_LIGHT_PAIRS } from './ab-config';
import { AbHostError, BaseRowError } from './ab-host';
import { abSpeedTiming, type ExtraBudget, localSide, regressionDelta, type Side } from './ab-speed';
import type { Injection, RowWeight } from './context';
import { SPEED_MIN_SAMPLE_MS } from './speed-config';
import { adaptiveSpeedTiming, HEAVY_SPEED_PLAN, LIGHT_SPEED_PLAN, type AdaptiveTiming } from './speed-parity';
import { type InterleavedTiming, interleavedTiming } from './stats';

/**
 * How the time of a speed row is taken: in a fixed number of runs, or in a parity run by the paired procedure of
 * bench/speed-parity.ts, or against the base of the change in processes of their own (bench/ab-speed.ts), with the fallback
 * to the reference alone for a row the base cannot run. It is gate code (the `parity speed` job takes it from the base commit),
 * so a change cannot decide how its own rows are timed or when the comparison with the base is dropped.
 */

/** `slow-ours` makes each timed run of our side take this many times as long: a speed regression for the parity gate. */
export const INJECTED_SLOWDOWN_FACTOR = 2;

/** What the benchmark asks of a process that measures one version (bench/ab-host.ts is the real one). */
export interface AbRows {
  row: (id: string) => Promise<void>;
  side: () => Side;
  next: () => void;
}

export interface TimerInit {
  parity: boolean;
  injection: Injection | null;
  runs: number;
  heavyRuns: number;
  warmup: number;
  log: (message: string) => void;
  /** Speed rows are measured against the base of the change too: the head and the base each run in a process of their own (bench/ab-host.ts); needs a speed-only parity run. */
  ab?: { head: AbRows; base: AbRows; extra: ExtraBudget; /** Thresholds of rows other than bench/ab-config.ts names (tests of the job path). */ regression?: Readonly<Record<string, { delta: number }>> } | null;
  /** Replaces the timing of a row altogether: the process that measures the base answers the benchmark's requests with it (bench/ab-child.ts). */
  timer?: (rowId: string, ours: () => Promise<void> | void, reference: () => Promise<void> | void, weight: RowWeight, oursRepeats: number) => Promise<InterleavedTiming | AdaptiveTiming>;
}

/** `action` followed by a busy wait that makes the whole call INJECTED_SLOWDOWN_FACTOR times as long. */
export function slowed(action: () => Promise<void> | void): () => Promise<void> {
  return async () => {
    const start = performance.now();
    await action();
    const spent = performance.now() - start;
    const until = performance.now() + spent * (INJECTED_SLOWDOWN_FACTOR - 1);
    while (performance.now() < until) {
      // Spin: the point is CPU time on our side, as a slower implementation would spend.
    }
  };
}

function headRefused(error: unknown): never {
  if (error instanceof BaseRowError) throw new AbHostError(`the head cannot run a row it is measured on: ${error.message}`);
  throw error;
}

export type RowTimer = (rowId: string, ours: () => Promise<void> | void, reference: () => Promise<void> | void, weight: RowWeight, oursRepeats?: number) => Promise<InterleavedTiming | AdaptiveTiming>;

export function createTimer(init: TimerInit): RowTimer {
  return async (rowId, rawOurs, reference, weight, oursRepeats = 1) => {
    if (init.timer) return init.timer(rowId, rawOurs, reference, weight, oursRepeats);
    const ours = init.injection === 'slow-ours' ? slowed(rawOurs) : rawOurs;
    let abFallback: string | undefined;
    if (init.parity && init.ab) {
      // The head and the base each run in a process of their own, the reference here; a row the base cannot run is measured against the reference alone.
      const { head, base, extra } = init.ab;
      await head.row(rowId);
      await base.row(rowId);
      const plan = weight === 'heavy' ? HEAVY_SPEED_PLAN : LIGHT_SPEED_PLAN;
      const headSide = head.side();
      // The head must run its own row: its refusal is an error of the benchmark, not a row without a base.
      const guarded: Side = {
        call: () => headSide.call().catch(headRefused),
        sample: (calls) => headSide.sample(calls).catch(headRefused),
      };
      try {
        const timing = await abSpeedTiming(guarded, base.side(), localSide(reference), {
          pairs: weight === 'heavy' ? AB_HEAVY_PAIRS : AB_LIGHT_PAIRS,
          warmup: plan.warmup,
          oursRepeats,
          minSampleMs: plan.minSampleMs,
          extra,
          delta: regressionDelta(rowId, init.ab.regression),
        });
        init.log(`A/B against the base, ${timing.runs} pairs (${timing.ab.extraPairs} extra), noise ${timing.ab.noise.toFixed(3)}: head ${timing.repeats.ours} call(s), reference ${timing.repeats.reference} call(s) per sample`);
        return timing;
      } catch (error) {
        if (!(error instanceof BaseRowError)) throw error;
        abFallback = error.message.slice(0, 200);
        init.log(`the base cannot run this row (${abFallback}); it is measured against the reference alone`);
      } finally {
        head.next();
        base.next();
      }
    }
    if (init.parity) {
      const timing = await adaptiveSpeedTiming(ours, reference, { ...(weight === 'heavy' ? HEAVY_SPEED_PLAN : LIGHT_SPEED_PLAN), oursRepeats });
      if (timing.repeats.ours > 1 || timing.repeats.reference > 1) {
        init.log(`samples of at least ${SPEED_MIN_SAMPLE_MS} ms: ours ${timing.repeats.ours} call(s), reference ${timing.repeats.reference} call(s) each`);
      }
      return abFallback === undefined ? timing : { ...timing, abFallback };
    }
    return interleavedTiming(ours, reference, weight === 'heavy' ? init.heavyRuns : init.runs, init.warmup, oursRepeats);
  };
}
