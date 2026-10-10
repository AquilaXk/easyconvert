/**
 * Simulation of the speed gate on rows with a known truth, to measure how often it fails by chance and how often it
 * catches a real slowdown:
 *   npx tsx bench/simulate-speed-gate.ts [--trials 1000] [--sigma 0.02] [--rows 40] [--noise bench/ab-noise-samples.json]
 *
 * Each pair of a simulated row draws the three times (head, base, reference) with a log-normal noise per sample
 * (`sigma`) and a load factor shared by the three samples of the pair (`COMMON_SIGMA`, the part pairing cancels). The
 * draws go through the real procedures (adaptiveSpeedTiming for the absolute gate, abSpeedTiming for the A/B gate) and
 * the real verdict (evaluateParity), with a fixed seed per trial so every number reproduces. "Absolute gate" is the
 * head against the reference alone, an interval that straddles the pass line at the last cap counting as a failure.
 * With `--noise`, the second table takes the noise of each row from measured A/B noise (the standard deviation of the log
 * of the pair ratios of two copies of the same code on the CI runner, bench/ab-noise-samples.json), so the rows are
 * as noisy as the rows of the benchmark are.
 */
import fs from 'node:fs';
import { AB_DEFAULT_REGRESSION, AB_EXTRA_BUDGET_MS, AB_HEAVY_PAIRS, AB_LIGHT_PAIRS, AB_ROW_REGRESSION } from './ab-config';
import { abSpeedTiming, type ExtraBudget, type Side } from './ab-speed';
import { PARITY_SCHEMA_VERSION, SCHEMA_VERSION } from './config';
import { evaluateParity } from './parity';
import type { BenchReport } from './report';
import { throughputRow } from './rows';
import { adaptiveSpeedTiming, HEAVY_SPEED_PLAN, LIGHT_SPEED_PLAN } from './speed-parity';

/** The spread of the load the three samples of a pair share; the head-to-base ratio does not see it. */
export const COMMON_SIGMA = 0.05;

export type Weight = 'light' | 'heavy';

/** mulberry32: a small seeded generator, enough for reproducible noise. */
export function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const gaussian = (uniform: () => number): number => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());

function reportOf(row: ReturnType<typeof throughputRow>): BenchReport {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: '2026-01-01T00:00:00.000Z',
    strictMode: true,
    families: ['compression'],
    host: { platform: 'linux', arch: 'x64', node: 'v20.0.0', cpus: 4 },
    tools: {},
    settings: { runs: 1, injectedRegression: null },
    rows: [row],
  };
}

export interface Truth {
  /** True speed of the head against the reference (reference time / head time). */
  headVsReference: number;
  /** True speed of the head against the base (base time / head time); 1 for a change that did not touch the row. */
  headVsBase: number;
  /** Noise of each sample (log-normal sigma). */
  sigma: number;
  /** Systematic speed of the base against an identical head: a bias of the comparison itself (1: none). */
  baseBias?: number;
  /** Milliseconds a sample of the reference takes (100 when omitted): it sets how fast the extra budget is spent. */
  referenceMs?: number;
}

/** Draws samples: the true time (reference = 100 ms) times the pair's load and the sample's own noise. */
function drawer(truth: Truth, seed: number) {
  const uniform = seeded(seed);
  let load = 1;
  const unit = (truth.referenceMs ?? 100) / 100;
  const sample = (speed: number): number => (100 / speed) * unit * load * Math.exp(truth.sigma * gaussian(uniform));
  return {
    startPair: (): void => {
      load = Math.exp(COMMON_SIGMA * gaussian(uniform));
    },
    head: (): number => sample(truth.headVsReference),
    base: (): number => sample((truth.headVsReference / truth.headVsBase) * (truth.baseBias ?? 1)),
    reference: (): number => sample(1),
  };
}

export interface AbGateOptions {
  regression?: { delta: number };
  /** Extra pairs and confirmation sets for a row, drawn on this budget (ms of simulated time), which the caller may share between rows. */
  extra?: ExtraBudget;
}

