/**
 * Regression corpus runner (`npm run bench:regression`).
 *
 *   run   --mode full|nightly --shard I/N [--date YYYY-MM-DD] [--per-file K] [--workers W] [--deadline-ms D] [--cache DIR]
 *         [--out FILE] [--limit L] [--batch-files B]
 *         --limit keeps L jobs of the shard, evenly spread, for a trial run.
 *         Plans the jobs of the whole corpus, keeps those of this mode (every file, or the night's seventh and the canary),
 *         takes this shard's share, fetches each batch of files by range requests, judges it and deletes the files again.
 *   merge --out DIR [--previous FILE] [--record-failures] REPORT...
 *         Merges the shard reports, compares them with the result set of the last full run, writes corpus.json and corpus.md,
 *         and exits 1 on a crash, hang, bad output, a file that converted before and does not now, or an unfetchable file.
 *   stats Prints the composition of the corpus.
 *
 * Exit codes: 0 pass, 1 gate failed, 2 the run itself failed (bad arguments, an unreadable manifest or report).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAvailableTargetFormats } from '../../../src/lib/registry';
import { ArgumentError, commit, EXIT_ERROR, EXIT_GATE, EXIT_PASS, flag, positiveInt, toolPath } from '../cli';
import { judgeJobs } from '../judge';
import { shardJobs } from '../plan';
import { REPORT_SCHEMA } from '../report';
import { FAILED_BEFORE_PATH, mergeRegression, readFailedBefore, readPreviousResults, readRegressionShard, type RegressionShardReport, withRecordedFailures, writeFailedBefore } from './merge';
import { readRegressionManifest } from './manifest';
import { planRegressionJobs, type RunMode, selectForMode, SHARDS, thinJobs } from './schedule';
import { renderCorpusStats } from './stats';

const DEFAULT_PER_FILE = 1;
const DEFAULT_DEADLINE_MS = 180_000;
const DEFAULT_HEAP_MB = 3072;
const DEFAULT_BATCH_FILES = 200;
const DEFAULT_CACHE = path.join(os.tmpdir(), 'easyconvert-regression-corpus');

function modeOf(value: string | undefined): RunMode {
  if (value === 'full' || value === 'nightly') return value;
  throw new ArgumentError('--mode must be full or nightly');
}

function shardOf(value: string | undefined): { shard: number; shards: number } {
  const match = /^(\d+)\/(\d+)$/.exec(value ?? '1/1');
  if (match === null) throw new ArgumentError('--shard must look like 1/12');
  return { shard: Number(match[1]) - 1, shards: Number(match[2]) };
}

async function runShard(args: string[]): Promise<number> {
  const mode = modeOf(flag(args, '--mode'));
  const { shard, shards } = shardOf(flag(args, '--shard'));
  const date = flag(args, '--date') ?? new Date().toISOString().slice(0, 10);
  const perFile = positiveInt(flag(args, '--per-file'), DEFAULT_PER_FILE, '--per-file');
  const workers = positiveInt(flag(args, '--workers'), Math.max(1, os.cpus().length - 1), '--workers');
  const deadlineMs = positiveInt(flag(args, '--deadline-ms'), DEFAULT_DEADLINE_MS, '--deadline-ms');
  const batchFiles = positiveInt(flag(args, '--batch-files'), DEFAULT_BATCH_FILES, '--batch-files');
  const limit = flag(args, '--limit');
  const cacheDir = flag(args, '--cache') ?? DEFAULT_CACHE;
  const out = flag(args, '--out') ?? `regression-shard-${shard + 1}.json`;
  if (args.length > 0) throw new ArgumentError(`unknown arguments: ${args.join(' ')}`);

  const manifest = readRegressionManifest();
  const targetsOf = (format: string): string[] => getAvailableTargetFormats(format).map((def) => def.id);
  const selected = new Set(selectForMode(mode, manifest.files, date, new Set(readFailedBefore())).map((file) => file.id));
  const planned = planRegressionJobs(manifest.files, targetsOf, perFile).filter((job) => selected.has(job.file.id));
  const shardShare = shardJobs(planned, shard, shards);
  const jobs = limit === undefined ? shardShare : thinJobs(shardShare, positiveInt(limit, 1, '--limit'));
  console.log(`${mode} run of ${date}, shard ${shard + 1}/${shards}: ${jobs.length} jobs over ${new Set(jobs.map((job) => job.file.id)).size} files`);

  const started = performance.now();
  const { records, unavailable } = await judgeJobs(jobs, {
    cacheDir,
    workers,
    deadlineMs,
    heapMb: DEFAULT_HEAP_MB,
    env: { ...process.env, REALWORLD_PDFINFO: toolPath('pdfinfo'), REALWORLD_IDENTIFY: toolPath('identify') },
    batchFiles,
    deleteAfterJudged: true,
    collectFetchErrors: true,
  });
  const report: RegressionShardReport = { schema: REPORT_SCHEMA, shard, shards, commit: commit(), jobs: records, mode, date, unavailable, elapsedMs: Math.round(performance.now() - started) };
  fs.writeFileSync(out, JSON.stringify(report));
  console.log(`wrote ${out}: ${records.length} jobs, ${unavailable.length} unavailable files`);
  return EXIT_PASS;
}

function runMerge(args: string[]): number {
  const outDir = flag(args, '--out') ?? 'regression-results';
  const previousFile = flag(args, '--previous');
  const record = args.includes('--record-failures');
  const reports = args.filter((arg) => arg !== '--record-failures');
  if (reports.length === 0) throw new ArgumentError('merge needs shard report files');
  const manifest = readRegressionManifest();
  const previous = previousFile === undefined ? null : readPreviousResults(previousFile);
  const merged = mergeRegression(reports.map(readRegressionShard), previous, new Map(manifest.files.map((file) => [file.id, file])));
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'corpus.json'), JSON.stringify(merged.results));
  fs.writeFileSync(path.join(outDir, 'corpus.md'), merged.markdown);
  console.log(merged.markdown);
  if (record) {
    writeFailedBefore(withRecordedFailures(readFailedBefore(), merged.results.gate));
    console.log(`updated ${FAILED_BEFORE_PATH}`);
  }
  return merged.pass ? EXIT_PASS : EXIT_GATE;
}

function runStats(): number {
  console.log(renderCorpusStats(readRegressionManifest().files));
  console.log(`Shards: full ${SHARDS.full}, nightly ${SHARDS.nightly}`);
  return EXIT_PASS;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === 'run') return await runShard(rest);
    if (command === 'merge') return runMerge(rest);
    if (command === 'stats') return runStats();
    throw new ArgumentError('usage: run --mode M --shard I/N ... | merge --out DIR REPORT... | stats');
  } catch (error) {
    console.error(`bench:regression failed: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_ERROR;
  }
}

void main().then((code) => process.exit(code));
