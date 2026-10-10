import { ReportSchemaError } from './errors';
import type { Family } from './report';

/**
 * The shape of one row of a report and its validation: what a verdict can read. It is gate code (the `parity speed` job takes
 * it from the base commit), so a change cannot decide which fields of a speed row survive into the verdict. The families a
 * row may name are the harness's (bench/report.ts) and are passed in.
 */

/** Relative slack when checking that a row's delta equals ours - reference after a JSON round trip. */
const DELTA_CONSISTENCY_EPSILON = 1e-6;

export type Direction = 'higher' | 'lower';
const DIRECTION_SET: ReadonlySet<string> = new Set(['higher', 'lower']);

/** quality: a measured score; size: bytes or bit rate; bdrate: Bjontegaard delta; throughput: speed, gated by ratio; exact: 1 when a lossless check holds. */
export const ROW_KINDS = ['quality', 'size', 'bdrate', 'throughput', 'exact'] as const;
export type RowKind = (typeof ROW_KINDS)[number];
const ROW_KIND_SET: ReadonlySet<string> = new Set(ROW_KINDS);

/** The decision a parity run took on a throughput row; `unstable` never reaches a report, it becomes `fail` at the cap. */
export type RowSpeedVerdict = 'pass' | 'fail';
const SPEED_VERDICT_SET: ReadonlySet<string> = new Set(['pass', 'fail']);

export const SKIP_KINDS = ['missing-tool', 'optional-tool', 'unsupported'] as const;
export type SkipKind = (typeof SKIP_KINDS)[number];
const SKIP_KIND_SET: ReadonlySet<string> = new Set(SKIP_KINDS);

/** Largest allowed worsening of a gated number: the larger of `abs` and `rel` times the baseline magnitude. */
export interface Tolerance {
  abs: number;
  rel: number;
}

export interface BenchRow {
  /** `<family>/<case>/<metric>`, unique within a report and the key of the baseline entry. */
  id: string;
  family: Family;
  case: string;
  metric: string;
  unit: string;
  direction: Direction;
  kind: RowKind;
  status: 'measured' | 'skipped';
  /** Value of this project's output; null on a skipped row. */
  ours: number | null;
  /** Value of the reference tool's output at the same settings; null when skipped. */
  reference: number | null;
  /** ours - reference. */
  delta: number | null;
  /** ours / reference, recorded for throughput rows (a speed ratio); null otherwise. */
  ratio: number | null;
  referenceTool: string;
  tolerance: Tolerance;
  /** Throughput rows: coefficient of variation of the timing samples of each side, and the sample count. */
  oursCv?: number;
  referenceCv?: number;
  runs?: number;
  /** Parity runs: confidence interval of the speed ratio (reference time / our time) and the decision taken on it. */
  ratioLow?: number;
  ratioHigh?: number;
  ratioMedian?: number;
  speedVerdict?: RowSpeedVerdict;
  /** The interval still straddled the pass line at the cap on pairs, which counts as a failure. */
  unstableAtCap?: boolean;
  /**
   * A/B comparison with the base of the change, measured in the same pairs (bench/ab-speed.ts): the number of pairs, the
   * median of base time / head time, its upper bound and the upper bound of reference time / head time at the per-row
   * error rate (absent when too few pairs exist for a bound: the row cannot fail on it), the standard deviation of the
   * log of the pair ratios (the noise of the comparison), the median of reference time / base time and the pairs added
   * for a bound that was too wide. All absent when the row was not compared with a base.
   */
  abPairs?: number;
  abMedian?: number;
  abUpper?: number;
  abHeadVsReferenceUpper?: number;
  abNoise?: number;
  /** Mean milliseconds of one pair (the head, the base and the reference timed once each): what the simulation of the gate spends its extra budget with. */
  abPairMs?: number;
  abBaseVsReferenceMedian?: number;
  abExtraPairs?: number;
  /** A second set of fresh pairs was taken because the first showed the head credibly slower than the base / below the reference the base was at: whether it showed it too. */
  abSlowerConfirmed?: boolean;
  abLostConfirmed?: boolean;
  /** Why a row of a run with a base was measured against the reference alone (the base could not run it). */
  abFallback?: string;
  skipKind?: SkipKind;
  skipReason?: string;
}


export function fail(path: string, expectation: string): never {
  throw new ReportSchemaError(`report schema: ${path} must be ${expectation}`);
}

export function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'an object');
  return value as Record<string, unknown>;
}

export function str(value: unknown, path: string): string {
  if (typeof value !== 'string' || value === '') fail(path, 'a non-empty string');
  return value as string;
}