/** Whether the A/B gate fails the simulated row. */
export async function abGateFails(truth: Truth, weight: Weight, seed: number, options: AbGateOptions = {}): Promise<boolean> {
  const draw = drawer(truth, seed);
  let clock = 0;
  let calls = 0;
  const plan = weight === 'heavy' ? HEAVY_SPEED_PLAN : LIGHT_SPEED_PLAN;
  // Three samples make a pair; the first of them starts it.
  const side = (which: () => number): Side => {
    const once = async (): Promise<number> => {
      if (calls++ % 3 === 0) draw.startPair();
      const ms = which();
      clock += ms;
      return ms;
    };
    return { call: once, sample: once };
  };
  const timing = await abSpeedTiming(
    side(draw.head),
    side(draw.base),
    side(draw.reference),
    { pairs: weight === 'heavy' ? AB_HEAVY_PAIRS : AB_LIGHT_PAIRS, warmup: 0, minSampleMs: 0, tolerance: plan.tolerance, delta: options.regression?.delta, extra: options.extra },
    () => clock
  );
  const row = throughputRow('compression', 'c', 1e6, timing, 'tool');
  const overrides = options.regression ? { [row.id]: options.regression } : undefined;
  return evaluateParity(reportOf(row), { schemaVersion: PARITY_SCHEMA_VERSION, gaps: [] }, { regression: overrides }).rows[0].outcome === 'fail';
}

/** Whether the absolute gate (the head against the reference alone) fails the simulated row. */
export async function absoluteGateFails(truth: Truth, weight: Weight, seed: number): Promise<boolean> {
  const draw = drawer(truth, seed);
  let clock = 0;
  let calls = 0;
  const tick = (side: () => number): void => {
    if (calls++ % 2 === 0) draw.startPair();
    clock += side();
  };
  const plan = weight === 'heavy' ? HEAVY_SPEED_PLAN : LIGHT_SPEED_PLAN;
  const timing = await adaptiveSpeedTiming(() => tick(draw.head), () => tick(draw.reference), { ...plan, warmup: 0, minSampleMs: 0 }, () => clock);
  const row = throughputRow('compression', 'c', 1e6, timing, 'tool');
  return evaluateParity(reportOf(row), { schemaVersion: PARITY_SCHEMA_VERSION, gaps: [] }).rows[0].outcome === 'fail';
}

export async function failureRate(gate: (seed: number) => Promise<boolean>, trials: number, firstSeed = 1000): Promise<number> {
  let failures = 0;
  for (let trial = 0; trial < trials; trial++) if (await gate(firstSeed + trial)) failures++;
  return failures / trials;
}

/** The per-sample sigma that gives a pair ratio of the measured noise (the ratio of two samples has sqrt(2) times a sample's sigma). */
export const sigmaOfRatioNoise = (noise: number): number => noise / Math.SQRT2;

export interface NoiseSample {
  id: string;
  /** Standard deviation of the log of the pair ratios of two copies of the same code. */
  noise: number;
  weight: Weight;
  /** Mean milliseconds of one pair (the head, the base and the reference once each); 300 when the measurement did not record it. */
  pairMs?: number;
}

/** The family of a row id, which is the shard that measures it. */
export const shardOf = (id: string): string => id.split('/')[0];

/**
 * One trial of a shard: its rows in the order the benchmark measures them, sharing the one extra budget of the shard, each
 * with its own threshold (`thresholds`, else the default of the gate). Returns the rows that failed.
 */
export async function shardTrial(rows: readonly NoiseSample[], slowdown: number, seed: number, budgetMs: number, thresholds: Readonly<Record<string, { delta: number }>> = {}): Promise<Set<string>> {
  const extra: ExtraBudget = { remainingMs: budgetMs };
  const failed = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const truth: Truth = { headVsBase: 1 / (1 + slowdown), headVsReference: 1, sigma: sigmaOfRatioNoise(row.noise), referenceMs: (row.pairMs ?? 300) / 3 };
    if (await abGateFails(truth, row.weight, seed * 1000 + index, { regression: thresholds[row.id], extra })) failed.add(row.id);
  }
  return failed;
}

