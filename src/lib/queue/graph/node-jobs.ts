import { setTimeout as sleep } from 'node:timers/promises';
import type { GraphExecutionState, GraphNodeJobMetadata, IGraphScheduler, SealedJobGraph } from './scheduler-types';
import { foundOrUnknown, RECOVERY_UNKNOWN, type Recovery } from '../../api-keys/hand-off';
import type { GraphNode, JobGraph, NodeId } from './types';
import { getQueueForResourceClass } from '../conversion-queue';
import { enqueueConversionJob } from '../enqueue';
import { tierForOwner } from '../page-cap';
import { tierMaxDeadlineMs } from '../job-deadline';
import { resolveNodeResourceClass } from '../resource-class';
import { sealGraphNode } from './sealed-nodes';
import { finishGraph } from './graph-end';
import { graphInputKeys } from './input-cleanup';

/** Attempts per graph node job; the node fails the graph only after the last one. */
export const GRAPH_NODE_JOB_ATTEMPTS = 3;

/** Queue job ID of a graph node. Deterministic so a repeated enqueue is a no-op. */
export function graphNodeJobId(graphId: string, nodeId: NodeId): string {
  return `${graphId}:${nodeId}`;
}

/** A scheduler was given a graph that `sealGraph` did not seal for the id it is stored under. */
export class GraphNotSealedError extends Error {
  constructor(graphId: string) {
    super(`Graph ${graphId} was not sealed for its own id, so it is not stored`);
    this.name = 'GraphNotSealedError';
  }
}

/**
 * A copy of the graph `graphId` with every node's secrets sealed under that node's job id, done once by the route before the
 * hand-off, so a secret that cannot be sealed refuses the request before its unit is handed off.
 */
export function sealGraph(graphId: string, graph: JobGraph): SealedJobGraph {
  const nodes = Object.fromEntries(Object.entries(graph.nodes).map(([nodeId, node]) => [nodeId, sealGraphNode(node, graphNodeJobId(graphId, nodeId))]));
  return { ...graph, nodes } as SealedJobGraph;
}

/** Where a node's files go: `intermediate` until the graph ends, or `results` for what an `export.internal` node keeps. */
export type NodeOutputArea = 'intermediate' | 'results';

/**
 * The key of what node `nodeId` of graph `graphId` made of its input number `index` (0 for a node that makes one file of all
 * its inputs): each node and each input in a folder of its own, so two outputs that share a file name never overwrite each
 * other, and each keeps its readable name.
 */
export function nodeOutputKey(area: NodeOutputArea, graphId: string, nodeId: NodeId, index: number, filename: string): string {
  return `${area}/${graphId}/${nodeId}/${index}/${filename}`;
}

/** The metadata the node jobs of a graph carry: exactly the fields a node job reads, so nothing else reaches the queue. */
export function graphNodeJobMetadata(graph: GraphNodeJobMetadata): GraphNodeJobMetadata {
  return { ownerUserId: graph.ownerUserId, originalFilename: graph.originalFilename, createdAt: graph.createdAt };
}

/**
 * Enqueues a ready graph node on the queue of its resource class. The engine ignores a second
 * add with the same job ID, so replaying an outbox entry after a crash never runs a node twice.
 */
export async function enqueueGraphNodeJob(
  graphId: string,
  nodeId: NodeId,
  node: GraphNode,
  meta: GraphNodeJobMetadata,
  inputArtifacts: string[]
): Promise<void> {
  const resourceClass = resolveNodeResourceClass(node);
  const jobId = graphNodeJobId(graphId, nodeId);
  const nodeFields = node as { targetFormat?: string; options?: Record<string, unknown> };
  await enqueueConversionJob(
    getQueueForResourceClass(resourceClass),
    'graph-node',
    {
      jobId,
      originalFilename: meta.originalFilename || `${nodeId}.bin`,
      sourceFormat: 'bin',
      targetFormat: nodeFields.targetFormat || 'bin',
      fileSize: 0,
      options: nodeFields.options || {},
      userId: meta.ownerUserId,
      graphId,
      graphNodeId: nodeId,
      // Fail closed: whatever path got a node here, its secrets are sealed before the queue sees it.
      graphNode: sealGraphNode(node, jobId),
      inputArtifacts,
      resourceClass,
    },
    { jobId, attempts: GRAPH_NODE_JOB_ATTEMPTS },
    // The size of a node's inputs is not known until it runs, so it gets the deadline maximum of its owner's tier,
    // and no node runs past the end of the graph's own deadline (the graph start plus that maximum): a graph is
    // bounded by the tier maximum, not by its node count times it.
    await graphDeadlineOwner(meta)
  );
}

/**
 * Why the job of a graph node is not cancelled on its own, or undefined for any other job. A graph is run, charged and
 * cancelled as one job: cancelling one node would leave its graph to the node's failure policy, so its owner cancels the
 * graph by its id instead.
 */
export function nodeJobCancelRefusal(data: { graphId?: string; graphNodeId?: string } | undefined): { graphId: string; detail: string } | undefined {
  if (!data?.graphId || !data.graphNodeId) return undefined;
  return {
    graphId: data.graphId,
    detail: `This job is node "${data.graphNodeId}" of the graph job "${data.graphId}", which is cancelled as a whole. Cancel "${data.graphId}" instead.`,
  };
}

/** Why a graph is cancelled when its ready nodes cannot be queued after its start failed. */
const START_FAILED_REASON = 'The job could not be queued';

/** Tries of the cancel of a graph whose start failed; the wait before a retry is GRAPH_START_CANCEL_RETRY_DELAY_MS times the try. */
export const GRAPH_START_CANCEL_ATTEMPTS = 3;
const GRAPH_START_CANCEL_RETRY_DELAY_MS = 100;

