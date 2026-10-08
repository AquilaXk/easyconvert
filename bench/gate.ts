import fs from 'node:fs';
import { GATE_EPSILON, MAX_JSON_BYTES, MAX_ROWS, SCHEMA_VERSION } from './config';
import { ReportSchemaError } from './errors';
import { type BenchReport, type BenchRow, type Direction, type Family, type Tolerance, validateTolerance } from './report';

/**
 * Regression gate. Each baseline entry stores a direction (which way is better) and a tolerance. A measured row is
 * compared to its entry twice: our own value against the baseline value, and our delta to the reference tool
 * against the baseline delta (so a reference that got better, or ours falling behind it, is caught even when our
 * absolute number is steady). Throughput rows depend on the machine, so only the speed ratio to the reference
 * tool run in the same window is gated.
 */

export interface BaselineEntry {
  direction: Direction;
  tolerance: Tolerance;
  /** Our value; null for rows whose absolute value depends on the machine. */
  ours: number | null;
  /** ours - reference; null for rows gated by ratio. */
  delta: number | null;
  /** ours / reference; set only for throughput rows. */
  ratio: number | null;
}

export interface Baseline {
  schemaVersion: number;
  entries: Record<string, BaselineEntry>;
}

export type RegressionCheck = 'baseline' | 'reference-delta' | 'speed-ratio' | 'missing';

export interface Regression {
  id: string;
  check: RegressionCheck;
  baseline: number | null;
  current: number | null;
  allowedWorsening: number;
  message: string;
}

export interface GateResult {
  regressions: Regression[];
  /** Rows measured now that have no baseline entry yet. */
  unbaselined: string[];
  /** Baseline entries whose row is skipped in this report (not compared). */
  skipped: string[];
  /** Measured rows that beat their baseline by more than the tolerance. */
  improvements: string[];
  compared: number;
}

export function allowedWorsening(tolerance: Tolerance, baselineValue: number): number {
  return Math.max(tolerance.abs, tolerance.rel * Math.abs(baselineValue));
}

/** How much worse `current` is than `base` for the direction; negative when it is better. */
export function worsening(direction: Direction, base: number, current: number): number {
  return direction === 'higher' ? base - current : current - base;
}

const MESSAGE_PRECISION = 6;

function show(value: number): string {
  return Number(value.toPrecision(MESSAGE_PRECISION)).toString();
}

function describe(id: string, what: string, direction: Direction, base: number, current: number, allowed: number): string {
  return `${id}: ${what} ${show(current)} is worse than baseline ${show(base)} (${direction} is better, tolerance ${show(allowed)})`;
}

function checkOne(
  regressions: Regression[],
  row: BenchRow,
  entry: BaselineEntry,
  check: RegressionCheck,
  what: string,
  base: number | null,
  current: number | null,
  scale: number | null = base
): void {
  if (base === null) return;
  if (current === null) {
    regressions.push({ id: row.id, check, baseline: base, current, allowedWorsening: 0, message: `${row.id}: ${what} is no longer produced` });
    return;
  }
  const allowed = allowedWorsening(entry.tolerance, scale ?? base);
  if (worsening(entry.direction, base, current) > allowed + GATE_EPSILON) {
    regressions.push({ id: row.id, check, baseline: base, current, allowedWorsening: allowed, message: describe(row.id, what, entry.direction, base, current, allowed) });
  }
}

export interface GateOptions {
  /** Only baseline entries of these families are required to be present (a partial run checks what it ran). */
  families?: ReadonlySet<Family>;
}

