/**
 * Which conversions each corpus file goes through. Every file takes `perFile` of its source format's advertised
 * targets, rotating through the target list by the file's position among files of that format, so the corpus as a
 * whole covers every advertised pair as evenly as its size allows. Files (with all their jobs) are dealt to shards
 * round-robin, so each shard fetches and caches only its own share of the corpus.
 */
import type { CorpusFile } from './manifest';

export interface Job {
  file: CorpusFile;
  target: string;
}

/** Jobs for the files, given each source format's advertised targets. */
export function planJobs(files: readonly CorpusFile[], targetsOf: (format: string) => readonly string[], perFile: number): Job[] {
  const seenPerFormat = new Map<string, number>();
  const jobs: Job[] = [];
  for (const file of files) {
    const targets = targetsOf(file.format);
    if (targets.length === 0) continue;
    const index = seenPerFormat.get(file.format) ?? 0;
    seenPerFormat.set(file.format, index + 1);
    const count = Math.min(perFile, targets.length);
    for (let k = 0; k < count; k++) jobs.push({ file, target: targets[(index * count + k) % targets.length] });
  }
  return jobs;
}

/** The jobs of shard `shard` (0-based) out of `shards`: those of every `shards`-th file, in first-seen order. */
export function shardJobs(jobs: readonly Job[], shard: number, shards: number): Job[] {
  if (!Number.isInteger(shards) || shards < 1 || !Number.isInteger(shard) || shard < 0 || shard >= shards) {
    throw new RangeError(`shard ${shard} of ${shards} is out of range`);
  }
  const fileIndex = new Map<string, number>();
  for (const job of jobs) if (!fileIndex.has(job.file.id)) fileIndex.set(job.file.id, fileIndex.size);
  return jobs.filter((job) => fileIndex.get(job.file.id)! % shards === shard);
}
