import { JobCancelledError, type Job } from '../queue/bullmq-engine';
import { jobDeadlineAt } from '../queue/job-deadline';
import { openCaptureJobUrl } from '../queue/option-secrets';
import type { IStorageBackend } from '../storage/types';
import { eraseOwnedFile, saveRetainedResult } from '../storage/retention-service';
import { JobTimeoutError, type ConversionJobData, type ConversionJobResult } from '../types';
import { websiteCaptureEnabled } from './capture-enabled';
import { captureWebsite } from './website-capture';
import { CaptureUnavailableError } from './website-capture-errors';

function resolveCaptureTimeoutMs(requestedTimeout: number | undefined, deadlineAt: number | undefined): number | undefined {
  if (deadlineAt === undefined) return requestedTimeout;
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    throw new JobTimeoutError(Math.max(0, requestedTimeout ?? 0));
  }
  return requestedTimeout !== undefined ? Math.min(requestedTimeout, remainingMs) : remainingMs;
}

/**
 * Runs an anonymous or signed-in web capture job queued on the `memory` resource queue, opening its sealed URL only at
 * the point of execution and storing the resulting file with standard undelivered-result retention.
 */
export async function processQueuedCaptureJob(
  job: Job<ConversionJobData, ConversionJobResult>,
  rootStorage: IStorageBackend
): Promise<ConversionJobResult> {
  if (!websiteCaptureEnabled()) {
    throw new CaptureUnavailableError();
  }
  const payload = job.data.captureJob!;
  const startedAt = Date.now();
  const attemptSignal = job.signal;
  attemptSignal?.throwIfAborted();

  const url = openCaptureJobUrl(payload, job.id);
  const { timeoutMs: requestedTimeout, ...captureOptions } = payload.options ?? {};
  const effectiveTimeout = resolveCaptureTimeoutMs(requestedTimeout, jobDeadlineAt(job));

  await job.updateProgress(20);
  attemptSignal?.throwIfAborted();

  const captured = await captureWebsite({
    url,
    format: payload.format,
    options: captureOptions,
    timeoutMs: effectiveTimeout,
    signal: attemptSignal,
  });

  if (attemptSignal?.aborted) {
    throw new JobCancelledError('Website capture job cancelled before storing result.');
  }

  const resultKey = `results/${job.id}/${captured.filename}`;
  await saveRetainedResult(rootStorage, resultKey, captured.buffer, captured.mimeType, captured.filename);

  if (attemptSignal?.aborted) {
    await eraseOwnedFile(rootStorage, resultKey).catch(() => undefined);
    throw new JobCancelledError('Website capture job cancelled after saving result.');
  }

  await job.updateProgress(100);
  const durationMs = Date.now() - startedAt;

  return {
    jobId: job.id,
    status: 'completed',
    resultKey,
    downloadUrl: `/api/storage/file/${encodeURIComponent(resultKey)}`,
    filename: captured.filename,
    mimeType: captured.mimeType,
    size: captured.buffer.length,
    durationMs,
    ...(captured.warnings.length > 0 ? { warnings: captured.warnings } : {}),
  };
}
