import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { CORPUS_DIR } from './config';
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
  /** Interleaved timing of `ours` against `reference`: fixed runs, or adaptive paired runs in a parity run. */
  time: (ours: () => Promise<void> | void, reference: () => Promise<void> | void, weight: RowWeight) => Promise<InterleavedTiming | AdaptiveTiming>;
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
}

/** `action` followed by a busy wait that makes the whole call INJECTED_SLOWDOWN_FACTOR times as long. */
function slowed(action: () => Promise<void> | void): () => Promise<void> {
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

export function createContext(init: ContextInit): FamilyContext {
  let counter = 0;
  const { quick, ...rest } = init;
  return {
    ...rest,
    inScope: (family, caseName) => caseInScope(quick, family, caseName),
    time: (rawOurs, reference, weight) => {
      const ours = init.injection === 'slow-ours' ? slowed(rawOurs) : rawOurs;
      if (init.parity) {
        return adaptiveSpeedTiming(ours, reference, weight === 'heavy' ? HEAVY_SPEED_PLAN : LIGHT_SPEED_PLAN);
      }
      return interleavedTiming(ours, reference, weight === 'heavy' ? init.heavyRuns : init.runs, init.warmup);
    },
    plan: (required, context, options) => planTools(required, context, init.resolve, init.strict, options),
    corpusPath: (name) => path.join(CORPUS_DIR, name),
    corpusBuffer: (name) => fs.readFileSync(path.join(CORPUS_DIR, name)),
    scratch: (name) => path.join(init.work, `${counter++}-${name}`),
  };
}
