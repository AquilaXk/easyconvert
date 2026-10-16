/**
 * Which files and which conversions a run of the regression corpus covers. A weekly (full) run takes every file. A nightly run
 * takes the files of one of seven buckets, chosen by the date, so that seven nights cover the corpus once, and a fixed canary
 * set: one file of every format and producer class, and every file that failed before. Buckets come from the hash of a file's
 * id, so a file keeps its night when the manifest grows.
 */
import { createHash } from 'node:crypto';
import type { CorpusFile } from '../manifest';
import type { Job } from '../plan';
import { producerClass } from './producer';

export const ROTATION_DAYS = 7;
const DAY_MS = 86_400_000;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const HASH_PREFIX_BYTES = 4;

export type RunMode = 'full' | 'nightly';

/**
 * Shards of a run, sized from the real-world corpus run (nightly artifact `realworld-results` of 2026-10-16): the mean time of a
 * job there, by format and size class, weighted by the mix of this corpus (which draws more large files than that one) is 3.1 s
 * on 3 workers; the shards of that run took 11 to 20 minutes of the 60-minute limit with 1,650 jobs each. A full run of about
 * 20,000 jobs in 12 shards is 1,670 jobs a shard, 29 minutes of conversion; a nightly run of a seventh plus the canary, about
 * 4,200 jobs, in 4 shards is 1,050 jobs a shard, 18 minutes.
 */
export const SHARDS: Readonly<Record<RunMode, number>> = { full: 12, nightly: 4 };
export const ESTIMATED_MS_PER_JOB = 3100;
export const JOB_WORKERS = 3;
/** Conversion time a shard may be estimated at, leaving the rest of the 60-minute job limit to set-up, fetching and slow tails. */
export const SHARD_CONVERSION_BUDGET_MINUTES = 35;

const hashPrefix = (text: string): number => createHash('sha256').update(text).digest().readUIntBE(0, HASH_PREFIX_BYTES);

/** Orders ids by hash, then by name, so that ties cannot make the choice depend on the order of the manifest. */
const orderKey = (id: string): string => `${hashPrefix(id).toString(16).padStart(HASH_PREFIX_BYTES * 2, '0')}:${id}`;

/** The night of the week (0 to 6) a file is covered on. */
export const rotationBucket = (fileId: string): number => hashPrefix(fileId) % ROTATION_DAYS;

/** Days since 1970-01-01 (UTC) modulo seven, for a date written YYYY-MM-DD. */
export function dayBucket(date: string): number {
  const match = ISO_DAY.exec(date);
  if (match === null) throw new RangeError(`date ${JSON.stringify(date)} is not YYYY-MM-DD`);
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) throw new RangeError(`date ${date} is not a calendar day`);
  return (utc.getTime() / DAY_MS) % ROTATION_DAYS;
}

const classOf = (file: CorpusFile): string => `${file.format}|${producerClass(file.producer ?? null)}`;

/**
 * One file of every format and producer class (the one whose id hashes lowest, so the choice does not depend on the order of
 * the manifest), and every file of `failedBefore`. A listed file that is not in the manifest is an error: the list is
 * maintained, and a stale entry would silently shrink the canary.
 */
export function canarySelection(files: readonly CorpusFile[], failedBefore: ReadonlySet<string>): CorpusFile[] {
  const known = new Set(files.map((file) => file.id));
  const missing = [...failedBefore].filter((id) => !known.has(id));
  if (missing.length > 0) throw new Error(`failed-before list names files that are not in the manifest: ${missing.join(', ')}`);
  const representatives = new Map<string, CorpusFile>();
  for (const file of files) {
    const current = representatives.get(classOf(file));
    if (current === undefined || orderKey(file.id) < orderKey(current.id)) representatives.set(classOf(file), file);
  }
  const chosen = new Map<string, CorpusFile>([...representatives.values()].map((file) => [file.id, file]));
  for (const file of files) if (failedBefore.has(file.id)) chosen.set(file.id, file);
  return [...chosen.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** The files of a nightly run: the bucket of the date, plus the canary unless `canary` is false. */
export function nightlySelection(files: readonly CorpusFile[], date: string, failedBefore: ReadonlySet<string>, options: { canary?: boolean } = {}): CorpusFile[] {
  const bucket = dayBucket(date);
  const wanted = new Map(files.filter((file) => rotationBucket(file.id) === bucket).map((file) => [file.id, file]));
  if (options.canary !== false) for (const file of canarySelection(files, failedBefore)) wanted.set(file.id, file);
  return [...wanted.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function selectForMode(mode: RunMode, files: readonly CorpusFile[], date: string, failedBefore: ReadonlySet<string>): CorpusFile[] {
  return mode === 'full' ? [...files] : nightlySelection(files, date, failedBefore);
}

/**
 * The jobs of the files: each takes `perFile` consecutive targets of its format's list, starting at a position its id hashes to.
 * The choice depends on the file alone, so a file keeps its targets when the corpus grows or a night covers only a part of it,
 * which is what lets a nightly result be compared with the weekly one.
 */
export function planRegressionJobs(files: readonly CorpusFile[], targetsOf: (format: string) => readonly string[], perFile: number): Job[] {
  return files.flatMap((file) => {
    const targets = targetsOf(file.format);
    const start = hashPrefix(`${file.id}:targets`) % Math.max(1, targets.length);
    return Array.from({ length: Math.min(perFile, targets.length) }, (_, k) => ({ file, target: targets[(start + k) % targets.length] }));
  });
}

/** At most `limit` of the jobs, evenly spread over the list, for a trial run that should see every format and producer rather than the first files. */
export function thinJobs(jobs: readonly Job[], limit: number): Job[] {
  if (jobs.length <= limit) return [...jobs];
  return Array.from({ length: limit }, (_, i) => jobs[Math.floor((i * jobs.length) / limit)]);
}
