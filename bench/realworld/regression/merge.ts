/**
 * Merging the shard reports of a regression corpus run: the shared shard merge, the gate with the differential against an earlier
 * full run, files that could not be fetched, and the maintained list of files that failed before.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { CorpusFile } from '../manifest';
import type { UnavailableFile } from '../judge';
import { type GateResult, type JobRecord, mergeShards, readKnownFailures, readShard, REPORT_SCHEMA, type ShardReport } from '../report';
import { evaluateRegression, type RegressionGate } from './differential';
import type { RunMode } from './schedule';
import { renderRegressionMarkdown } from './summary';

export const REGRESSION_KNOWN_FAILURES_PATH = path.join(__dirname, 'known-failures.json');
export const FAILED_BEFORE_PATH = path.join(__dirname, 'failed-before.json');
const MILLISECONDS_PER_SECOND = 1000;

/** A shard report with what only the regression run records. */
export interface RegressionShardReport extends ShardReport {
  mode: RunMode;
  date: string;
  /** Files of the shard that could not be fetched or whose bytes differ from the manifest. */
  unavailable: UnavailableFile[];
  elapsedMs: number;
}

/** The merged result set, kept as the artifact the next run compares with. */
export interface RegressionResults {
  schema: number;
  commit: string;
  mode: RunMode;
  date: string;
  gate: RegressionGate;
  unavailable: UnavailableFile[];
  jobs: JobRecord[];
}

export interface MergedRun {
  results: RegressionResults;
  markdown: string;
  pass: boolean;
}

/** A shard report of the regression run: the shared report with the fields this run adds. */
export function readRegressionShard(file: string): RegressionShardReport {
  const report = readShard(file) as RegressionShardReport;
  if ((report.mode !== 'full' && report.mode !== 'nightly') || !Array.isArray(report.unavailable) || typeof report.elapsedMs !== 'number') throw new Error(`${file}: not a regression corpus shard report`);
  return report;
}

/** The earlier result set must come from a full run: a nightly one covers a seventh of the corpus and would hide the rest. */
export function readPreviousResults(file: string): RegressionResults | null {
  if (!fs.existsSync(file)) return null;
  const previous = JSON.parse(fs.readFileSync(file, 'utf8')) as RegressionResults;
  if (previous.schema !== REPORT_SCHEMA || previous.mode !== 'full') throw new Error(`${file}: not the result set of a full regression run`);
  return previous;
}

export function mergeRegression(
  reports: readonly RegressionShardReport[],
  previous: RegressionResults | null,
  files: ReadonlyMap<string, CorpusFile>,
  knownFailures = readKnownFailures(REGRESSION_KNOWN_FAILURES_PATH)
): MergedRun {
  const jobs = mergeShards(reports);
  const { mode, date } = reports[0];
  const unavailable = reports.flatMap((report) => report.unavailable);
  const gate = evaluateRegression(jobs, previous?.jobs ?? null, knownFailures, unavailable);
  const results: RegressionResults = { schema: REPORT_SCHEMA, commit: reports[0].commit, mode, date, gate, unavailable, jobs };
  const ordered = [...reports].sort((a, b) => a.shard - b.shard);
  const markdown = renderRegressionMarkdown(jobs, gate, { files, previousCommit: previous?.commit ?? null, shardSeconds: ordered.map((report) => report.elapsedMs / MILLISECONDS_PER_SECOND) });
  return { results, markdown, pass: gate.pass };
}

/** The maintained list with the files of this run's failures added: untracked and tracked failures and regressions alike, sorted, once each. */
export function withRecordedFailures(existing: readonly string[], gate: GateResult & Pick<RegressionGate, 'regressions' | 'knownRegressions'>): string[] {
  const failed = [...gate.fatal.map((job) => job.file), ...gate.known.map(({ job }) => job.file), ...gate.regressions.map((r) => r.file), ...gate.knownRegressions.map(({ regression }) => regression.file)];
  return [...new Set([...existing, ...failed])].sort((a, b) => (a < b ? -1 : 1));
}

export function readFailedBefore(file = FAILED_BEFORE_PATH): string[] {
  const list = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  if (!Array.isArray(list) || list.some((entry) => typeof entry !== 'string')) throw new Error(`${file}: expected a list of corpus file ids`);
  return list as string[];
}

export function writeFailedBefore(ids: readonly string[], file = FAILED_BEFORE_PATH): void {
  fs.writeFileSync(file, `${JSON.stringify(ids, null, 2)}\n`);
}
