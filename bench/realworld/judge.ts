/**
 * Fetches and judges the jobs of one shard, shared by the real-world corpus run and the regression corpus run. Files are
 * fetched a batch at a time (digest-checked, kept in `cacheDir`) while the previous batch is being converted, converted through
 * the isolated job pool, and, when asked, deleted as soon as their jobs are judged, so a shard never holds more than two batches
 * on disk. A file that cannot be fetched, or whose bytes differ from the manifest, either fails the run or, when the caller
 * collects fetch errors, is reported as unavailable while the rest of the shard is judged.
 */
import fs from 'node:fs';
import { ensureCached, mapLimit } from './fetch';
import type { CorpusFile } from './manifest';
import { ocrPageCount } from './ocr-path';
import type { Job } from './plan';
import { JobPool, scaledDeadlineMs } from './pool';
import type { JobRecord } from './report';

const FETCH_CONCURRENCY = 8;
const PROGRESS_EVERY = 100;

export interface JudgeOptions {
  cacheDir: string;
  workers: number;
  deadlineMs: number;
  /** V8 heap cap of each job server, in MiB. */
  heapMb: number;
  env: NodeJS.ProcessEnv;
  /** Files fetched and judged together. */
  batchFiles: number;
  /** Delete each file once its jobs are judged. */
  deleteAfterJudged: boolean;
  /** Report a file that cannot be fetched as unavailable instead of failing the run. */
  collectFetchErrors: boolean;
}

export interface UnavailableFile {
  file: string;
  reason: string;
}

export interface JudgeResult {
  records: JobRecord[];
  unavailable: UnavailableFile[];
}

interface FetchedBatch {
  paths: Map<string, string>;
  unavailable: UnavailableFile[];
}

const chunk = <T>(items: readonly T[], size: number): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

async function fetchBatch(batch: readonly CorpusFile[], options: JudgeOptions): Promise<FetchedBatch> {
  const paths = new Map<string, string>();
  const unavailable: UnavailableFile[] = [];
  await mapLimit(batch, FETCH_CONCURRENCY, async (file) => {
    try {
      paths.set(file.id, await ensureCached(file, options.cacheDir));
    } catch (error) {
      if (!options.collectFetchErrors) throw error;
      unavailable.push({ file: file.id, reason: error instanceof Error ? error.message : String(error) });
    }
  });
  return { paths, unavailable };
}

/**
 * Starts fetching a batch while an earlier one is being judged. The rejection is observed here so that a failure during the
 * judging of the earlier batch is not an unhandled one; whoever awaits the batch still gets the error.
 */
function startFetch(batch: readonly CorpusFile[] | undefined, options: JudgeOptions): Promise<FetchedBatch> | undefined {
  if (batch === undefined) return undefined;
  const fetching = fetchBatch(batch, options);
  fetching.catch(() => undefined);
  return fetching;
}

async function pageCounts(batch: readonly CorpusFile[], paths: ReadonlyMap<string, string>): Promise<Map<string, number>> {
  const pages = new Map<string, number>();
  for (const file of batch.filter((candidate) => candidate.format === 'pdf' && paths.has(candidate.id))) pages.set(file.id, await ocrPageCount(fs.readFileSync(paths.get(file.id)!)));
  return pages;
}

function recordOf(job: Job, outcome: Awaited<ReturnType<JobPool['runAll']>>[number]): JobRecord {
  return {
    file: job.file.id,
    source: job.file.format,
    target: job.target,
    verdict: outcome.verdict,
    ms: Math.round(outcome.ms),
    ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
  };
}

/** Judges `jobs`, a file's jobs together and files in the order they first appear; jobs on unavailable files have no record. */
export async function judgeJobs(jobs: readonly Job[], options: JudgeOptions): Promise<JudgeResult> {
  const files = [...new Map(jobs.map((job) => [job.file.id, job.file])).values()];
  const batches = chunk(files, options.batchFiles);
  const pool = await JobPool.start({ workers: options.workers, deadlineMs: options.deadlineMs, heapMb: options.heapMb, env: options.env });
  const records: JobRecord[] = [];
  const unavailable: UnavailableFile[] = [];
  let done = 0;
  let prefetch = startFetch(batches[0], options);
  try {
    for (let index = 0; index < batches.length; index++) {
      const fetched = await prefetch!;
      prefetch = startFetch(batches[index + 1], options);
      unavailable.push(...fetched.unavailable);
      const pages = await pageCounts(batches[index], fetched.paths);
      const members = new Set(batches[index].map((file) => file.id));
      const batchJobs = jobs.filter((job) => members.has(job.file.id) && fetched.paths.has(job.file.id));
      const outcomes = await pool.runAll(
        batchJobs.map((job) => ({
          path: fetched.paths.get(job.file.id)!,
          name: job.file.id,
          format: job.file.format,
          target: job.target,
          emptyInput: job.file.emptyInput === true,
          deadlineMs: scaledDeadlineMs(options.deadlineMs, pages.get(job.file.id) ?? 0),
        })),
        () => {
          done++;
          if (done % PROGRESS_EVERY === 0) console.log(`  ${done}/${jobs.length}`);
        }
      );
      records.push(...batchJobs.map((job, at) => recordOf(job, outcomes[at])));
      if (options.deleteAfterJudged) for (const path of fetched.paths.values()) fs.rmSync(path, { force: true });
    }
  } finally {
    pool.stop();
    await prefetch?.catch(() => undefined);
  }
  return { records, unavailable };
}
