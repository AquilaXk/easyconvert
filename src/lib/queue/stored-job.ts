import type Redis from 'ioredis';
import type { ConversionRefusalCode } from '../refusal-codes';
import { pipelineReplies } from '../redis/pipeline-replies';
import type { Job, JobState } from './bullmq-engine';

/** The `userId` of job data, or undefined. */
export function ownerOf(data: unknown): string | undefined {
  const userId = typeof data === 'object' && data !== null ? (data as { userId?: unknown }).userId : undefined;
  return typeof userId === 'string' && userId !== '' ? userId : undefined;
}

/** Parses a JSON hash field; undefined when it is absent or damaged. */
export function parseStoredJson<V>(text: string | undefined): V | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as V;
  } catch {
    return undefined;
  }
}

/** Copies the state, outcome and failure fields of a stored job hash onto a job. */
export function applyStoredJobFields<T, R>(job: Job<T, R>, raw: Record<string, string>): void {
  job.progress = Number(raw.progress || 0);
  job.state = (raw.state as JobState) || 'waiting';
  job.attemptsMade = Number(raw.attemptsMade || 0);
  job.timestamp = Number(raw.timestamp || Date.now());
  if (raw.processedOn) job.processedOn = Number(raw.processedOn);
  if (raw.finishedOn) job.finishedOn = Number(raw.finishedOn);
  if (raw.failedReason) job.failedReason = raw.failedReason;
  if (raw.failedCode) job.failedCode = raw.failedCode;
  if (raw.failedStatus) job.failedStatus = Number(raw.failedStatus);
  if (raw.failedRefusalCode) job.failedRefusalCode = raw.failedRefusalCode as ConversionRefusalCode;
  if (raw.returnvalue) job.returnvalue = parseStoredJson<R>(raw.returnvalue) ?? job.returnvalue;
  job.stacktrace = parseStoredJson<string[]>(raw.stacktrace) ?? job.stacktrace;
  job.logs = parseStoredJson<string[]>(raw.logs) ?? job.logs;
}

/** Serializes a Job instance into the flat string-to-string Redis hash stored under `<prefix>{<queue>}:job:<id>`. */
export function serializeJobToHash<T, R>(job: Job<T, R>): Record<string, string> {
  const rawData =
    typeof job.data === 'object' && job.data !== null && !Array.isArray(job.data)
      ? (job.data as Record<string, unknown>)
      : {};
  const graphId = rawData.graphId;
  const hash: Record<string, string> = {
    id: job.id,
    name: job.name,
    data: JSON.stringify(job.data ?? {}),
    userId: ownerOf(job.data) ?? '',
    isGraphNode: typeof graphId === 'string' && graphId.length > 0 ? '1' : '0',
    opts: JSON.stringify(job.opts ?? {}),
    progress: String(job.progress),
    state: job.state,
    attemptsMade: String(job.attemptsMade),
    timestamp: String(job.timestamp),
    processedOn: job.processedOn ? String(job.processedOn) : '',
    finishedOn: job.finishedOn ? String(job.finishedOn) : '',
    returnvalue: job.returnvalue !== undefined ? JSON.stringify(job.returnvalue) : '',
    failedReason: job.failedReason || '',
    failedCode: job.failedCode || '',
    failedStatus: job.failedStatus === undefined ? '' : String(job.failedStatus),
    failedRefusalCode: job.failedRefusalCode ?? '',
    stacktrace: JSON.stringify(job.stacktrace || []),
    logs: JSON.stringify(job.logs || []),
  };
  if (typeof rawData.sourceFormat === 'string') hash.sourceFormat = rawData.sourceFormat;
  if (typeof rawData.targetFormat === 'string') hash.targetFormat = rawData.targetFormat;
  if (typeof rawData.originalFilename === 'string') hash.originalFilename = rawData.originalFilename;
  if (typeof rawData.fileSize === 'number' && Number.isFinite(rawData.fileSize)) {
    hash.fileSize = String(rawData.fileSize);
  }
  return hash;
}

