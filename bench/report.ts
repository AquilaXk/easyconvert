import { MAX_ROWS, SCHEMA_VERSION } from './config';

/** Relative slack when checking that a row's delta equals ours - reference after a JSON round trip. */
const DELTA_CONSISTENCY_EPSILON = 1e-6;
import { ReportSchemaError } from './errors';

/** Report model, schema validation and Markdown rendering. */

export const FAMILIES = ['image', 'video', 'audio', 'ocr', 'document', 'compression'] as const;
export type Family = (typeof FAMILIES)[number];
const FAMILY_SET: ReadonlySet<string> = new Set(FAMILIES);

export type Direction = 'higher' | 'lower';
const DIRECTION_SET: ReadonlySet<string> = new Set(['higher', 'lower']);

/** quality: a measured score; size: bytes or bit rate; bdrate: Bjontegaard delta; throughput: speed, gated by ratio; exact: 1 when a lossless check holds. */
export const ROW_KINDS = ['quality', 'size', 'bdrate', 'throughput', 'exact'] as const;
export type RowKind = (typeof ROW_KINDS)[number];
const ROW_KIND_SET: ReadonlySet<string> = new Set(ROW_KINDS);

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
  skipKind?: SkipKind;
  skipReason?: string;
}

export interface BenchReport {
  schemaVersion: number;
  generatedAt: string;
  strictMode: boolean;
  families: Family[];
  host: { platform: string; arch: string; node: string; cpus: number };
  /** Version line of each reference tool, or null when it is not installed. */
  tools: Record<string, string | null>;
  settings: { runs: number; injectedRegression: string | null };
  rows: BenchRow[];
}

function fail(path: string, expectation: string): never {
  throw new ReportSchemaError(`report schema: ${path} must be ${expectation}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'an object');
  return value as Record<string, unknown>;
}

function str(value: unknown, path: string): string {
  if (typeof value !== 'string' || value === '') fail(path, 'a non-empty string');
  return value as string;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'a finite number');
  return value as number;
}

function nullableNumber(value: unknown, path: string): number | null {
  return value === null ? null : finiteNumber(value, path);
}

function member<T extends string>(value: unknown, set: ReadonlySet<string>, path: string): T {
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

function validateRow(value: unknown, index: number): BenchRow {
  const path = `rows[${index}]`;
  const row = record(value, path);
  const id = str(row.id, `${path}.id`);
  const family = member<Family>(row.family, FAMILY_SET, `${path}.family`);
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
  for (const key of ['oursCv', 'referenceCv', 'runs'] as const) {
    if (row[key] !== undefined) parsed[key] = finiteNumber(row[key], `${path}.${key}`);
  }
  return parsed;
}

/** Validates an unknown JSON value as a report; throws ReportSchemaError naming the offending path. */
export function validateReport(value: unknown): BenchReport {
  const obj = record(value, 'report');
  if (obj.schemaVersion !== SCHEMA_VERSION) fail('schemaVersion', `${SCHEMA_VERSION}`);
  if (typeof obj.strictMode !== 'boolean') fail('strictMode', 'a boolean');
  if (!Array.isArray(obj.families)) fail('families', 'an array');
  if (!Array.isArray(obj.rows)) fail('rows', 'an array');
  if (obj.rows.length > MAX_ROWS) fail('rows', `at most ${MAX_ROWS} rows`);
  const host = record(obj.host, 'host');
  const tools = record(obj.tools, 'tools');
  const settings = record(obj.settings, 'settings');
  const toolVersions: Record<string, string | null> = {};
  for (const [name, version] of Object.entries(tools)) {
    if (version !== null && typeof version !== 'string') fail(`tools.${name}`, 'a string or null');
    toolVersions[name] = version as string | null;
  }
  const rows = (obj.rows as unknown[]).map((row, index) => validateRow(row, index));
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) fail('rows', `unique, but ${row.id} repeats`);
    seen.add(row.id);
  }
  const injected = settings.injectedRegression;
  if (injected !== null && typeof injected !== 'string') fail('settings.injectedRegression', 'a string or null');
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: str(obj.generatedAt, 'generatedAt'),
    strictMode: obj.strictMode,
    families: (obj.families as unknown[]).map((f, i) => member<Family>(f, FAMILY_SET, `families[${i}]`)),
    host: {
      platform: str(host.platform, 'host.platform'),
      arch: str(host.arch, 'host.arch'),
      node: str(host.node, 'host.node'),
      cpus: finiteNumber(host.cpus, 'host.cpus'),
    },
    tools: toolVersions,
    settings: { runs: finiteNumber(settings.runs, 'settings.runs'), injectedRegression: injected as string | null },
    rows,
  };
}

const SIGNIFICANT_DIGITS = 5;

function fmt(value: number | null): string {
  if (value === null) return '-';
  if (value === 0) return '0';
  return Number(value.toPrecision(SIGNIFICANT_DIGITS)).toString();
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** Markdown summary: one table per family with our value, the reference value and the delta, then the skipped rows. */
export function renderMarkdown(report: BenchReport): string {
  const lines: string[] = [];
  lines.push('# Quality benchmark');
  lines.push('');
  lines.push(`Generated ${report.generatedAt} on ${report.host.platform}/${report.host.arch}, node ${report.host.node}, ${report.host.cpus} CPUs, ${report.settings.runs} timing runs per throughput row.`);
  if (report.settings.injectedRegression) lines.push(`Injected regression: ${report.settings.injectedRegression}.`);
  lines.push('');
  const toolLines = Object.entries(report.tools).map(([name, version]) => `${name}: ${version ?? 'not installed'}`);
  lines.push(`Reference tools: ${toolLines.join('; ')}`);
  for (const family of report.families) {
    const rows = report.rows.filter((row) => row.family === family && row.status === 'measured');
    lines.push('');
    lines.push(`## ${family}`);
    lines.push('');
    lines.push('| Case | Metric | Unit | Better | Ours | Reference | Delta | Ratio | Reference tool | CV ours/ref |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const row of rows) {
      const cv = row.oursCv === undefined ? '-' : `${fmt(row.oursCv)} / ${fmt(row.referenceCv ?? null)}`;
      lines.push(
        `| ${escapeCell(row.case)} | ${row.metric} | ${row.unit} | ${row.direction} | ${fmt(row.ours)} | ${fmt(row.reference)} | ${fmt(row.delta)} | ${fmt(row.ratio)} | ${row.referenceTool} | ${cv} |`
      );
    }
  }
  const skipped = report.rows.filter((row) => row.status === 'skipped');
  lines.push('');
  lines.push(`## Skipped rows (${skipped.length})`);
  lines.push('');
  if (skipped.length === 0) {
    lines.push('None.');
  } else {
    lines.push('| Row | Kind | Reason |');
    lines.push('|---|---|---|');
    for (const row of skipped) lines.push(`| ${escapeCell(row.id)} | ${row.skipKind} | ${escapeCell(row.skipReason ?? '')} |`);
  }
  lines.push('');
  return lines.join('\n');
}
