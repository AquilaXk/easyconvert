import fs from 'node:fs';
import { MAX_GAP_ENTRIES, MAX_JSON_BYTES, PARITY_SCHEMA_VERSION } from './config';
import { ReportSchemaError } from './errors';

/**
 * Rows that are below the reference tool today, each with the issue that tracks it.
 *
 * Quality rows are never excused: an entry only names the issue in the failure message and in the security-exemption
 * comment, and the row still fails.
 *
 * A speed (throughput) row listed here is "tracked": being below the reference does not fail it, but getting slower
 * than the recorded `ratio` does (the upper bound of its speed-ratio interval below ratio * (1 - tolerance)), and a
 * tracked row that reaches parity is reported so its entry can be removed. A speed row that is not listed has to pass
 * the parity rule outright.
 */

export interface GapEntry {
  /** Row id `<family>/<case>/<metric>`. */
  id: string;
  /** The issue that tracks the gap; every entry has one. */
  issue: number;
  /** Speed rows: the speed ratio (reference time / our time) the row had when the gap was recorded. Quality rows: null. */
  ratio: number | null;
  note: string;
}

const THROUGHPUT_SUFFIX = '/throughput';
export const isSpeedRowId = (id: string): boolean => id.endsWith(THROUGHPUT_SUFFIX);

export interface GapFile {
  schemaVersion: number;
  gaps: GapEntry[];
}

const ROW_ID_PATTERN = /^[a-z]+\/[^/]+\/[a-z0-9_]+$/;

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
    return { id: entry.id, issue, ratio: ratio as number | null, note: entry.note };
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
