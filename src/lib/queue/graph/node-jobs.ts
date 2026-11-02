import type { GraphNodeJobMetadata } from './scheduler-types';
import type { GraphNode, NodeId } from './types';
import { getQueueForResourceClass } from '../conversion-queue';
import { enqueueConversionJob } from '../enqueue';
import { tierForOwner } from '../page-cap';
import { tierMaxDeadlineMs } from '../job-deadline';
import { resolveNodeResourceClass } from '../resource-class';
import { sealGraphNode } from './sealed-nodes';

/** Attempts per graph node job; the node fails the graph only after the last one. */
export const GRAPH_NODE_JOB_ATTEMPTS = 3;

/** Queue job ID of a graph node. Deterministic so a repeated enqueue is a no-op. */
export function graphNodeJobId(graphId: string, nodeId: NodeId): string {
  return `${graphId}:${nodeId}`;
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

async function graphDeadlineOwner(meta: GraphNodeJobMetadata): Promise<{ tier: string; notAfter?: number }> {
  const tier = await tierForOwner(meta.ownerUserId);
  return meta.createdAt === undefined ? { tier } : { tier, notAfter: meta.createdAt + tierMaxDeadlineMs(tier) };
}