/** Appends `<jobKey>:logs` LIST entries onto `job.logs`, keeping at most `maxLogs` entries. */
export function mergeStoredJobLogs<T, R>(
  job: Job<T, R>,
  listLogs: readonly string[] | undefined,
  maxLogs: number
): void {
  if (!Array.isArray(listLogs) || listLogs.length === 0) return;
  job.logs = job.logs.length > 0 ? [...job.logs, ...listLogs].slice(-maxLogs) : [...listLogs];
}

/** Reads one stored job hash and its companion `<jobKey>:logs` LIST in a single pipeline round-trip when supported. */
export async function readStoredJobWithLogs<T, R>(
  redis: Redis,
  jobKey: string,
  maxLogs: number,
  toJob: (raw: Record<string, string>) => Job<T, R>
): Promise<Job<T, R> | undefined> {
  if (typeof redis.pipeline === 'function') {
    const pipe = redis.pipeline();
    if (typeof (pipe as { lrange?: unknown }).lrange === 'function') {
      pipe.hgetall(jobKey);
      pipe.lrange(`${jobKey}:logs`, 0, -1);
      const replies = await pipelineReplies(pipe);
      const raw = replies[0] as Record<string, string> | undefined;
      if (!raw || !raw.id) return undefined;
      const job = toJob(raw);
      mergeStoredJobLogs(job, replies[1] as string[] | undefined, maxLogs);
      return job;
    }
  }
  const raw = await redis.hgetall(jobKey);
  if (!raw || !raw.id) return undefined;
  const job = toJob(raw);
  if (typeof (redis as { lrange?: unknown }).lrange === 'function') {
    mergeStoredJobLogs(job, await redis.lrange(`${jobKey}:logs`, 0, -1), maxLogs);
  }
  return job;
}

/** Reads `jobKeys` and their `<jobKey>:logs` LISTs in a single pipeline round-trip when supported. */
export async function readStoredJobsWithLogs<T, R>(
  redis: Redis,
  jobKeys: readonly string[],
  maxLogs: number,
  toJob: (raw: Record<string, string>) => Job<T, R>
): Promise<Job<T, R>[]> {
  if (jobKeys.length === 0) return [];
  if (typeof redis.pipeline === 'function') {
    const pipe = redis.pipeline();
    if (typeof (pipe as { lrange?: unknown }).lrange === 'function') {
      for (const jk of jobKeys) {
        pipe.hgetall(jk);
        pipe.lrange(`${jk}:logs`, 0, -1);
      }
      const replies = await pipelineReplies(pipe);
      const listed: Job<T, R>[] = [];
      for (let i = 0; i < jobKeys.length; i++) {
        const hash = (replies[i * 2] as Record<string, string> | undefined) ?? {};
        if (!hash.id) continue;
        const job = toJob(hash);
        mergeStoredJobLogs(job, replies[i * 2 + 1] as string[] | undefined, maxLogs);
        listed.push(job);
      }
      return listed;
    }
  }
  const hashes = await readJobHashes(redis, jobKeys);
  return hashes.flatMap((hash) => (hash.id ? [toJob(hash)] : []));
}

/** Converts a flat HGETALL reply (field, value, field, value, ...) into a record. */
export function flatHashToRecord(flat: string[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (let i = 0; i + 1 < flat.length; i += 2) {
    record[flat[i]] = flat[i + 1];
  }
  return record;
}

/** The hashes of the job keys `jobKeys`, in order, all read through one pipeline (as BullMQ Queue.getJobs reads them through one multi); an empty one is a job that is gone. */
export async function readJobHashes(redis: Redis, jobKeys: readonly string[]): Promise<Record<string, string>[]> {
  const pipeline = redis.pipeline();
  for (const key of jobKeys) pipeline.hgetall(key);
  return (await pipelineReplies(pipeline)) as Record<string, string>[];
}
