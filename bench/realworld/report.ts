/**
 * Shard reports of the corpus run, their merge, the gate and the Markdown summary. The gate fails on any crash, hang or
 * bad output, and on a pair whose typed-refusal rate grew past the stored baseline by more than the tolerance.
 */
import fs from 'node:fs';
import path from 'node:path';
import { FATAL_VERDICTS, VERDICT_ORDER, type Verdict } from './verdict';

export const BASELINE_PATH = path.join(__dirname, 'baseline.json');
export const KNOWN_FAILURES_PATH = path.join(__dirname, 'known-failures.json');
export const REPORT_SCHEMA = 1;
/** A pair's refusal rate may grow by this much (absolute) before the gate fails, to absorb a changed file mix. */
export const REFUSAL_RATE_TOLERANCE = 0.02;
/** Pairs with fewer jobs than this are reported but not gated on refusal rate. */
export const MIN_JOBS_FOR_RATE_GATE = 20;
const DETAIL_ROWS = 200;

export interface JobRecord {
  file: string;
  source: string;
  target: string;
  verdict: Verdict;
  ms: number;
  detail?: string;
}

export interface ShardReport {
  schema: number;
  shard: number;
  shards: number;
  commit: string;
  jobs: JobRecord[];
}

export interface PairStats {
  pair: string;
  jobs: number;
  counts: Record<Verdict, number>;
  refusalRate: number;
  p95Ms: number;
}

export interface Baseline {
  schema: number;
  refusalRate: Record<string, number>;
}

/** A tracked defect: matching crashes, hangs or bad outputs are reported but do not fail the gate. */
export interface KnownFailure {
  /** `source->target`, or `*` for any pair. */
  pair: string;
  verdict: Verdict;
  /** Regular expression the job detail must match. */
  detail: string;
  /** The open issue that tracks the fix. */
  issue: number;
}

export interface GateResult {
  pass: boolean;
  fatal: JobRecord[];
  known: { job: JobRecord; issue: number }[];
  refusalRegressions: { pair: string; baseline: number; now: number }[];
}

const emptyCounts = (): Record<Verdict, number> => ({ ok: 0, refused: 0, crash: 0, hang: 0, 'bad-output': 0 });

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
}

export function readShard(file: string): ShardReport {
  const report = JSON.parse(fs.readFileSync(file, 'utf8')) as ShardReport;
  if (report.schema !== REPORT_SCHEMA || !Array.isArray(report.jobs)) throw new Error(`${file}: not a corpus shard report (schema ${REPORT_SCHEMA})`);
  return report;
}

/** All jobs of the shards; refuses shards of different runs or a missing shard. */
export function mergeShards(shards: readonly ShardReport[]): JobRecord[] {
  if (shards.length === 0) throw new Error('no shard reports to merge');
  const total = shards[0].shards;
  const seen = new Set<number>();
  for (const shard of shards) {
    if (shard.shards !== total || shard.commit !== shards[0].commit) throw new Error('shard reports come from different runs');
    seen.add(shard.shard);
  }
  if (seen.size !== total) throw new Error(`got ${seen.size} of ${total} shard reports`);
  return shards.flatMap((shard) => shard.jobs);
}

export function pairStats(jobs: readonly JobRecord[]): PairStats[] {
  const byPair = new Map<string, JobRecord[]>();
  for (const job of jobs) {
    const pair = `${job.source}->${job.target}`;
    const list = byPair.get(pair) ?? [];
    list.push(job);
    byPair.set(pair, list);
  }
  return [...byPair.entries()]
    .map(([pair, list]) => {
      const counts = emptyCounts();
      for (const job of list) counts[job.verdict]++;
      const times = list.map((job) => job.ms).sort((a, b) => a - b);
      return { pair, jobs: list.length, counts, refusalRate: counts.refused / list.length, p95Ms: percentile(times, 0.95) };
    })
    .sort((a, b) => a.pair.localeCompare(b.pair));
}

function knownIssue(job: JobRecord, known: readonly KnownFailure[]): number | null {
  const pair = `${job.source}->${job.target}`;
  const match = known.find((k) => (k.pair === '*' || k.pair === pair) && k.verdict === job.verdict && new RegExp(k.detail).test(job.detail ?? ''));
  return match === undefined ? null : match.issue;
}

function splitFatal(jobs: readonly JobRecord[], knownFailures: readonly KnownFailure[]): Pick<GateResult, 'fatal' | 'known'> {
  const fatal: JobRecord[] = [];
  const known: GateResult['known'] = [];
  for (const job of jobs.filter((j) => FATAL_VERDICTS.has(j.verdict))) {
    const issue = knownIssue(job, knownFailures);
    if (issue === null) fatal.push(job);
    else known.push({ job, issue });
  }
  return { fatal, known };
}

