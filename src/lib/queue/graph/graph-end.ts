import { redisKeyStore } from '../../api-keys/redis-key-store';
import { webhookDispatcher, type WebhookDispatchResult } from '../../api-keys/webhook-dispatcher';
import { storageProvider } from '../../storage';
import { recordGraphOutputsInHistory } from './graph-history';
import { releaseInputHolds } from './input-cleanup';
import type { GraphExecutionState } from './scheduler-types';
import { namedJobFields } from '../../jobs/named-task-report';

/** How a graph ended: completed, failed for a reason, or cancelled. */
export type GraphOutcome = { status: 'completed' } | { status: 'failed'; error: string } | { status: 'cancelled' };

/** Removes the intermediate files of graph `graphId`. */
async function removeIntermediateFiles(graphId: string): Promise<void> {
  if (typeof storageProvider.deleteByPrefix === 'function') {
    await storageProvider.deleteByPrefix(`intermediate/${graphId}/`);
  }
}

/** Gives back the holds the graph took on its input files and removes its intermediate files; a failure is logged. */
async function removeGraphFiles(graphId: string, inputKeys: readonly string[]): Promise<void> {
  try {
    await releaseInputHolds(graphId, inputKeys);
    await removeIntermediateFiles(graphId);
  } catch (err) {
    console.error(`[GraphScheduler] The files of graph ${graphId} could not be removed:`, err);
  }
}

/** How the reservation of a graph ends: settled to the units its nodes charged, or given back. */
export type ReservationEnd = { kind: 'settle'; units: number } | { kind: 'rollback' };

/** How a graph ended, and what that does to its reservation. */
export interface GraphEnd {
  outcome: GraphOutcome;
  reservation: ReservationEnd;
}

/**
 * The graph whose end a scheduler recorded: its id, its reservation, the stored files it read as inputs (known without its
 * state, so their holds end even when the state cannot be read), and how to read its state.
 */
export interface EndedGraph {
  graphId: string;
  reservationId: string | undefined;
  inputKeys: readonly string[];
  readState: () => Promise<GraphExecutionState | undefined>;
  /** Empties the webhook secret of the state and lets the state go `endedJobRetentionMs` after now, as its node jobs go. */
  forget: () => Promise<void>;
}

/** How often the state of an ended graph is read before the end goes on without it. */
const ENDED_STATE_READS = 2;

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
  const owner = { ownerUserId: state.ownerUserId, ownerKeyId: state.webhookKeyId };
  if (outcome.status === 'completed') {
    const payload = { jobId: graphId, status: 'completed', graphId, nodes, ...(state.namedTasks ? namedJobFields(state) : {}) };
    await logUndelivered(state, 'graph.completed', webhookDispatcher.dispatch(webhookUrl, 'graph.completed', payload, webhookSecret, owner));
  } else if (outcome.status === 'failed') {
    const payload = { jobId: graphId, status: 'failed', error: outcome.error, graphId, nodes, ...(state.namedTasks ? namedJobFields(state) : {}) };
    await logUndelivered(state, 'graph.failed', webhookDispatcher.dispatch(webhookUrl, 'graph.failed', payload, webhookSecret, owner));
  }
}

/**
 * The state of the ended graph, read up to ENDED_STATE_READS times while a read fails. A read that fails every time, or that
 * finds no state, is logged and answers undefined: the webhook cannot be addressed without it.
 */
async function readEndedState(graph: EndedGraph): Promise<GraphExecutionState | undefined> {
  for (let read = 1; read <= ENDED_STATE_READS; read++) {
    try {
      const state = await graph.readState();
      if (!state) console.error(`[GraphScheduler] Graph ${graph.graphId} ended, but its state is gone, so its webhook was not told.`);
      return state;
    } catch (err) {
      const outcome = read < ENDED_STATE_READS ? 'it is read again' : 'its webhook was not told';
      console.error(`[GraphScheduler] Graph ${graph.graphId} ended, but its state could not be read, so ${outcome}:`, err);
    }
  }
  return undefined;
}

/**
 * The end of `graph`, run once by the one call that recorded it (the Lua transition in Redis, `recordEnd` in the process).
 * The reservation is ended first, so no later step can leave it open; then the state is read once (`readEndedState`) and
 * handed to `between` (cancelling the other node jobs, draining the outbox); then, for a completed graph, its final outputs are
 * put in the history of its owner's files; then the webhook is told, when the state was
 * read, the holds on the input files and the intermediate files are removed, which needs no state, and the state is set to
 * expire without its webhook secret (`forget`). A failure of
 * `between` is logged and never stops what follows, and nothing here throws. Answers what `between` returned, or undefined
 * when it failed.
 */
export async function finishGraph<T>(
  graph: EndedGraph,
  end: GraphEnd,
  between?: (state: GraphExecutionState | undefined) => Promise<T>
): Promise<T | undefined> {
  await endGraphReservation(graph.graphId, graph.reservationId, end.reservation);
  const state = await readEndedState(graph);
  const result = between && (await orLogged(graph.graphId, 'a step between its settle and its announcement failed', () => between(state)));
  if (state && end.outcome.status === 'completed') await orLogged(graph.graphId, 'its outputs could not be recorded in the file history', () => recordGraphOutputsInHistory(state));
  if (state) await notifyWebhook(state, end.outcome);
  await removeGraphFiles(graph.graphId, graph.inputKeys);
  await orLogged(graph.graphId, 'its state could not be set to expire', graph.forget);
  return result;
}
