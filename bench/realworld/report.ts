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

export function evaluate(jobs: readonly JobRecord[], baseline: Baseline | null, knownFailures: readonly KnownFailure[] = []): GateResult {
  const fatal: JobRecord[] = [];
  const known: GateResult['known'] = [];
  for (const job of jobs) {
    if (!FATAL_VERDICTS.has(job.verdict)) continue;
    const issue = knownIssue(job, knownFailures);
    if (issue === null) fatal.push(job);
    else known.push({ job, issue });
  }
  const refusalRegressions: GateResult['refusalRegressions'] = [];
  if (baseline !== null) {
    for (const stats of pairStats(jobs)) {
      const before = baseline.refusalRate[stats.pair];
      if (before === undefined || stats.jobs < MIN_JOBS_FOR_RATE_GATE) continue;
      if (stats.refusalRate > before + REFUSAL_RATE_TOLERANCE) refusalRegressions.push({ pair: stats.pair, baseline: before, now: stats.refusalRate });
    }
  }
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
    new RegExp(entry.detail);
  }
  return list;
}

export function readBaseline(file = BASELINE_PATH): Baseline | null {
  if (!fs.existsSync(file)) return null;
  const baseline = JSON.parse(fs.readFileSync(file, 'utf8')) as Baseline;
  if (baseline.schema !== REPORT_SCHEMA) throw new Error(`${file}: baseline schema ${baseline.schema}, expected ${REPORT_SCHEMA}`);
  return baseline;
}

const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderMarkdown(jobs: readonly JobRecord[], gate: GateResult): string {
  const lines: string[] = ['# Real-world corpus run', ''];
  const totals = emptyCounts();
  for (const job of jobs) totals[job.verdict]++;
  lines.push(`Gate: **${gate.pass ? 'pass' : 'fail'}**. Jobs: ${jobs.length}. ${VERDICT_ORDER.map((v) => `${v} ${totals[v]}`).join(', ')}.`, '');
  lines.push('| Pair | Jobs | ok | refused | bad-output | crash | hang | p95 ms |', '|---|---|---|---|---|---|---|---|');
  for (const s of pairStats(jobs)) {
    lines.push(`| ${s.pair} | ${s.jobs} | ${s.counts.ok} | ${s.counts.refused} | ${s.counts['bad-output']} | ${s.counts.crash} | ${s.counts.hang} | ${Math.round(s.p95Ms)} |`);
  }
  if (gate.fatal.length > 0) {
    lines.push('', '## Crashes, hangs and bad outputs', '', '| File | Pair | Verdict | Detail |', '|---|---|---|---|');
    for (const job of gate.fatal.slice(0, DETAIL_ROWS)) lines.push(`| ${job.file} | ${job.source}->${job.target} | ${job.verdict} | ${cell(job.detail ?? '')} |`);
    if (gate.fatal.length > DETAIL_ROWS) lines.push('', `${gate.fatal.length - DETAIL_ROWS} more in the JSON report.`);
  }
  if (gate.known.length > 0) {
    const byIssue = new Map<number, number>();
    for (const { issue } of gate.known) byIssue.set(issue, (byIssue.get(issue) ?? 0) + 1);
    lines.push('', '## Known failures (tracked, not gating)', '', '| Issue | Jobs |', '|---|---|');
    for (const [issue, count] of [...byIssue.entries()].sort((a, b) => a[0] - b[0])) lines.push(`| #${issue} | ${count} |`);
  }
  if (gate.refusalRegressions.length > 0) {
    lines.push('', '## Refusal-rate regressions', '', '| Pair | Baseline | Now |', '|---|---|---|');
    for (const r of gate.refusalRegressions) lines.push(`| ${r.pair} | ${r.baseline.toFixed(3)} | ${r.now.toFixed(3)} |`);
  }
  return `${lines.join('\n')}\n`;
}