export function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'a finite number');
  return value as number;
}

function nullableNumber(value: unknown, path: string): number | null {
  return value === null ? null : finiteNumber(value, path);
}

export function member<T extends string>(value: unknown, set: ReadonlySet<string>, path: string): T {
  if (typeof value !== 'string' || !set.has(value)) fail(path, `one of ${[...set].join(', ')}`);
  return value as T;
}

export function validateTolerance(value: unknown, path: string): Tolerance {
  const obj = record(value, path);
  const abs = finiteNumber(obj.abs, `${path}.abs`);
  const rel = finiteNumber(obj.rel, `${path}.rel`);
  if (abs < 0 || rel < 0) fail(path, 'non-negative');
  return { abs, rel };
}

export function validateRow(value: unknown, index: number, familySet: ReadonlySet<string>): BenchRow {
  const path = `rows[${index}]`;
  const row = record(value, path);
  const id = str(row.id, `${path}.id`);
  const family = member<Family>(row.family, familySet, `${path}.family`);
  const caseName = str(row.case, `${path}.case`);
  const metric = str(row.metric, `${path}.metric`);
  if (id !== `${family}/${caseName}/${metric}`) fail(`${path}.id`, `"${family}/${caseName}/${metric}"`);
  const status = row.status;
  if (status !== 'measured' && status !== 'skipped') fail(`${path}.status`, '"measured" or "skipped"');
  const parsed: BenchRow = {
    id,
    family,
    case: caseName,
    metric,
    unit: str(row.unit, `${path}.unit`),
    direction: member<Direction>(row.direction, DIRECTION_SET, `${path}.direction`),
    kind: member<RowKind>(row.kind, ROW_KIND_SET, `${path}.kind`),
    status: status as 'measured' | 'skipped',
    ours: nullableNumber(row.ours, `${path}.ours`),
    reference: nullableNumber(row.reference, `${path}.reference`),
    delta: nullableNumber(row.delta, `${path}.delta`),
    ratio: nullableNumber(row.ratio, `${path}.ratio`),
    referenceTool: str(row.referenceTool, `${path}.referenceTool`),
    tolerance: validateTolerance(row.tolerance, `${path}.tolerance`),
  };
  if (parsed.status === 'measured') {
    if (parsed.ours === null || parsed.reference === null || parsed.delta === null) {
      fail(path, 'a measured row with ours, reference and delta');
    }
    if (parsed.kind === 'throughput' && (parsed.ratio === null || parsed.ratio <= 0)) fail(`${path}.ratio`, 'a positive speed ratio on a throughput row');
    if (Math.abs((parsed.ours as number) - (parsed.reference as number) - (parsed.delta as number)) > DELTA_CONSISTENCY_EPSILON * (1 + Math.abs(parsed.delta as number))) {
      fail(`${path}.delta`, 'ours - reference');
    }
  } else {
    if (parsed.ours !== null || parsed.reference !== null || parsed.delta !== null || parsed.ratio !== null) fail(path, 'a skipped row without values');
    parsed.skipKind = member<SkipKind>(row.skipKind, SKIP_KIND_SET, `${path}.skipKind`);
    parsed.skipReason = str(row.skipReason, `${path}.skipReason`);
  }
  for (const key of ['oursCv', 'referenceCv', 'runs', 'ratioLow', 'ratioHigh', 'ratioMedian', 'abPairs', 'abMedian', 'abUpper', 'abHeadVsReferenceUpper', 'abNoise', 'abPairMs', 'abBaseVsReferenceMedian', 'abExtraPairs'] as const) {
    if (row[key] !== undefined) parsed[key] = finiteNumber(row[key], `${path}.${key}`);
  }
  for (const key of ['abSlowerConfirmed', 'abLostConfirmed'] as const) {
    if (row[key] !== undefined) {
      if (typeof row[key] !== 'boolean') fail(`${path}.${key}`, 'a boolean');
      parsed[key] = row[key] as boolean;
    }
  }
  if (row.abFallback !== undefined) parsed.abFallback = str(row.abFallback, `${path}.abFallback`);
  if (row.speedVerdict !== undefined) parsed.speedVerdict = member<RowSpeedVerdict>(row.speedVerdict, SPEED_VERDICT_SET, `${path}.speedVerdict`);
  if (row.unstableAtCap !== undefined) {
    if (typeof row.unstableAtCap !== 'boolean') fail(`${path}.unstableAtCap`, 'a boolean');
    parsed.unstableAtCap = row.unstableAtCap;
  }
  return parsed;
}
