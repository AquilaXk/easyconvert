import fs from 'node:fs';
import { MAX_GAP_ENTRIES, MAX_JSON_BYTES, PARITY_SCHEMA_VERSION, SPEED_HISTORY_MAX_POINTS } from './config';
import { ReportSchemaError } from './errors';
import type { SpeedHistoryPoint } from './speed-history';

/**
 * Rows that are below the reference tool today, each with the issue that tracks it.
 *
 * Quality rows are never excused: an entry only names the issue in the failure message and in the security-exemption
 * comment, and the row still fails.
 *
 * A speed (throughput) row listed here is "tracked": being below the reference does not fail it, but getting slower
 * than its history does (the upper bound of its speed-ratio interval below the lower edge of the one-sided prediction
 * bound over the `history` of CI-measured ratios, bench/speed-history.ts; with too few points it is only reported),
 * and a tracked row that reaches parity is reported so its entry can be removed. A speed row that is not listed has to
 * pass the parity rule outright.
 */

export interface GapEntry {
  /** Row id `<family>/<case>/<metric>`. */
  id: string;
  /** The issue that tracks the gap; every entry has one. */
  issue: number;
  /** Speed rows: the latest recorded speed ratio (reference time / our time), for display. Quality rows: null. */
  ratio: number | null;
  note: string;
  /** Speed rows: the median ratios of the latest CI runs, oldest first, written by `bench:refresh-speed` only. */
  history?: SpeedHistoryPoint[];
}

const THROUGHPUT_SUFFIX = '/throughput';
export const isSpeedRowId = (id: string): boolean => id.endsWith(THROUGHPUT_SUFFIX);

export interface GapFile {
  schemaVersion: number;
  gaps: GapEntry[];
}

const ROW_ID_PATTERN = /^[a-z][a-z-]*\/[^/]+\/[a-z0-9_]+$/;

const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/;

const RUN_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function validateHistory(value: unknown, path: string): SpeedHistoryPoint[] {
  if (!Array.isArray(value)) throw new ReportSchemaError(`parity gaps: ${path} must be an array`);
  if (value.length > SPEED_HISTORY_MAX_POINTS) throw new ReportSchemaError(`parity gaps: ${path} holds at most ${SPEED_HISTORY_MAX_POINTS} points`);
  const points = (value as unknown[]).map((item, index): SpeedHistoryPoint => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new ReportSchemaError(`parity gaps: ${path}[${index}] must be an object`);
    const point = item as Record<string, unknown>;
    if (typeof point.ratio !== 'number' || !Number.isFinite(point.ratio) || point.ratio <= 0) throw new ReportSchemaError(`parity gaps: ${path}[${index}].ratio must be a positive speed ratio`);
    if (typeof point.at !== 'string' || !RUN_TIME_PATTERN.test(point.at)) throw new ReportSchemaError(`parity gaps: ${path}[${index}].at must be the UTC time of the run, like 2026-10-09T02:00:00.000Z`);
    if (point.commit === undefined) return { ratio: point.ratio, at: point.at };
    if (typeof point.commit !== 'string' || !COMMIT_PATTERN.test(point.commit)) throw new ReportSchemaError(`parity gaps: ${path}[${index}].commit must be the hexadecimal sha of the commit the run measured`);
    return { ratio: point.ratio, at: point.at, commit: point.commit };
  });
  for (let index = 1; index < points.length; index++) {
    if (points[index - 1].at >= points[index].at) throw new ReportSchemaError(`parity gaps: ${path} must be ordered by run time, oldest first, one point per run`);
  }
  return points;
}

export function validateGaps(value: unknown): GapFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ReportSchemaError('parity gaps: must be an object');
  const obj = value as Record<string, unknown>;
  if (obj.schemaVersion !== PARITY_SCHEMA_VERSION) throw new ReportSchemaError(`parity gaps: schemaVersion must be ${PARITY_SCHEMA_VERSION}`);
  if (!Array.isArray(obj.gaps)) throw new ReportSchemaError('parity gaps: gaps must be an array');
  if (obj.gaps.length > MAX_GAP_ENTRIES) throw new ReportSchemaError(`parity gaps: at most ${MAX_GAP_ENTRIES} entries`);
  const seen = new Set<string>();
  const gaps = (obj.gaps as unknown[]).map((item, index): GapEntry => {
    const path = `gaps[${index}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new ReportSchemaError(`parity gaps: ${path} must be an object`);
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== 'string' || !ROW_ID_PATTERN.test(entry.id)) throw new ReportSchemaError(`parity gaps: ${path}.id must be <family>/<case>/<metric>`);
    if (seen.has(entry.id)) throw new ReportSchemaError(`parity gaps: ${entry.id} is listed twice`);
    seen.add(entry.id);
    const issue = entry.issue;
    if (typeof issue !== 'number' || !Number.isInteger(issue) || issue < 1) {
      throw new ReportSchemaError(`parity gaps: ${path}.issue must be a positive integer; every gap names the issue that tracks it`);
    }
    const ratio = entry.ratio;
    if (isSpeedRowId(entry.id)) {
      if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0) throw new ReportSchemaError(`parity gaps: ${path}.ratio must be a positive speed ratio for the speed row ${entry.id}`);
    } else if (ratio !== null) {
      throw new ReportSchemaError(`parity gaps: ${path}.ratio must be null for the quality row ${entry.id}, which a gap never excuses`);
    }
    if (typeof entry.note !== 'string' || entry.note === '') throw new ReportSchemaError(`parity gaps: ${path}.note must be a non-empty string`);
    const parsed: GapEntry = { id: entry.id, issue, ratio: ratio as number | null, note: entry.note };
    if (entry.history !== undefined) {
      if (!isSpeedRowId(entry.id)) throw new ReportSchemaError(`parity gaps: ${path}.history is only for speed rows, and ${entry.id} is a quality row`);
      parsed.history = validateHistory(entry.history, `${path}.history`);
    }
    return parsed;
  });
  return { schemaVersion: PARITY_SCHEMA_VERSION, gaps };
}

export function readGaps(file: string): GapFile {
  const size = fs.statSync(file).size;
  if (size > MAX_JSON_BYTES) throw new ReportSchemaError(`parity gaps ${file} is ${size} bytes, over the ${MAX_JSON_BYTES} byte limit`);
  return validateGaps(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown);
}

export function gapIndex(file: GapFile): ReadonlyMap<string, GapEntry> {
  return new Map(file.gaps.map((gap) => [gap.id, gap] as const));
}

/** How a gap reads in a message: the issue that tracks it, or the fact that none is filed. */
export function describeGap(gap: GapEntry | undefined): string {
  if (!gap) return 'not a known gap: bring it to parity, or file a gap issue and list the row in bench/parity-gaps.json';
  return `known gap, issue #${gap.issue}: ${gap.note}`;
}
