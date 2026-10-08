import fs from 'node:fs';
import path from 'node:path';
import { CORPUS_DIR } from './config';
import { BenchArgumentError } from './errors';
import type { BenchRow } from './report';
import { type PlanOptions, planTools, type Resolver, type ToolPlan } from './tools';

/**
 * Regressions the runner can apply to our side of a comparison, to show that the gate catches them. They change
 * only the options this harness passes to the public conversion entry point; the reference side is untouched.
 */
export const INJECTIONS = ['webp-quality', 'x264-ultrafast'] as const;
export type Injection = (typeof INJECTIONS)[number];
const INJECTION_SET: ReadonlySet<string> = new Set(INJECTIONS);
/** `webp-quality` asks for this share of the nominal quality: a lowered quality setting. */
export const INJECTED_WEBP_QUALITY_SHARE = 0.6;

export function parseInjection(value: string): Injection {
  if (!INJECTION_SET.has(value)) throw new BenchArgumentError(`unknown regression "${value}"; use one of ${INJECTIONS.join(', ')}`);
  return value as Injection;
}

export interface FamilyContext {
  resolve: Resolver;
  strict: boolean;
  runs: number;
  heavyRuns: number;
  warmup: number;
  injection: Injection | null;
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
  work: string;
  log: (message: string) => void;
}

export function createContext(init: ContextInit): FamilyContext {
  let counter = 0;
  return {
    ...init,
    plan: (required, context, options) => planTools(required, context, init.resolve, init.strict, options),
    corpusPath: (name) => path.join(CORPUS_DIR, name),
    corpusBuffer: (name) => fs.readFileSync(path.join(CORPUS_DIR, name)),
    scratch: (name) => path.join(init.work, `${counter++}-${name}`),
  };
}
