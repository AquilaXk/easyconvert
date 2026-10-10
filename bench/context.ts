import fs from 'node:fs';
import path from 'node:path';
import { CORPUS_DIR } from './config';
import { BenchArgumentError } from './errors';
import type { ReferenceCache } from './ref-cache';
import type { BenchRow, Family } from './report';
import { caseInScope } from './scope';
import { createTimer, type RowTimer, type TimerInit } from './speed-timing';
import type { AdaptiveTiming } from './speed-parity';
import type { InterleavedTiming } from './stats';
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
export { INJECTED_SLOWDOWN_FACTOR, type AbRows } from './speed-timing';

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
  time: (rowId: string, ours: () => Promise<void> | void, reference: () => Promise<void> | void, weight: RowWeight, oursRepeats?: number) => Promise<InterleavedTiming | AdaptiveTiming>;
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

export interface ContextInit extends Pick<TimerInit, 'ab' | 'timer'> {
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

export function createContext(init: ContextInit): FamilyContext {
  let counter = 0;
  const { quick, ...rest } = init;
  return {
    ...rest,
    inScope: (family, caseName) => caseInScope(quick, family, caseName),
    time: createTimer(init),
    plan: (required, context, options) => planTools(required, context, init.resolve, init.strict, options),
    corpusPath: (name) => path.join(CORPUS_DIR, name),
    corpusBuffer: (name) => fs.readFileSync(path.join(CORPUS_DIR, name)),
    scratch: (name) => path.join(init.work, `${counter++}-${name}`),
  };
}
