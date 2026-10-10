import { MAX_ROWS, SCHEMA_VERSION } from './speed-config';
import { ReportSchemaError } from './errors';
import { type BenchRow, type Tolerance, fail, finiteNumber, member, record, str, validateRow } from './report-schema';

export * from './report-schema';

/** Report model, schema validation and Markdown rendering. */

export const FAMILIES = ['image', 'video', 'audio', 'ocr', 'document', 'compression', 'pdf-ops'] as const;
export type Family = (typeof FAMILIES)[number];
const FAMILY_SET: ReadonlySet<string> = new Set(FAMILIES);

/** The workflow run a report was measured by; absent from a report measured outside a workflow. */
export interface ReportSource {
  commit: string;
  branch: string;
  event: string;
}

/** The commit, branch and event of the workflow run in `env`, or undefined outside one. A pull request run names its head branch. */
export function reportSource(env: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>): ReportSource | undefined {
  const commit = env.GITHUB_SHA;
  const branch = env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME;
  const event = env.GITHUB_EVENT_NAME;
  if (!commit || !branch || !event) return undefined;
  return { commit, branch, event };
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
  /** Commit, branch and event of the CI run that measured it. */
  source?: ReportSource;
  rows: BenchRow[];
}



function validateSource(value: unknown): ReportSource {
  const source = record(value, 'source');
  return { commit: str(source.commit, 'source.commit'), branch: str(source.branch, 'source.branch'), event: str(source.event, 'source.event') };
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
  const rows = (obj.rows as unknown[]).map((row, index) => validateRow(row, index, FAMILY_SET));
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
    ...(obj.source === undefined ? {} : { source: validateSource(obj.source) }),
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

