import { ConversionFailedError, typedFailureOf } from '../types';

/** How a failed attempt is recorded on the job and whether the queue may try the job again. */
export interface JobFailureInfo {
  /** Error class name of a typed failure; undefined for an untyped one. */
  code?: string;
  /** HTTP status the same failure answers on the synchronous API; undefined for an untyped failure. */
  status?: number;
  /** False when another attempt would fail the same way. */
  retryable: boolean;
}

/**
 * Classifies a failed attempt. A typed conversion failure says itself whether another attempt may end otherwise
 * (`retryable`): a verdict on the input (malformed, unsupported, over a limit) is final, so retrying only repeats the
 * work, while a missing engine is not, because another worker of the pool may have it (`EngineMissingError`).
 * Anything untyped (a dropped socket, an out-of-memory kill) says nothing about the input and stays retryable.
 */
export function classifyJobFailure(err: unknown): JobFailureInfo {
  if (err instanceof ConversionFailedError) return { code: err.name, status: typedFailureOf(err)?.status, retryable: err.retryable };
  return { retryable: true };
}

/**
 * Whether the attempt that just failed with `err` is the last one the job gets. A failure that cannot be retried
 * is final whatever the attempt count says; the attempts are only exhausted when the retries are used up.
 * Cleanup that must not run before a retry (removing the uploaded input, failing a graph node) is keyed on this.
 */
export function isFinalFailure(job: { attemptsMade: number; opts?: { attempts?: number } }, err: unknown): boolean {
  if (!classifyJobFailure(err).retryable) return true;
  return !job.opts?.attempts || job.attemptsMade >= job.opts.attempts;
}