function refusalRegressionsOf(jobs: readonly JobRecord[], baseline: Baseline | null): GateResult['refusalRegressions'] {
  if (baseline === null) return [];
  return pairStats(jobs)
    .filter((stats) => stats.jobs >= MIN_JOBS_FOR_RATE_GATE && baseline.refusalRate[stats.pair] !== undefined)
    .filter((stats) => stats.refusalRate > baseline.refusalRate[stats.pair] + REFUSAL_RATE_TOLERANCE)
    .map((stats) => ({ pair: stats.pair, baseline: baseline.refusalRate[stats.pair], now: stats.refusalRate }));
}

export function evaluate(jobs: readonly JobRecord[], baseline: Baseline | null, knownFailures: readonly KnownFailure[] = []): GateResult {
  const { fatal, known } = splitFatal(jobs, knownFailures);
  const refusalRegressions = refusalRegressionsOf(jobs, baseline);
  return { pass: fatal.length === 0 && refusalRegressions.length === 0, fatal, known, refusalRegressions };
}

export function buildBaseline(jobs: readonly JobRecord[]): Baseline {
  const refusalRate: Record<string, number> = {};
  for (const stats of pairStats(jobs)) refusalRate[stats.pair] = Number(stats.refusalRate.toFixed(4));
  return { schema: REPORT_SCHEMA, refusalRate };
}

export function readKnownFailures(file = KNOWN_FAILURES_PATH): KnownFailure[] {
  if (!fs.existsSync(file)) return [];
  const list = JSON.parse(fs.readFileSync(file, 'utf8')) as KnownFailure[];
  for (const entry of list) {
    if (!Number.isInteger(entry.issue) || entry.issue <= 0) throw new Error(`${file}: every known failure needs the issue that tracks it`);
    if (!FATAL_VERDICTS.has(entry.verdict)) throw new Error(`${file}: verdict ${entry.verdict} is not a failure`);
    // Compiling here refuses a malformed pattern when the list is read, not when the first job is matched.
    entry.detail = new RegExp(entry.detail).source;
  }
  return list;
}

export function readBaseline(file = BASELINE_PATH): Baseline | null {
  if (!fs.existsSync(file)) return null;
  const baseline = JSON.parse(fs.readFileSync(file, 'utf8')) as Baseline;
  if (baseline.schema !== REPORT_SCHEMA) throw new Error(`${file}: baseline schema ${baseline.schema}, expected ${REPORT_SCHEMA}`);
  return baseline;
}

const cell = (text: string): string => text.replace(/\|/g, String.raw`\|`).replace(/\n/g, ' ');

function pairRows(jobs: readonly JobRecord[]): string[] {
  const header = ['| Pair | Jobs | ok | refused | bad-output | crash | hang | p95 ms |', '|---|---|---|---|---|---|---|---|'];
  const rows = pairStats(jobs).map((s) => {
    const cells = [s.pair, s.jobs, s.counts.ok, s.counts.refused, s.counts['bad-output'], s.counts.crash, s.counts.hang, Math.round(s.p95Ms)];
    return `| ${cells.join(' | ')} |`;
  });
  return [...header, ...rows];
}

function fatalRows(fatal: readonly JobRecord[]): string[] {
  if (fatal.length === 0) return [];
  const rows = fatal.slice(0, DETAIL_ROWS).map((job) => `| ${job.file} | ${job.source}->${job.target} | ${job.verdict} | ${cell(job.detail ?? '')} |`);
  const more = fatal.length > DETAIL_ROWS ? ['', `${fatal.length - DETAIL_ROWS} more in the JSON report.`] : [];
  return ['', '## Crashes, hangs and bad outputs', '', '| File | Pair | Verdict | Detail |', '|---|---|---|---|', ...rows, ...more];
}

function knownRows(known: GateResult['known']): string[] {
  if (known.length === 0) return [];
  const byIssue = new Map<number, number>();
  for (const { issue } of known) byIssue.set(issue, (byIssue.get(issue) ?? 0) + 1);
  const rows = [...byIssue.entries()].sort((a, b) => a[0] - b[0]).map(([issue, count]) => `| #${issue} | ${count} |`);
  return ['', '## Known failures (tracked, not gating)', '', '| Issue | Jobs |', '|---|---|', ...rows];
}

function regressionRows(regressions: GateResult['refusalRegressions']): string[] {
  if (regressions.length === 0) return [];
  const rows = regressions.map((r) => `| ${r.pair} | ${r.baseline.toFixed(3)} | ${r.now.toFixed(3)} |`);
  return ['', '## Refusal-rate regressions', '', '| Pair | Baseline | Now |', '|---|---|---|', ...rows];
}

export function renderMarkdown(jobs: readonly JobRecord[], gate: GateResult): string {
  const totals = emptyCounts();
  for (const job of jobs) totals[job.verdict]++;
  const summary = VERDICT_ORDER.map((v) => `${v} ${totals[v]}`).join(', ');
  const verdict = gate.pass ? 'pass' : 'fail';
  const lines = [
    '# Real-world corpus run',
    '',
    `Gate: **${verdict}**. Jobs: ${jobs.length}. ${summary}.`,
    '',
    ...pairRows(jobs),
    ...fatalRows(gate.fatal),
    ...knownRows(gate.known),
    ...regressionRows(gate.refusalRegressions),
  ];
  return `${lines.join('\n')}\n`;
}
