import { conversionQueue, flushPendingCancellationListeners } from './conversion-queue';
import { graphScheduler } from './graph';

/**
 * Cancels one standalone queue job (and cleans up any linked graph wrapper if present),
 * triggering queue `cancelled` listeners (quota rollback + input hold release) and
 * waiting for all async cancellation listeners to settle before returning.
 */
export async function cancelSingleQueueJob(jobId: string, reason: string): Promise<boolean> {
  try {
    await graphScheduler.cancelGraph(jobId, reason).catch(() => {});
    return await conversionQueue.cancelJob(jobId, reason);
  } finally {
    await flushPendingCancellationListeners();
  }
}

/**
 * Cancels one graph execution and all its node jobs, triggering quota rollback and
 * waiting for all async cancellation listeners to settle before returning.
 */
export async function cancelSingleGraphJob(graphId: string, reason: string): Promise<boolean> {
  try {
    return await graphScheduler.cancelGraph(graphId, reason);
  } finally {
    await flushPendingCancellationListeners();
  }
}