/** The failure rate of every row at one slowdown, over `trials` trials of its shard (rows share the shard's extra budget in order). */
export async function rowRates(rows: readonly NoiseSample[], slowdown: number | ((row: NoiseSample) => number), trials: number, budgetMs: number, thresholds: Readonly<Record<string, { delta: number }>> = {}): Promise<Map<string, number>> {
  const counts = new Map<string, number>(rows.map((row) => [row.id, 0]));
  const shards = new Map<string, NoiseSample[]>();
  for (const row of rows) shards.set(shardOf(row.id), [...(shards.get(shardOf(row.id)) ?? []), row]);
  for (const shard of shards.values()) {
    for (let trial = 0; trial < trials; trial++) {
      // The slowdown may depend on the row (1.5 times its own threshold): each row of the shard keeps its own, in the same budget.
      const extra: ExtraBudget = { remainingMs: budgetMs };
      for (const [index, row] of shard.entries()) {
        const s = typeof slowdown === 'number' ? slowdown : slowdown(row);
        const truth: Truth = { headVsBase: 1 / (1 + s), headVsReference: 1, sigma: sigmaOfRatioNoise(row.noise), referenceMs: (row.pairMs ?? 300) / 3 };
        if (await abGateFails(truth, row.weight, 1000 + trial * 1000 + index, { regression: thresholds[row.id], extra })) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
      }
    }
  }
  return new Map([...counts].map(([id, count]) => [id, count / trials] as const));
}

/** Thresholds a row may ask for: the default first, then in steps of 2.5 percent. */
export const THRESHOLD_STEPS: readonly number[] = [AB_DEFAULT_REGRESSION, ...Array.from({ length: 17 }, (_, index) => 0.125 + index * 0.025)];

/**
 * The smallest threshold (of THRESHOLD_STEPS) at which each row, with its shard's shared extra budget in the order of the
 * benchmark, fails a slowdown of 1.5 times it in at least `target` of the trials. Rows are settled from the quietest threshold up: a
 * row that meets the bar at a step keeps it, the others try the next step; none up to the last step is left out.
 */
export async function deriveThresholds(rows: readonly NoiseSample[], trials: number, budgetMs: number, target = 0.95): Promise<Record<string, number>> {
  const chosen: Record<string, number> = {};
  for (const delta of THRESHOLD_STEPS) {
    const pending = rows.filter((row) => chosen[row.id] === undefined);
    if (pending.length === 0) break;
    // Every row at the threshold it has, the unsettled ones at this step, tested at 1.5 times their own.
    const own = (row: NoiseSample): number => chosen[row.id] ?? delta;
    const thresholds = Object.fromEntries(rows.map((row) => [row.id, { delta: own(row) }] as const));
    const detect = await rowRates(rows, (row) => 1.5 * own(row), trials, budgetMs, thresholds);
    for (const row of pending) if ((detect.get(row.id) ?? 0) >= target) chosen[row.id] = delta;
  }
  return chosen;
}

const percent = (value: number): string => `${(100 * value).toFixed(1)}%`;

