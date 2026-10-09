/**
 * Real-world corpus runner (`npm run bench:realworld`).
 *
 *   run   --shard I/N [--per-file K] [--workers W] [--deadline-ms D] [--cache DIR] [--out FILE] [--limit L]
 *         Fetches this shard's files (digest-checked, cached), converts each through K of its advertised targets in
 *         isolated job servers, and writes the shard report.
 *   merge --out DIR [--update-baseline] REPORT...
 *         Merges every shard report, writes corpus.json and corpus.md, and gates: exit 1 on a crash, hang, bad output
 *         or refusal-rate regression.
 *
 * Exit codes: 0 pass, 1 gate failed, 2 the run itself failed (bad arguments, a fetch or digest failure).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAvailableTargetFormats } from '../../src/lib/registry';
import { ensureCached, mapLimit } from './fetch';
import { readManifest } from './manifest';
import { planJobs, shardJobs } from './plan';
import { ocrPageCount } from './ocr-path';
import { JobPool, scaledDeadlineMs } from './pool';
import { BASELINE_PATH, buildBaseline, evaluate, type JobRecord, mergeShards, readBaseline, readKnownFailures, readShard, renderMarkdown, REPORT_SCHEMA, type ShardReport } from './report';

const EXIT_PASS = 0;
const EXIT_GATE = 1;
const EXIT_ERROR = 2;
const DEFAULT_PER_FILE = 3;
const DEFAULT_DEADLINE_MS = 180_000;
const DEFAULT_HEAP_MB = 3072;
const FETCH_CONCURRENCY = 8;
const PROGRESS_EVERY = 100;
const DEFAULT_CACHE = path.join(os.homedir(), '.cache', 'easyconvert-realworld');

class ArgumentError extends Error {}

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith('--')) throw new ArgumentError(`${name} needs a value`);
  args.splice(at, 2);
  return value;
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new ArgumentError(`${name} must be a positive integer`);
  return parsed;
}

/** Fixed system directories searched for tools; PATH is not trusted, so a writable directory on it cannot supply one. */
const TOOL_DIRECTORIES = ['/usr/bin', '/usr/local/bin', '/bin'] as const;

function toolPath(name: string): string {
  const found = TOOL_DIRECTORIES.map((dir) => path.join(dir, name)).find((candidate) => fs.existsSync(candidate));
  return found ?? '';
}

function commit(): string {
  const git = toolPath('git');
  if (git === '') return process.env.GITHUB_SHA ?? 'unknown';
  try {
    return execFileSync(git, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return process.env.GITHUB_SHA ?? 'unknown';
  }
}

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
  const cacheDir = flag(args, '--cache') ?? DEFAULT_CACHE;
  const out = flag(args, '--out') ?? `realworld-shard-${shard + 1}.json`;
  if (args.length > 0) throw new ArgumentError(`unknown arguments: ${args.join(' ')}`);

  const manifest = readManifest();
  const targetsOf = (format: string): string[] => getAvailableTargetFormats(format).map((def) => def.id);
  let jobs = shardJobs(planJobs(manifest.files, targetsOf, perFile), shard, shards);
  if (limit !== undefined) jobs = jobs.slice(0, positiveInt(limit, 1, '--limit'));
  const files = [...new Map(jobs.map((job) => [job.file.id, job.file])).values()];
  console.log(`shard ${shard + 1}/${shards}: ${jobs.length} jobs over ${files.length} files`);
  const paths = new Map<string, string>();
  await mapLimit(files, FETCH_CONCURRENCY, async (file) => paths.set(file.id, await ensureCached(file, cacheDir)));

  const pool = await JobPool.start({
    workers,
    deadlineMs,
    heapMb: DEFAULT_HEAP_MB,
    env: { ...process.env, REALWORLD_PDFINFO: toolPath('pdfinfo'), REALWORLD_IDENTIFY: toolPath('identify') },
  });
  let done = 0;
  const pages = new Map<string, number>();
  for (const file of files.filter((candidate) => candidate.format === 'pdf')) pages.set(file.id, await ocrPageCount(fs.readFileSync(paths.get(file.id)!)));
  const outcomes = await pool
    .runAll(
      jobs.map((job) => ({
        path: paths.get(job.file.id)!,
        name: `${job.file.id}`,
        format: job.file.format,
        target: job.target,
        deadlineMs: scaledDeadlineMs(deadlineMs, pages.get(job.file.id) ?? 0),
      })),
      () => {
        done++;
        if (done % PROGRESS_EVERY === 0) console.log(`  ${done}/${jobs.length}`);
      }
    )
    .finally(() => pool.stop());
  const records: JobRecord[] = jobs.map((job, index) => ({
    file: job.file.id,
    source: job.file.format,
    target: job.target,
    verdict: outcomes[index].verdict,
    ms: Math.round(outcomes[index].ms),
    ...(outcomes[index].detail === undefined ? {} : { detail: outcomes[index].detail }),
  }));
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
  const gate = evaluate(jobs, readBaseline(), readKnownFailures());
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
