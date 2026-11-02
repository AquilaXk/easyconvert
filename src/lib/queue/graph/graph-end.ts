import { redisKeyStore } from '../../api-keys/redis-key-store';
import { webhookDispatcher } from '../../api-keys/webhook-dispatcher';
import { storageProvider } from '../../storage';
import { releaseGraphInputHolds } from './input-cleanup';
import type { GraphExecutionState } from './scheduler-types';
import type { JobGraph } from './types';

/** How a graph ended: completed with the units its nodes charged, failed for a reason, or cancelled. */
export type GraphOutcome = { status: 'completed'; units: number } | { status: 'failed'; error: string } | { status: 'cancelled' };

/** Gives back the holds the graph took on its input files and removes its intermediate files. */
async function removeGraphFiles(graphId: string, graph: JobGraph): Promise<void> {
  await releaseGraphInputHolds(graphId, graph);
  if (typeof storageProvider.deleteByPrefix === 'function') {
    await storageProvider.deleteByPrefix(`intermediate/${graphId}/`);
  }
}

async function endReservation(reservationId: string | undefined, outcome: GraphOutcome): Promise<void> {
  if (!reservationId) return;
  if (outcome.status === 'completed') {
    await redisKeyStore.settleQuota(reservationId, outcome.units).catch(() => {});
  } else {
    await redisKeyStore.rollbackQuota(reservationId).catch(() => {});
  }
}

/** Tells the graph's webhook that it completed or failed; a cancel was asked for by the owner, so it is not announced. */
async function notifyWebhook(state: GraphExecutionState, outcome: GraphOutcome): Promise<void> {
  const { graphId, nodes, webhookUrl, webhookSecret } = state;
  if (!webhookUrl || !webhookSecret) return;
  const owner = { ownerUserId: state.ownerUserId };
  if (outcome.status === 'completed') {
    await webhookDispatcher.dispatch(webhookUrl, 'graph.completed', { jobId: graphId, status: 'completed', graphId, nodes }, webhookSecret, owner).catch(() => {});
  } else if (outcome.status === 'failed') {
    await webhookDispatcher
      .dispatch(webhookUrl, 'graph.failed', { jobId: graphId, status: 'failed', error: outcome.error, graphId, nodes }, webhookSecret, owner)
      .catch(() => {});
  }
}

/**
 * The side effects of a graph whose scheduler just recorded its end, run once by the one caller that recorded it, in an
 * order that keeps the charge right whatever fails: the reservation is settled to the units the nodes charged or given
 * back, then the webhook is told, and only then are the files removed, so a storage fault delays the cleanup but never
 * the charge or the notice.
 */
export async function finishGraph(state: GraphExecutionState, outcome: GraphOutcome): Promise<void> {
  await endReservation(state.reservationId, outcome);
  await notifyWebhook(state, outcome);
  await removeGraphFiles(state.graphId, state.graph).catch((err: unknown) => {
    console.error(`[GraphScheduler] The files of graph ${state.graphId} could not be removed:`, err);
  });
}
