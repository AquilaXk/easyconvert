#!/usr/bin/env node
// Splits the sharded vitest files into shards of about equal duration.
//
// `vitest --shard=i/n` splits by file count and pays no attention to how long a file runs, so one shard could hold
// several of the slowest files and set the wall time of the whole CI run. This planner packs the files by their
// recorded duration (longest first, always into the lightest shard), so the slowest shard stays close to the mean.
//
//   node scripts/ci-test-shards.mjs <index> <count>      prints the test files of shard <index> (1-based), one per line
//   node scripts/ci-test-shards.mjs --summary <count>    prints the planned load of every shard
//   node scripts/ci-test-shards.mjs --update <report>... merges vitest JSON reports (--reporter=json) into the table
//
// Durations live in .github/ci/test-durations.json (seconds per file). A file without an entry is planned with the
// median duration, so a new test file is spread like an average one until the table is refreshed. Every shard of the
// `tests` job uploads its JSON report as the artifact `test-report-<shard>`; the table is refreshed from the reports of
// one main run:
//
//   gh run download <run id> --pattern 'test-report-*' --dir <dir>
//   node scripts/ci-test-shards.mjs --update <dir>/test-report-*/*.json
//
// An update also drops the entries of files the job no longer runs (deleted or moved out of the shards).
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTS_DIR = 'tests';
const DURATIONS_FILE = path.join(ROOT, '.github', 'ci', 'test-durations.json');
const TEST_SUFFIX = '.test.ts';
/**
 * Files the sharded job does not run: the timing suites run nightly, the conformance gate has its own jobs, the
 * real-server storage tests run in the one job that starts the S3 test server (the `integration` job of ci.yml), and the
 * Parquet writer conformance runs in that job too, in strict mode, so a runtime without zstd in node:zlib (Node 22.15 or newer has it) fails the ZSTD rows.
 */
const EXCLUDED_SUFFIXES = ['.perf.test.ts'];
const EXCLUDED_FILES = new Set([
  'tests/registry-engine-conformance.test.ts',
  'tests/s3-minio-integration.test.ts',
  'tests/s3-object-client.test.ts',
  'tests/parquet-writer-conformance.test.ts',
]);
/** Upper bound on the shard count: a larger value is a typo, not a plan. */
export const MAX_SHARDS = 64;
const MS_PER_SECOND = 1000;
const DURATION_DECIMALS = 10;
const FALLBACK_SECONDS = 1;

export class ShardPlanError extends Error {}

/** The sharded files that have no entry in the table: each is planned at the median, whatever it really takes. */
export function unrecordedFiles(files, durations) {
  return files.filter((file) => !(file in durations));
}

/** The table without the entries of files the sharded job does not run (deleted, renamed or moved out of the shards). */
export function dropUnshardedEntries(durations, files) {
  const sharded = new Set(files);
  return Object.fromEntries(Object.entries(durations).filter(([file]) => sharded.has(file)));
}

/** Test files the sharded job runs, as repository-relative POSIX paths, sorted. */
export function listShardedTests(root = ROOT) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const relative = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(relative);
      else if (entry.name.endsWith(TEST_SUFFIX) && !EXCLUDED_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) {
        if (!EXCLUDED_FILES.has(relative)) found.push(relative);
      }
    }
  };
  walk(TESTS_DIR);
  return found.sort();
}

export function loadDurations(file = DURATIONS_FILE) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ShardPlanError(`${file} must hold an object of file -> seconds`);
  }
  for (const [name, seconds] of Object.entries(parsed)) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
      throw new ShardPlanError(`${file}: the duration of ${name} must be a non-negative number`);
    }
  }
  return parsed;
}

