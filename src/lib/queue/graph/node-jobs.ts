import type { GraphMetadata } from './scheduler-types';
import type { GraphNode, NodeId } from './types';
import { getQueueForResourceClass } from '../conversion-queue';
import { enqueueConversionJob } from '../enqueue';
import { tierForOwner } from '../page-cap';
import { resolveNodeResourceClass } from '../resource-class';
import { sealGraphNode } from './sealed-nodes';

/** Attempts per graph node job; the node fails the graph only after the last one. */
export const GRAPH_NODE_JOB_ATTEMPTS = 3;

/** Queue job ID of a graph node. Deterministic so a repeated enqueue is a no-op. */
export function graphNodeJobId(graphId: string, nodeId: NodeId): string {
  return `${graphId}:${nodeId}`;
}

/**
 * Enqueues a ready graph node on the queue of its resource class. The engine ignores a second
 * add with the same job ID, so replaying an outbox entry after a crash never runs a node twice.
 */
export async function enqueueGraphNodeJob(
  graphId: string,
  nodeId: NodeId,
  node: GraphNode,
  meta: GraphMetadata,
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
      reservationId: meta.reservationId,
      graphId,
      graphNodeId: nodeId,
      // Fail closed: whatever path got a node here, its secrets are sealed before the queue sees it.
      graphNode: sealGraphNode(node, jobId),
      inputArtifacts,
      resourceClass,
    },
    { jobId, attempts: GRAPH_NODE_JOB_ATTEMPTS },
    // The size of a node's inputs is not known until it runs, so it gets the deadline maximum of its owner's tier.
    { tier: await tierForOwner(meta.ownerUserId) }
  );
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