async function main(args: string[]): Promise<void> {
  const flag = (name: string, fallback: number): number => {
    const at = args.indexOf(name);
    return at >= 0 ? Number(args[at + 1]) : fallback;
  };
  const trials = flag('--trials', 1000);
  const sigma = flag('--sigma', 0.02);
  const rows = flag('--rows', 40);
  const noiseAt = args.indexOf('--noise');
  const perRun = (rate: number): string => percent(1 - (1 - rate) ** rows);
  console.log(`trials ${trials}, noise per sample ${sigma}, common load ${COMMON_SIGMA}, ${rows} rows per run\n`);
  console.log(`| Weight | Head slower than the base by | True ratio to the reference | Absolute gate fails | A/B gate fails (threshold ${AB_DEFAULT_REGRESSION * 100}%) | A/B gate fails a run of ${rows} unchanged rows |`);
  console.log('|---|---|---|---|---|---|');
  for (const weight of ['light', 'heavy'] as const) {
    const cases: Array<[string, number, number]> = [
      ['none', 1, 1.0],
      ['none', 1, 0.99],
      ['none', 1, 0.98],
      ['none', 1, 0.97],
      ['none', 1, 0.9],
      ['-5%', 0.95, 1.0],
      ['-10%', 1 / 1.1, 1.0],
      ['-15%', 1 / 1.15, 1.0],
      ['-20%', 1 / 1.2, 1.0],
      ['-30%', 1 / 1.3, 1.0],
    ];
    for (const [label, headVsBase, headVsReference] of cases) {
      const truth: Truth = { headVsBase, headVsReference, sigma };
      const absolute = await failureRate((seed) => absoluteGateFails(truth, weight, seed), trials);
      const ab = await failureRate((seed) => abGateFails(truth, weight, seed), trials);
      console.log(`| ${weight} | ${label} | ${headVsReference} | ${percent(absolute)} | ${percent(ab)} | ${label === 'none' ? perRun(ab) : '-'} |`);
    }
  }
  if (noiseAt >= 0) {
    const samples = JSON.parse(fs.readFileSync(args[noiseAt + 1], 'utf8')) as { rows: NoiseSample[] };
    const perRow = Math.max(40, Math.floor(trials / 10));
    const budget = AB_EXTRA_BUDGET_MS;
    const thresholds = Object.fromEntries(Object.entries(AB_ROW_REGRESSION).map(([id, override]) => [id, { delta: override.delta }] as const));
    const deltaOf = (row: NoiseSample): number => thresholds[row.id]?.delta ?? AB_DEFAULT_REGRESSION;
    console.log(`\nRows with the measured noise of ${args[noiseAt + 1]} (${samples.rows.length} rows, ${perRow} trials per row; the rows of a family share its extra budget of ${budget / 60000} min of simulated time, in the order of the benchmark; every row with its own threshold)\n`);
    const unchanged = await rowRates(samples.rows, 0, perRow, budget, thresholds);
    const slow = await rowRates(samples.rows, (row) => 1.5 * deltaOf(row), perRow, budget, thresholds);
    const just = await rowRates(samples.rows, (row) => deltaOf(row), perRow, budget, thresholds);
    const fmt = (map: Map<string, number>, id: string): string => percent(map.get(id) ?? 0);
    console.log('| Row | Noise | Threshold | Unchanged fails | At the threshold fails | At 1.5 times the threshold fails |');
    console.log('|---|---|---|---|---|---|');
    for (const row of samples.rows) console.log(`| ${row.id} | ${row.noise.toFixed(3)} | ${percent(deltaOf(row))} | ${fmt(unchanged, row.id)} | ${fmt(just, row.id)} | ${fmt(slow, row.id)} |`);
    const reliable = samples.rows.filter((row) => (slow.get(row.id) ?? 0) >= 0.95).length;
    const falseRows = samples.rows.filter((row) => (unchanged.get(row.id) ?? 0) > 0.01).length;
    console.log(`\nRows that fail 1.5 times their threshold in at least 95% of the trials: ${reliable} of ${samples.rows.length}; rows that fail unchanged code in more than 1%: ${falseRows}`);
    if (args.includes('--derive')) {
      const derived = await deriveThresholds(samples.rows, perRow, budget);
      console.log('\nSmallest threshold per row that fails 1.5 times it in at least 95% of the trials:\n');
      for (const row of samples.rows) console.log(`${row.id} ${derived[row.id] === undefined ? 'none up to 50%' : derived[row.id]}`);
    }
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(2);
  });
}