function median(values) {
  if (values.length === 0) return FALLBACK_SECONDS;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Packs `files` into `count` shards: longest file first, always into the shard with the least load. `baseLoads`
 * gives shard i work it carries whatever the files are (the conformance gate's part 1 also runs the registry-wide
 * checks), so the packing leaves room for it; a missing entry is 0.
 */
export function planShards(files, durations, count, baseLoads = []) {
  if (!Number.isInteger(count) || count < 1 || count > MAX_SHARDS) {
    throw new ShardPlanError(`the shard count must be an integer from 1 to ${MAX_SHARDS}, got ${count}`);
  }
  if (baseLoads.length > count || baseLoads.some((load) => typeof load !== 'number' || !Number.isFinite(load) || load < 0)) {
    throw new ShardPlanError(`the base loads must be at most ${count} non-negative numbers`);
  }
  const fallback = median(files.filter((file) => file in durations).map((file) => durations[file]));
  const weighted = files.map((file) => ({ file, seconds: file in durations ? durations[file] : fallback }));
  weighted.sort((a, b) => b.seconds - a.seconds || (a.file < b.file ? -1 : 1));
  const shards = Array.from({ length: count }, (_, index) => ({ load: baseLoads[index] ?? 0, files: [] }));
  for (const item of weighted) {
    let lightest = shards[0];
    for (const shard of shards) if (shard.load < lightest.load) lightest = shard;
    lightest.load += item.seconds;
    lightest.files.push(item.file);
  }
  for (const shard of shards) shard.files.sort();
  return shards;
}

/**
 * The file of `testFiles` that the absolute path `reported` names, or undefined. A report written on the CI runner holds
 * the runner's checkout path, not this one, so a file is recognised by its repository-relative path at the end.
 */
function reportedTestFile(reported, testFiles) {
  const posix = reported.split(path.sep).join('/');
  return testFiles.find((file) => posix === file || posix.endsWith(`/${file}`));
}

/**
 * Merges the per-file wall time of vitest JSON reports into the duration table, for the files of `testFiles`. Throws when
 * no report names one of them, since an update that matched nothing would leave the table silently unchanged.
 */
export function mergeReports(durations, reports, testFiles) {
  const merged = { ...durations };
  let matched = 0;
  for (const report of reports) {
    for (const result of report.testResults ?? []) {
      const file = typeof result.name === 'string' ? reportedTestFile(result.name, testFiles) : undefined;
      if (file === undefined || typeof result.startTime !== 'number' || typeof result.endTime !== 'number') continue;
      const seconds = Math.round(((result.endTime - result.startTime) / MS_PER_SECOND) * DURATION_DECIMALS) / DURATION_DECIMALS;
      merged[file] = Math.max(0, seconds);
      matched += 1;
    }
  }
  if (matched === 0) throw new ShardPlanError(`no report names one of the ${testFiles.length} sharded test files`);
  return Object.fromEntries(Object.entries(merged).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function main(argv) {
  const [first, ...rest] = argv;
  if (first === '--update') {
    if (rest.length === 0) throw new ShardPlanError('--update needs at least one vitest JSON report');
    const reports = rest.map((file) => JSON.parse(readFileSync(file, 'utf8')));
    const files = listShardedTests();
    const merged = dropUnshardedEntries(mergeReports(loadDurations(), reports, files), files);
    writeFileSync(DURATIONS_FILE, `${JSON.stringify(merged, null, 2)}\n`);
    return;
  }
  const files = listShardedTests();
  const durations = loadDurations();
  if (first === '--summary') {
    const shards = planShards(files, durations, Number(rest[0]));
    shards.forEach((shard, index) => console.log(`shard ${index + 1}: ${shard.files.length} files, ${shard.load.toFixed(1)} s`));
    console.log(`${unrecordedFiles(files, durations).length} of ${files.length} files have no recorded duration`);
    return;
  }
  const index = Number(first);
  const count = Number(rest[0]);
  if (!Number.isInteger(index) || !Number.isInteger(count) || index < 1 || index > count) {
    throw new ShardPlanError(`usage: ci-test-shards.mjs <index> <count>, got ${argv.join(' ')}`);
  }
  console.log(planShards(files, durations, count)[index - 1].files.join('\n'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