export function evaluateGate(report: BenchReport, baseline: Baseline, options: GateOptions = {}): GateResult {
  const regressions: Regression[] = [];
  const unbaselined: string[] = [];
  const skipped: string[] = [];
  const improvements: string[] = [];
  let compared = 0;
  const byId = new Map(report.rows.map((row) => [row.id, row] as const));
  for (const row of report.rows) {
    if (row.status !== 'measured') continue;
    const entry = baseline.entries[row.id];
    if (!entry) {
      unbaselined.push(row.id);
      continue;
    }
    compared++;
    if (entry.ratio !== null) {
      checkOne(regressions, row, entry, 'speed-ratio', 'speed ratio to the reference tool', entry.ratio, row.ratio);
    }
    checkOne(regressions, row, entry, 'baseline', 'our value', entry.ours, row.ours);
    // The tolerance of a delta is scaled by the metric's own magnitude, not by the (often near zero) delta.
    checkOne(regressions, row, entry, 'reference-delta', 'our delta to the reference tool', entry.delta, row.delta, entry.ours);
    if (entry.ours !== null && row.ours !== null) {
      const gain = -worsening(entry.direction, entry.ours, row.ours);
      if (gain > allowedWorsening(entry.tolerance, entry.ours) + GATE_EPSILON) improvements.push(row.id);
    }
  }
  for (const [id, entry] of Object.entries(baseline.entries)) {
    const row = byId.get(id);
    const family = id.split('/')[0] as Family;
    if (options.families && !options.families.has(family)) continue;
    if (!row) {
      regressions.push({ id, check: 'missing', baseline: entry.ours ?? entry.ratio, current: null, allowedWorsening: 0, message: `${id}: baseline metric is missing from the report` });
    } else if (row.status === 'skipped') {
      skipped.push(id);
    }
  }
  return { regressions, unbaselined, skipped, improvements, compared };
}

/**
 * Baseline for `report`. Entries of measured rows are rewritten with the new numbers, keeping a previous
 * entry's tolerance (it may have been tuned by hand); entries of rows that were not measured this time stay as
 * they were, so a run on a machine without some tool cannot erase their baselines.
 */
export function buildBaseline(report: BenchReport, previous: Baseline | null): Baseline {
  const entries: Record<string, BaselineEntry> = { ...(previous?.entries ?? {}) };
  for (const row of report.rows) {
    if (row.status !== 'measured') continue;
    const throughput = row.kind === 'throughput';
    entries[row.id] = {
      direction: row.direction,
      tolerance: previous?.entries[row.id]?.tolerance ?? row.tolerance,
      ours: throughput ? null : row.ours,
      delta: throughput ? null : row.delta,
      ratio: throughput ? row.ratio : null,
    };
  }
  const sorted = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
  return { schemaVersion: SCHEMA_VERSION, entries: sorted };
}

function nullableFinite(value: unknown, path: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ReportSchemaError(`baseline schema: ${path} must be a finite number or null`);
  return value;
}

export function validateBaseline(value: unknown): Baseline {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ReportSchemaError('baseline schema: must be an object');
  const obj = value as Record<string, unknown>;
  if (obj.schemaVersion !== SCHEMA_VERSION) throw new ReportSchemaError(`baseline schema: schemaVersion must be ${SCHEMA_VERSION}`);
  if (typeof obj.entries !== 'object' || obj.entries === null || Array.isArray(obj.entries)) throw new ReportSchemaError('baseline schema: entries must be an object');
  const raw = Object.entries(obj.entries as Record<string, unknown>);
  if (raw.length > MAX_ROWS) throw new ReportSchemaError(`baseline schema: at most ${MAX_ROWS} entries`);
  const entries: Record<string, BaselineEntry> = {};
  for (const [id, item] of raw) {
    const path = `entries.${id}`;
    if (typeof item !== 'object' || item === null) throw new ReportSchemaError(`baseline schema: ${path} must be an object`);
    const entry = item as Record<string, unknown>;
    if (entry.direction !== 'higher' && entry.direction !== 'lower') throw new ReportSchemaError(`baseline schema: ${path}.direction must be "higher" or "lower"`);
    const parsed: BaselineEntry = {
      direction: entry.direction,
      tolerance: validateTolerance(entry.tolerance, `${path}.tolerance`),
      ours: nullableFinite(entry.ours, `${path}.ours`),
      delta: nullableFinite(entry.delta, `${path}.delta`),
      ratio: nullableFinite(entry.ratio, `${path}.ratio`),
    };
    if (parsed.ours === null && parsed.delta === null && parsed.ratio === null) throw new ReportSchemaError(`baseline schema: ${path} gates nothing`);
    entries[id] = parsed;
  }
  return { schemaVersion: SCHEMA_VERSION, entries };
}

export function readBaseline(file: string): Baseline {
  const size = fs.statSync(file).size;
  if (size > MAX_JSON_BYTES) throw new ReportSchemaError(`baseline ${file} is ${size} bytes, over the ${MAX_JSON_BYTES} byte limit`);
  return validateBaseline(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown);
}
