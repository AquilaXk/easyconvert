import fs from 'node:fs';
import { MAX_GAP_ENTRIES, MAX_JSON_BYTES, PARITY_SCHEMA_VERSION } from './config';
import { ReportSchemaError } from './errors';

/**
 * Rows that are below the reference tool today, each with the issue that tracks it. The file names an existing gap in
 * a failure message and in the security-exemption comment; it never excuses a row. A pull request that touches a
 * family must bring every row of that family to parity, whether or not the row is listed here.
 */

export interface GapEntry {
  /** Row id `<family>/<case>/<metric>`. */
  id: string;
  /** The issue that tracks the gap, or null when none is filed yet (the failure message then says so). */
  issue: number | null;
  note: string;
}

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
    if (issue !== null && (typeof issue !== 'number' || !Number.isInteger(issue) || issue < 1)) {
      throw new ReportSchemaError(`parity gaps: ${path}.issue must be a positive integer or null`);
    }
    if (typeof entry.note !== 'string' || entry.note === '') throw new ReportSchemaError(`parity gaps: ${path}.note must be a non-empty string`);
    return { id: entry.id, issue: issue as number | null, note: entry.note };
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
  return gap.issue === null ? `known gap, no issue filed yet: ${gap.note}` : `known gap, issue #${gap.issue}: ${gap.note}`;
}