/** Cancels graph `graphId` with `cancel`, up to GRAPH_START_CANCEL_ATTEMPTS times while it throws; undefined when every try threw. */
async function cancelAfterFailedStart(graphId: string, cancel: (reason: string) => Promise<boolean>): Promise<boolean | undefined> {
  for (let attempt = 1; attempt <= GRAPH_START_CANCEL_ATTEMPTS; attempt++) {
    try {
      return await cancel(START_FAILED_REASON);
    } catch (err) {
      console.error(`[GraphScheduler] Graph ${graphId}, whose start failed, could not be cancelled (try ${attempt} of ${GRAPH_START_CANCEL_ATTEMPTS}):`, err);
      if (attempt < GRAPH_START_CANCEL_ATTEMPTS) await sleep(GRAPH_START_CANCEL_RETRY_DELAY_MS * attempt);
    }
  }
  return undefined;
}

/** What finishing a failed graph start needs of the scheduler that stored the graph. */
export interface StartingGraphScheduler extends Pick<IGraphScheduler, 'cancelGraph' | 'getGraphState'> {
  /** Queues the ready nodes of the stored graph `graphId` that its start left unqueued. */
  queueReadyNodes(graphId: string): Promise<unknown>;
  /** Cancels the queue job of one node; the node's resource-class queue when absent. */
  readonly cancelNode?: typeof cancelGraphNodeJob;
}

/**
 * Runs the end of the cancelled graph `state` again: an earlier try of its cancel recorded the end and lost its reply, so the
 * steps after the transition may not have run. The reservation is given back, the node jobs the cancel stopped are cancelled,
 * and the holds on the input files and the intermediate files end. Each step does nothing the second time, so an end that did
 * run is ended again to no effect.
 */
async function endCancelledStart(state: GraphExecutionState, cancelNode: StartingGraphScheduler['cancelNode']): Promise<void> {
  const { graphId } = state;
  const stopped = Object.values(state.nodes).filter((node) => node.status === 'cancelled');
  const graph = { graphId, reservationId: state.reservationId, inputKeys: graphInputKeys(state.graph.nodes), readState: async () => state };
  await finishGraph(graph, { outcome: { status: 'cancelled' }, reservation: { kind: 'rollback' } }, async () => {
    for (const node of stopped) await cancelGraphNodeJobOrLog(graphId, node.id, state.graph.nodes[node.id], START_FAILED_REASON, cancelNode);
  });
}

/**
 * Finishes the start of the stored graph `state` by queueing its ready nodes, which answers it as started, or cancels it when
 * they still cannot be queued, which gives its reservation back and answers it as not started. Only a failed start cancels a
 * graph whose id its client was never given, so a cancel refused because the graph is already cancelled met the end of an
 * earlier try whose reply was lost: that end is run again (`endCancelledStart`) and the graph answered as not started. A
 * graph that refuses the cancel because it completed or failed, or that still runs, is answered as started with the state read
 * after the cancel. A graph whose cancel throws on every try is answered as unknown: it may stay running with ready nodes
 * nobody queues, and its reservation keeps the provisional lease (docs/policy-decisions.md, entry 15).
 */
export async function queueReadyNodesOrCancel(state: GraphExecutionState, scheduler: StartingGraphScheduler): Promise<Recovery<GraphExecutionState>> {
  const { graphId } = state;
  try {
    await scheduler.queueReadyNodes(graphId);
    return { status: 'started', work: state };
  } catch (err) {
    console.error(`[GraphScheduler] The ready nodes of graph ${graphId} could not be queued after its start failed, so it is cancelled:`, err);
  }
  const cancelled = await cancelAfterFailedStart(graphId, (reason) => scheduler.cancelGraph(graphId, reason));
  if (cancelled === undefined) return RECOVERY_UNKNOWN;
  if (cancelled) return { status: 'not-started' };
  const ended = await scheduler.getGraphState(graphId).catch((err: unknown) => {
    console.error(`[GraphScheduler] Graph ${graphId} ended before its failed start was cancelled, but its state could not be read:`, err);
    return undefined;
  });
  if (ended?.status !== 'cancelled') return foundOrUnknown(ended);
  await endCancelledStart(ended, scheduler.cancelNode);
  return { status: 'not-started' };
}

/** Cancels the queue job of a graph node on the queue it was routed to. */
export async function cancelGraphNodeJob(
  graphId: string,
  nodeId: NodeId,
  node: GraphNode | undefined,
  reason: string
): Promise<boolean> {
  if (!node) {
    return false;
  }
  return getQueueForResourceClass(resolveNodeResourceClass(node)).cancelJob(graphNodeJobId(graphId, nodeId), reason);
}

/**
 * Cancels the queue job of node `nodeId` with `cancel`, and logs a cancel that fails, so one node job that cannot be
 * cancelled never leaves the others of its graph running. Answers false when the cancel failed.
 */
export async function cancelGraphNodeJobOrLog(
  graphId: string,
  nodeId: NodeId,
  node: GraphNode | undefined,
  reason: string,
  cancel: typeof cancelGraphNodeJob = cancelGraphNodeJob
): Promise<boolean> {
  try {
    await cancel(graphId, nodeId, node, reason);
    return true;
  } catch (err) {
    console.error(`[GraphScheduler] The job of node ${nodeId} of graph ${graphId} could not be cancelled:`, err);
    return false;
  }
}

async function graphDeadlineOwner(meta: GraphNodeJobMetadata): Promise<{ tier: string; notAfter?: number }> {
  const tier = await tierForOwner(meta.ownerUserId);
  return meta.createdAt === undefined ? { tier } : { tier, notAfter: meta.createdAt + tierMaxDeadlineMs(tier) };
}
