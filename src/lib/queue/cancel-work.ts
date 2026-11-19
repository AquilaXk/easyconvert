import { conversionQueue } from './conversion-queue';
import { graphScheduler } from './graph';

/**
 * Cancels one standalone queue job (and cleans up any linked graph wrapper if present),
 * triggering queue `cancelled` listeners (quota rollback + input hold release) and
 * publishing the `cancelled` event on Redis pub/sub (`BullMQAdapter.publishEvent`).
 */
export async function cancelSingleQueueJob(jobId: string, reason: string): Promise<boolean> {
  await graphScheduler.cancelGraph(jobId, reason).catch(() => {});
  return conversionQueue.cancelJob(jobId, reason);
}

/**
 * Cancels one graph execution and all its node jobs, triggering quota rollback and
 * pub/sub cancellation events for active nodes.
 */
export async function cancelSingleGraphJob(graphId: string, reason: string): Promise<boolean> {
  return graphScheduler.cancelGraph(graphId, reason);
}
