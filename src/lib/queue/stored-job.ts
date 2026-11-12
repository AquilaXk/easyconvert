import type Redis from 'ioredis';
import type { ConversionRefusalCode } from '../refusal-codes';
import { pipelineReplies } from '../redis/pipeline-replies';
import type { Job, JobState } from './bullmq-engine';

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
