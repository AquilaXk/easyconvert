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

/** How the reservation of a graph ends: settled to the units its nodes charged, or given back. */
export type ReservationEnd = { kind: 'settle'; units: number } | { kind: 'rollback' };

/** How a graph ended, and what that does to its reservation. */
export interface GraphEnd {
  outcome: GraphOutcome;
  reservation: ReservationEnd;
}

/** The graph whose end a scheduler recorded: its id, its reservation, and how to read its state for the announcement. */
export interface EndedGraph {
  graphId: string;
  reservationId: string | undefined;
  readState: () => Promise<GraphExecutionState | undefined>;
}

/**
 * Ends the reservation of graph `graphId`: settled or given back as `end` says. It never throws, and a reservation the key
 * store did not end is logged with the graph and the reservation, since nothing tries it again.
 */
async function endGraphReservation(graphId: string, reservationId: string | undefined, end: ReservationEnd): Promise<void> {
  if (!reservationId) return;
  const action = end.kind === 'rollback' ? 'given back' : `settled to ${end.units} units`;
  try {
    const ended = end.kind === 'rollback' ? await redisKeyStore.rollbackQuota(reservationId) : (await redisKeyStore.settleQuota(reservationId, end.units)).success;
    if (!ended) console.error(`[GraphScheduler] Reservation ${reservationId} of graph ${graphId} was not ${action}: the key store holds no such reservation.`);
  } catch (err) {
    console.error(`[GraphScheduler] Reservation ${reservationId} of graph ${graphId} could not be ${action}:`, err);
  }
}

/** What `step` answers, or undefined once its failure is logged: the graph ended, and nothing tries the step again. */
async function orLogged<T>(graphId: string, failure: string, step: () => Promise<T>): Promise<T | undefined> {
  try {
    return await step();
  } catch (err) {
    console.error(`[GraphScheduler] Graph ${graphId} ended, but ${failure}:`, err);
    return undefined;
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

/** Tells the webhook that the graph ended, and only then removes its files, so a storage fault delays the cleanup but never the notice. */
async function announceGraphEnd(state: GraphExecutionState, outcome: GraphOutcome): Promise<void> {
  await notifyWebhook(state, outcome);
  await removeGraphFiles(state.graphId, state.graph).catch((err: unknown) => {
    console.error(`[GraphScheduler] The files of graph ${state.graphId} could not be removed:`, err);
  });
}

/**
 * The end of `graph`, run once by the one call that recorded it (the Lua transition in Redis, `recordEnd` in the process).
 * The reservation is ended first, so no later step can leave it open; then `between` runs (cancelling the other node jobs,
 * draining the outbox); then the webhook is told and the files are removed. A failure of `between` or of reading the state
 * is logged and never stops what follows, and nothing here throws.
 */
export async function finishGraph(graph: EndedGraph, end: GraphEnd, between: () => Promise<unknown> = async () => undefined): Promise<void> {
  await endGraphReservation(graph.graphId, graph.reservationId, end.reservation);
  await orLogged(graph.graphId, 'a step between its settle and its announcement failed', between);
  const state = await orLogged(graph.graphId, 'its state could not be read to announce the end', graph.readState);
  if (state) await announceGraphEnd(state, end.outcome);
}
