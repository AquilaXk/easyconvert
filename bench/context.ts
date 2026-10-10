import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { AB_HEAVY_PAIRS, AB_LIGHT_PAIRS } from './ab-config';
import type { AbHost } from './ab-host';
import { AbHostError, BaseRowError } from './ab-host';
import { abSpeedTiming, type ExtraBudget, localSide, type Side } from './ab-speed';
import { CORPUS_DIR, SPEED_MIN_SAMPLE_MS } from './config';
import { BenchArgumentError } from './errors';
import type { ReferenceCache } from './ref-cache';
import type { BenchRow, Family } from './report';
import { caseInScope } from './scope';
import { adaptiveSpeedTiming, HEAVY_SPEED_PLAN, LIGHT_SPEED_PLAN, type AdaptiveTiming } from './speed-parity';
import { type InterleavedTiming, interleavedTiming } from './stats';
import { type PlanOptions, planTools, type Resolver, type ToolPlan } from './tools';

/**
 * Regressions the runner can apply to our side of a comparison, to show that the gate catches them. They change
 * only what this harness asks of our side (the options it passes to the public conversion entry point, or how long a
 * timed run of ours takes); the reference side is untouched.
 */
export const INJECTIONS = ['webp-quality', 'x264-ultrafast', 'webp-reencode', 'slow-ours'] as const;
export type Injection = (typeof INJECTIONS)[number];
const INJECTION_SET: ReadonlySet<string> = new Set(INJECTIONS);
/**
 * `webp-quality` asks for this share of the nominal quality: a lowered quality setting. It moves along the same
 * rate-distortion curve, so it is a regression against our own baseline but not against the reference at equal size.
 * `webp-reencode` encodes our WebP twice (generation loss), which makes the curve itself worse; BD-rate sees that.
 */
export const INJECTED_WEBP_QUALITY_SHARE = 0.6;
/** `slow-ours` makes each timed run of our side take this many times as long: a speed regression for the parity gate. */
export const INJECTED_SLOWDOWN_FACTOR = 2;

export function parseInjection(value: string): Injection {
  if (!INJECTION_SET.has(value)) throw new BenchArgumentError(`unknown regression "${value}"; use one of ${INJECTIONS.join(', ')}`);
  return value as Injection;
}

/** Light rows take milliseconds to seconds per run; heavy rows (video, OCR, office) take seconds each. */
export type RowWeight = 'light' | 'heavy';

export interface FamilyContext {
  resolve: Resolver;
  strict: boolean;
  runs: number;
  heavyRuns: number;
  warmup: number;
  injection: Injection | null;
  /** Parity run: speed rows collect paired runs until a confidence interval decides; reference-side quality is cached. */
  parity: boolean;
  /** Whether quality rows are measured (false for `--speed-only`). */
  quality: boolean;
  /** Whether throughput rows are measured (false for `--quality-only`). */
  speed: boolean;
  /** Reference-side quality measurements; a pass-through when the cache is off. */
  refCache: ReferenceCache;
  /** Whether the case runs in this invocation: every case, or the `--quick` subset of its family. */
  inScope: (family: Family, caseName: string) => boolean;
  /**
   * Interleaved timing of `ours` against `reference`: fixed runs, or adaptive paired runs in a parity run. A side that
   * finishes in milliseconds passes `oursRepeats` > 1 to time that many back-to-back calls per sample. A parity run also
   * calibrates, per row, how many back-to-back calls make a sample of either side last SPEED_MIN_SAMPLE_MS.
   */
  time: (ours: () => Promise<void> | void, reference: () => Promise<void> | void, weight: RowWeight, oursRepeats?: number) => Promise<InterleavedTiming | AdaptiveTiming>;
  /** Scratch directory of this run; removed by the runner. */
  work: string;
  log: (message: string) => void;
  plan: (required: readonly string[], context: string, options?: PlanOptions) => ToolPlan;
  corpusPath: (name: string) => string;
  corpusBuffer: (name: string) => Buffer;
  /** A fresh scratch path inside `work`. */
  scratch: (name: string) => string;
}

export type FamilyRunner = (ctx: FamilyContext) => Promise<BenchRow[]>;

export interface ContextInit {
  resolve: Resolver;
  strict: boolean;
  runs: number;
  heavyRuns: number;
  warmup: number;
  injection: Injection | null;
  parity: boolean;
  quality: boolean;
  speed: boolean;
  quick: boolean;
  refCache: ReferenceCache;
  work: string;
  log: (message: string) => void;
  /** Speed rows are measured against the base of the change too: the head and the base each run in a process of their own (bench/ab-host.ts), so neither has the advantage of the benchmark's process; needs a speed-only parity run. */
  ab?: { head: AbHost; base: AbHost; extra: ExtraBudget } | null;
  /** Replaces the timing of a row altogether: the process that measures the base answers the benchmark's requests with it (bench/ab-child.ts). */
  timer?: (ours: () => Promise<void> | void, reference: () => Promise<void> | void, weight: RowWeight, oursRepeats: number) => Promise<InterleavedTiming | AdaptiveTiming>;
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

export function createContext(init: ContextInit): FamilyContext {
  let counter = 0;
  const { quick, ...rest } = init;
  return {
    ...rest,
    inScope: (family, caseName) => caseInScope(quick, family, caseName),
    time: async (rawOurs, reference, weight, oursRepeats = 1) => {
      if (init.timer) return init.timer(rawOurs, reference, weight, oursRepeats);
      const ours = init.injection === 'slow-ours' ? slowed(rawOurs) : rawOurs;
      let abFallback: string | undefined;
      if (init.parity && init.ab) {
        // The head and the base each run in a process of their own, the reference here; a row the base cannot run is measured against the reference alone.
        const { head, base, extra } = init.ab;
        await head.row();
        await base.row();
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
    },
    plan: (required, context, options) => planTools(required, context, init.resolve, init.strict, options),
    corpusPath: (name) => path.join(CORPUS_DIR, name),
    corpusBuffer: (name) => fs.readFileSync(path.join(CORPUS_DIR, name)),
    scratch: (name) => path.join(init.work, `${counter++}-${name}`),
  };
}
