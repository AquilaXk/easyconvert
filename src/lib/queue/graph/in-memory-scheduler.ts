import type { JobGraph, NodeId } from './types';
import { getNodeInputs } from './validate-graph';
import type {
  GraphExecutionState,
  GraphMetadata,
  GraphNodeState,
  IGraphScheduler,
  NodeCompletionResult,
  NodeFailureResult,
} from './scheduler-types';
import { conversionQueue, getQueueForResourceClass } from '../conversion-queue';
import { resolveNodeResourceClass } from '../resource-class';
import { s3Storage } from '../../storage/s3-storage';
import { redisKeyStore } from '../../api-keys/redis-key-store';
import { webhookDispatcher } from '../../api-keys/webhook-dispatcher';

interface InternalGraphData {
  state: GraphExecutionState;
  remainingDeps: Map<NodeId, number>;
  children: Map<NodeId, NodeId[]>;
  accumulatedUnits: number;
}

export class InMemoryGraphScheduler implements IGraphScheduler {
  private readonly graphs = new Map<string, InternalGraphData>();

  async initGraph(
    graphId: string,
    graph: JobGraph,
    meta: GraphMetadata = {}
  ): Promise<GraphExecutionState> {
    if (this.graphs.has(graphId)) {
      throw new Error(`Graph already exists: ${graphId}`);
    }

    const nodeEntries = Object.entries(graph.nodes);
    const totalNodes = nodeEntries.length;
    const policy = graph.failurePolicy || 'fail_fast';
    const createdAt = meta.createdAt || Date.now();

    const remainingDeps = new Map<NodeId, number>();
    const children = new Map<NodeId, NodeId[]>();
    const nodesRecord: Record<NodeId, GraphNodeState> = {};

    for (const [nodeId, node] of nodeEntries) {
      children.set(nodeId, []);
      const inputs = getNodeInputs(node);
      remainingDeps.set(nodeId, inputs.length);

      const initialStatus = inputs.length === 0 ? 'waiting' : 'pending';
      nodesRecord[nodeId] = {
        id: nodeId,
        op: node.op,
        status: initialStatus,
        outputs: [],
      };
    }

    // Build children mappings
    for (const [nodeId, node] of nodeEntries) {
      const inputs = getNodeInputs(node);
      for (const inputNodeId of inputs) {
        children.get(inputNodeId)?.push(nodeId);
      }
    }

    const state: GraphExecutionState = {
      graphId,
      status: 'running',
      policy,
      ownerUserId: meta.ownerUserId,
      reservationId: meta.reservationId,
      webhookUrl: meta.webhookUrl,
      webhookSecret: meta.webhookSecret,
      createdAt,
      totalNodes,
      completedNodes: 0,
      failedNodes: 0,
      nodes: nodesRecord,
      graph,
    };

    this.graphs.set(graphId, { state, remainingDeps, children, accumulatedUnits: 0 });

    // Enqueue initial ready nodes (in-degree == 0)
    for (const [nodeId, nodeState] of Object.entries(nodesRecord)) {
      if (nodeState.status === 'waiting') {
        const node = graph.nodes[nodeId];
        await this.enqueueNodeJob(graphId, nodeId, node, meta);
      }
    }

    return JSON.parse(JSON.stringify(state));
  }

  async onNodeStarted(graphId: string, nodeId: NodeId): Promise<void> {
    const data = this.graphs.get(graphId);
    if (!data) return;
    const nodeState = data.state.nodes[nodeId];
    if (nodeState && nodeState.status === 'waiting') {
      nodeState.status = 'active';
      nodeState.startedAt = Date.now();
    }
  }

