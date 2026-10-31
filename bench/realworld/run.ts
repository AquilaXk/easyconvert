/**
 * Real-world corpus runner (`npm run bench:realworld`).
 *
 *   run   --shard I/N [--per-file K] [--workers W] [--deadline-ms D] [--cache DIR] [--out FILE] [--limit L] [--sources A,B]
 *         Fetches this shard's files (digest-checked, cached), converts each through K of its advertised targets in
 *         isolated job servers, and writes the shard report.
 *   merge --out DIR [--update-baseline] REPORT...
 *         Merges every shard report, writes corpus.json and corpus.md, and gates: exit 1 on a crash, hang, bad output
 *         or refusal-rate regression.
 *
 * Exit codes: 0 pass, 1 gate failed, 2 the run itself failed (bad arguments, a fetch or digest failure).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAvailableTargetFormats } from '../../src/lib/registry';
import { ArgumentError, commit, EXIT_ERROR, EXIT_GATE, EXIT_PASS, flag, positiveInt, toolPath } from './cli';
import { judgeJobs } from './judge';
import { readManifest } from './manifest';
import { DEFAULT_PER_FILE, planJobs, shardJobs } from './plan';
import { BASELINE_PATH, buildBaseline, evaluate, type JobRecord, mergeShards, readBaseline, readKnownFailures, readKnownRefusals, readShard, renderMarkdown, REPORT_SCHEMA, type ShardReport } from './report';

const DEFAULT_DEADLINE_MS = 180_000;
const DEFAULT_HEAP_MB = 3072;
const DEFAULT_CACHE = path.join(os.homedir(), '.cache', 'easyconvert-realworld');

async function runShard(args: string[]): Promise<number> {
  const shardArg = flag(args, '--shard') ?? '1/1';
  const match = /^(\d+)\/(\d+)$/.exec(shardArg);
  if (match === null) throw new ArgumentError('--shard must look like 1/8');
  const shard = Number(match[1]) - 1;
  const shards = Number(match[2]);
  const perFile = positiveInt(flag(args, '--per-file'), DEFAULT_PER_FILE, '--per-file');
  const workers = positiveInt(flag(args, '--workers'), Math.max(1, os.cpus().length - 1), '--workers');
  const deadlineMs = positiveInt(flag(args, '--deadline-ms'), DEFAULT_DEADLINE_MS, '--deadline-ms');
  const limit = flag(args, '--limit');
  const sources = flag(args, '--sources')?.split(',');
  const cacheDir = flag(args, '--cache') ?? DEFAULT_CACHE;
  const out = flag(args, '--out') ?? `realworld-shard-${shard + 1}.json`;
  if (args.length > 0) throw new ArgumentError(`unknown arguments: ${args.join(' ')}`);

  const manifest = readManifest();
  const targetsOf = (format: string): string[] => getAvailableTargetFormats(format).map((def) => def.id);
  const wanted = sources === undefined ? manifest.files : manifest.files.filter((file) => sources.includes(file.source));
  let jobs = shardJobs(planJobs(wanted, targetsOf, perFile), shard, shards);
  if (limit !== undefined) jobs = jobs.slice(0, positiveInt(limit, 1, '--limit'));
  const fileCount = new Set(jobs.map((job) => job.file.id)).size;
  console.log(`shard ${shard + 1}/${shards}: ${jobs.length} jobs over ${fileCount} files`);
  const { records } = await judgeJobs(jobs, {
    cacheDir,
    workers,
    deadlineMs,
    heapMb: DEFAULT_HEAP_MB,
    env: { ...process.env, REALWORLD_PDFINFO: toolPath('pdfinfo'), REALWORLD_IDENTIFY: toolPath('identify') },
    batchFiles: Math.max(1, fileCount),
    deleteAfterJudged: false,
    collectFetchErrors: false,
  });
  const report: ShardReport = { schema: REPORT_SCHEMA, shard, shards, commit: commit(), jobs: records };
  fs.writeFileSync(out, JSON.stringify(report));
  console.log(`wrote ${out}`);
  return EXIT_PASS;
}

function runMerge(args: string[]): number {
  const outDir = flag(args, '--out') ?? 'realworld-results';
  const update = args.includes('--update-baseline');
  const reports = args.filter((arg) => arg !== '--update-baseline');
  if (reports.length === 0) throw new ArgumentError('merge needs shard report files');
  const jobs = mergeShards(reports.map(readShard));
  const gate = evaluate(jobs, readBaseline(), readKnownFailures(), readKnownRefusals());
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'corpus.json'), JSON.stringify({ schema: REPORT_SCHEMA, gate, jobs }));
  const markdown = renderMarkdown(jobs, gate);
  fs.writeFileSync(path.join(outDir, 'corpus.md'), markdown);
  console.log(markdown);
  if (update) {
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(buildBaseline(jobs), null, 2)}\n`);
    console.log(`updated ${BASELINE_PATH}`);
  }
  return gate.pass ? EXIT_PASS : EXIT_GATE;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === 'run') return await runShard(rest);
    if (command === 'merge') return runMerge(rest);
    throw new ArgumentError('usage: run --shard I/N ... | merge --out DIR REPORT...');
  } catch (error) {
    console.error(`bench:realworld failed: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_ERROR;
  }
}

void main().then((code) => process.exit(code));
