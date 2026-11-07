import type { IQueueEngine, Job } from './bullmq-engine';

export interface JobTelemetryEvent {
  event: 'progress' | 'completed' | 'failed' | 'cancelled' | 'log';
  data: unknown;
}

/** Telemetry events after which a job emits nothing more. */
export const TERMINAL_TELEMETRY_EVENTS: ReadonlySet<JobTelemetryEvent['event']> = new Set<JobTelemetryEvent['event']>([
  'completed',
  'failed',
  'cancelled',
]);

/**
 * Subscribes to real-time job events for Server-Sent Events (SSE) telemetry.
 * Returns an unsubscription function.
 */
export function subscribeToJobTelemetry(
  queue: IQueueEngine,
  jobId: string,
  onEvent: (event: JobTelemetryEvent) => void
): () => void {
  const onProgress = (job: Job, progress: number) => {
    if (job.id === jobId) {
      onEvent({ event: 'progress', data: { jobId, progress, state: job.state } });
    }
  };
  const onCompleted = (job: Job, result: unknown) => {
    if (job.id === jobId) {
      onEvent({ event: 'completed', data: { jobId, progress: 100, state: 'completed', result } });
    }
  };
  const onFailed = (job: Job) => {
    if (job.id === jobId) {
      onEvent({ event: 'failed', data: { jobId, state: 'failed', error: job.failedReason } });
    }
  };
  const onCancelled = (job: Job) => {
    if (job.id === jobId) {
      onEvent({ event: 'cancelled', data: { jobId, state: 'cancelled', error: job.failedReason } });
    }
  };

  const onTelemetry = (e: JobTelemetryEvent) => {
    onEvent(e);
  };

  queue.on('progress', onProgress);
  queue.on('completed', onCompleted);
  queue.on('failed', onFailed);
  queue.on('cancelled', onCancelled);
  queue.on?.(`telemetry:${jobId}`, onTelemetry);

  return () => {
    queue.off('progress', onProgress);
    queue.off('completed', onCompleted);
    queue.off('failed', onFailed);
    queue.off('cancelled', onCancelled);
    queue.off?.(`telemetry:${jobId}`, onTelemetry);
  };
}