  async onNodeCompleted(
    graphId: string,
    nodeId: NodeId,
    outputs: string[],
    actualUnits: number = 1
  ): Promise<NodeCompletionResult> {
    const data = this.graphs.get(graphId);
    if (!data || data.state.status !== 'running') {
      return {
        graphCompleted: false,
        graphStatus: data?.state.status || 'failed',
        readyNodeIds: [],
      };
    }

    const nodeState = data.state.nodes[nodeId];
    if (!nodeState || nodeState.status === 'completed') {
      return {
        graphCompleted: false,
        graphStatus: data.state.status,
        readyNodeIds: [],
      };
    }

    nodeState.status = 'completed';
    nodeState.finishedAt = Date.now();
    nodeState.outputs = [...outputs];
    data.state.completedNodes++;
    data.accumulatedUnits += actualUnits;

    const readyNodeIds: NodeId[] = [];
    const childList = data.children.get(nodeId) || [];

    for (const childId of childList) {
      const current = (data.remainingDeps.get(childId) || 0) - 1;
      data.remainingDeps.set(childId, current);

      if (current === 0) {
        const childState = data.state.nodes[childId];
        if (childState && childState.status === 'pending') {
          childState.status = 'waiting';
          readyNodeIds.push(childId);
          const childNode = data.state.graph.nodes[childId];
          await this.enqueueNodeJob(graphId, childId, childNode, {
            ownerUserId: data.state.ownerUserId,
            reservationId: data.state.reservationId,
            webhookUrl: data.state.webhookUrl,
            webhookSecret: data.state.webhookSecret,
          });
        }
      }
    }

    const isComplete =
      data.state.completedNodes >= data.state.totalNodes ||
      Object.values(data.state.nodes).every(
        (n) => n.status === 'completed' || n.status === 'failed' || n.status === 'skipped'
      );
    if (isComplete) {
      data.state.status = 'completed';
      data.state.finishedAt = Date.now();
      await this.cleanupIntermediates(graphId);
      await this.handleGraphCompletionSideEffects(data.state, data.accumulatedUnits);
    }

    return {
      graphCompleted: isComplete,
      graphStatus: data.state.status,
      readyNodeIds,
    };
  }

  async onNodeFailed(
    graphId: string,
    nodeId: NodeId,
    error: string
  ): Promise<NodeFailureResult> {
    const data = this.graphs.get(graphId);
    if (!data) {
      return {
        graphFailed: true,
        graphStatus: 'failed',
        cancelledJobIds: [],
        skippedNodeIds: [],
      };
    }

    const nodeState = data.state.nodes[nodeId];
    if (nodeState) {
      nodeState.status = 'failed';
      nodeState.error = error;
      nodeState.finishedAt = Date.now();
    }
    data.state.failedNodes++;

    if (data.state.policy === 'fail_fast') {
      data.state.status = 'failed';
      data.state.failedReason = error;
      data.state.finishedAt = Date.now();

      const cancelledJobIds: string[] = [];
      for (const [nid, ns] of Object.entries(data.state.nodes)) {
        if (ns.status !== 'completed' && ns.status !== 'failed' && ns.status !== 'cancelled') {
          ns.status = 'cancelled';
          const jid = `${graphId}:${nid}`;
          await conversionQueue.cancelJob(jid, `Graph failed due to node ${nodeId}`);
          cancelledJobIds.push(jid);
        }
      }

      await this.cleanupIntermediates(graphId);
      await this.handleGraphFailureSideEffects(data.state, error);

      return {
        graphFailed: true,
        graphStatus: 'failed',
        cancelledJobIds,
        skippedNodeIds: [],
      };
    } else {
      // Continue policy: cascade skip downstream descendants of failed node
      const skippedNodeIds: NodeId[] = [];
      const queue: NodeId[] = [nodeId];
      const visited = new Set<NodeId>([nodeId]);

      while (queue.length > 0) {
        const curr = queue.shift()!;
        const children = data.children.get(curr) || [];
        for (const childId of children) {
          if (!visited.has(childId)) {
            visited.add(childId);
            queue.push(childId);

            const childState = data.state.nodes[childId];
            if (
              childState &&
              childState.status !== 'completed' &&
              childState.status !== 'failed' &&
              childState.status !== 'skipped'
            ) {
              childState.status = 'skipped';
              skippedNodeIds.push(childId);
              await conversionQueue.cancelJob(
                `${graphId}:${childId}`,
                `Skipped because upstream node ${nodeId} failed`
              );
            }
          }
        }
      }

      // Check if all remaining nodes are terminal
      const allTerminal = Object.values(data.state.nodes).every(
        (n) => n.status === 'completed' || n.status === 'failed' || n.status === 'skipped'
      );

      if (allTerminal) {
        data.state.status = 'completed';
        data.state.finishedAt = Date.now();
        await this.cleanupIntermediates(graphId);
        await this.handleGraphCompletionSideEffects(data.state, 1);
      }

      return {
        graphFailed: false,
        graphStatus: data.state.status,
        cancelledJobIds: [],
        skippedNodeIds,
      };
    }
  }

