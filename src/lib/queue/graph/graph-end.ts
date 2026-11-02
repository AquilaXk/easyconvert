import { redisKeyStore } from '../../api-keys/redis-key-store';
import { webhookDispatcher, type WebhookDispatchResult } from '../../api-keys/webhook-dispatcher';
import { storageProvider } from '../../storage';
import { releaseGraphInputHolds } from './input-cleanup';
import type { GraphExecutionState } from './scheduler-types';
import type { JobGraph } from './types';

/** How a graph ended: completed, failed for a reason, or cancelled. */
export type GraphOutcome = { status: 'completed' } | { status: 'failed'; error: string } | { status: 'cancelled' };

/** Gives back the holds the graph took on its input files and removes its intermediate files. */
async function removeGraphFiles(graphId: string, graph: JobGraph): Promise<void> {
  await releaseGraphInputHolds(graphId, graph);
  if (typeof storageProvider.deleteByPrefix === 'function') {
    await storageProvider.deleteByPrefix(`intermediate/${graphId}/`);
  }
}

/**
 * Ends the reservation of graph `graphId` as soon as its scheduler recorded the end, before any other step of that end
 * can fail: settled to the `units` its nodes charged, or given back when `units` is undefined (the graph did not complete,
 * or the count it stored cannot be read). It never throws, and a reservation the key store did not end is logged with
 * the graph and the reservation, since nothing tries it again.
 */
export async function endGraphReservation(graphId: string, reservationId: string | undefined, units: number | undefined): Promise<void> {
  if (!reservationId) return;
  const action = units === undefined ? 'given back' : `settled to ${units} units`;
  try {
    const ended = units === undefined ? await redisKeyStore.rollbackQuota(reservationId) : (await redisKeyStore.settleQuota(reservationId, units)).success;
    if (!ended) console.error(`[GraphScheduler] Reservation ${reservationId} of graph ${graphId} was not ${action}: the key store holds no such reservation.`);
  } catch (err) {
    console.error(`[GraphScheduler] Reservation ${reservationId} of graph ${graphId} could not be ${action}:`, err);
  }
}

/** Waits for one delivery of a graph's webhook, and logs one the endpoint did not accept or that could not be sent. */
async function logUndelivered(state: GraphExecutionState, event: string, delivery: Promise<WebhookDispatchResult>): Promise<void> {
  const failed = `[GraphScheduler] The ${event} webhook of graph ${state.graphId} (reservation ${state.reservationId ?? 'none'}) was not delivered`;
  try {
    const result = await delivery;
    if (!result.success) console.error(`${failed}: the endpoint did not accept it after ${result.totalAttempts} attempt(s).`);
  } catch (err) {
    console.error(`${failed}:`, err);
  }
}

/** Tells the graph's webhook that it completed or failed; a cancel was asked for by the owner, so it is not announced. */
async function notifyWebhook(state: GraphExecutionState, outcome: GraphOutcome): Promise<void> {
  const { graphId, nodes, webhookUrl, webhookSecret } = state;
  if (!webhookUrl || !webhookSecret) return;
  const owner = { ownerUserId: state.ownerUserId };
  if (outcome.status === 'completed') {
    const payload = { jobId: graphId, status: 'completed', graphId, nodes };
    await logUndelivered(state, 'graph.completed', webhookDispatcher.dispatch(webhookUrl, 'graph.completed', payload, webhookSecret, owner));
  } else if (outcome.status === 'failed') {
    const payload = { jobId: graphId, status: 'failed', error: outcome.error, graphId, nodes };
    await logUndelivered(state, 'graph.failed', webhookDispatcher.dispatch(webhookUrl, 'graph.failed', payload, webhookSecret, owner));
  }
}

/**
 * The rest of the end of a graph whose reservation `endGraphReservation` already ended, run once by the one caller that
 * recorded the end: the webhook is told, and only then are the files removed, so a storage fault delays the cleanup but
 * never the notice. Neither step throws; each failure is logged.
 */
export async function announceGraphEnd(state: GraphExecutionState, outcome: GraphOutcome): Promise<void> {
  await notifyWebhook(state, outcome);
  await removeGraphFiles(state.graphId, state.graph).catch((err: unknown) => {
    console.error(`[GraphScheduler] The files of graph ${state.graphId} could not be removed:`, err);
  });
}