  async getGraphState(graphId: string): Promise<GraphExecutionState | undefined> {
    const data = this.graphs.get(graphId);
    if (!data) return undefined;
    return JSON.parse(JSON.stringify(data.state));
  }

  async cancelGraph(graphId: string, reason: string = 'Cancelled by user'): Promise<boolean> {
    const data = this.graphs.get(graphId);
    if (!data) return false;
    if (
      data.state.status === 'completed' ||
      data.state.status === 'failed' ||
      data.state.status === 'cancelled'
    ) {
      return false;
    }

    data.state.status = 'cancelled';
    data.state.failedReason = reason;
    data.state.finishedAt = Date.now();

    for (const [nid, ns] of Object.entries(data.state.nodes)) {
      if (ns.status !== 'completed' && ns.status !== 'failed' && ns.status !== 'skipped') {
        ns.status = 'cancelled';
        await conversionQueue.cancelJob(`${graphId}:${nid}`, reason);
      }
    }

    await this.cleanupIntermediates(graphId);
    if (data.state.reservationId) {
      await redisKeyStore.rollbackQuota(data.state.reservationId).catch(() => {});
    }

    return true;
  }

  async getNodeOutputs(graphId: string, nodeIds: NodeId | NodeId[]): Promise<string[]> {
    const data = this.graphs.get(graphId);
    if (!data) return [];

    const targetIds = Array.isArray(nodeIds) ? nodeIds : [nodeIds];
    const outputs: string[] = [];

    for (const id of targetIds) {
      const nodeOutputs = data.state.nodes[id]?.outputs || [];
      outputs.push(...nodeOutputs);
    }

    return outputs;
  }

  async cleanupIntermediates(graphId: string): Promise<number> {
    const prefix = `intermediate/${graphId}/`;
    if (typeof s3Storage.deleteByPrefix === 'function') {
      return s3Storage.deleteByPrefix(prefix);
    }
    return 0;
  }

  private async enqueueNodeJob(
    graphId: string,
    nodeId: NodeId,
    node: any,
    meta: GraphMetadata
  ): Promise<void> {
    const inputNodeIds = getNodeInputs(node);
    const inputArtifacts = await this.getNodeOutputs(graphId, inputNodeIds);
    const resClass = resolveNodeResourceClass(node);
    const targetQueue = getQueueForResourceClass(resClass);

    await targetQueue.add(
      'graph-node',
      {
        jobId: `${graphId}:${nodeId}`,
        originalFilename: meta.originalFilename || `${nodeId}.bin`,
        sourceFormat: 'bin',
        targetFormat: node.targetFormat || 'bin',
        fileSize: 0,
        options: node.options || {},
        userId: meta.ownerUserId,
        reservationId: meta.reservationId,
        graphId,
        graphNodeId: nodeId,
        graphNode: node,
        inputArtifacts,
        resourceClass: resClass,
      },
      {
        jobId: `${graphId}:${nodeId}`,
        attempts: 3,
      }
    );
  }

  private async handleGraphCompletionSideEffects(
    state: GraphExecutionState,
    actualUnits: number
  ): Promise<void> {
    if (state.reservationId) {
      await redisKeyStore.settleQuota(state.reservationId, actualUnits).catch(() => {});
    }

    if (state.webhookUrl) {
      const terminalResult = {
        jobId: state.graphId,
        status: 'completed',
        graphId: state.graphId,
        nodes: state.nodes,
      };
      if (state.webhookSecret) {
        await webhookDispatcher
          .dispatch(state.webhookUrl, 'graph.completed', terminalResult, state.webhookSecret, {
            ownerUserId: state.ownerUserId,
          })
          .catch(() => {});
      }
    }
  }

  private async handleGraphFailureSideEffects(
    state: GraphExecutionState,
    error: string
  ): Promise<void> {
    if (state.reservationId) {
      await redisKeyStore.rollbackQuota(state.reservationId).catch(() => {});
    }

    if (state.webhookUrl && state.webhookSecret) {
      await webhookDispatcher
        .dispatch(
          state.webhookUrl,
          'graph.failed',
          {
            jobId: state.graphId,
            status: 'failed',
            error,
            graphId: state.graphId,
            nodes: state.nodes,
          },
          state.webhookSecret,
          { ownerUserId: state.ownerUserId }
        )
        .catch(() => {});
    }
  }
}
