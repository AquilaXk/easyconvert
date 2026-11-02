import type { JobGraph, NodeId } from './types';
import { getNodeInputs } from './validate-graph';
import type {
  GraphExecutionState,
  GraphMetadata,
  GraphNodeJobMetadata,
  GraphNodeState,
  GraphStatus,
  IGraphScheduler,
  NodeCompletionResult,
  NodeExecutionStatus,
  NodeFailureResult,
} from './scheduler-types';
import { cancelGraphNodeJobOrLog, enqueueGraphNodeJob, graphNodeJobId, graphNodeJobMetadata, queueReadyNodesOrCancel } from './node-jobs';
import type { Recovery } from '../hand-off';
import { graphInputKeys } from './input-cleanup';
import { maskTaskRecords, sealJobGraph } from './sealed-nodes';
import { maskServerText } from '../../security/server-paths';
import { finishGraph, type EndedGraph, type GraphEnd } from './graph-end';

/** Node states from which a node can still complete or fail. */
const RUNNABLE_NODE_STATUSES: ReadonlySet<NodeExecutionStatus> = new Set<NodeExecutionStatus>(['waiting', 'active']);

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
    submittedGraph: JobGraph,
    meta: GraphMetadata = {}
  ): Promise<GraphExecutionState> {
    if (this.graphs.has(graphId)) {
      throw new Error(`Graph already exists: ${graphId}`);
    }

    // Bearer secrets are sealed before anything is stored or queued; the caller's graph is untouched.
    const graph = sealJobGraph(submittedGraph, (nodeId) => graphNodeJobId(graphId, nodeId));
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
      originalFilename: meta.originalFilename,
      sourceFormat: meta.sourceFormat,
      targetFormat: meta.targetFormat,
      tasks: maskTaskRecords(meta.tasks),
      createdAt,
      totalNodes,
      completedNodes: 0,
      failedNodes: 0,
      nodes: nodesRecord,
      graph,
    };

    this.graphs.set(graphId, { state, remainingDeps, children, accumulatedUnits: 0 });
    await this.enqueueWaitingNodes(state);
    return JSON.parse(JSON.stringify(state));
  }

  /** Queues the job of every node of `state` that waits for one; the queue keeps one job per id, so a repeat adds none. */
  private async enqueueWaitingNodes(state: GraphExecutionState): Promise<void> {
    for (const nodeState of Object.values(state.nodes)) {
      if (nodeState.status === 'waiting') {
        await this.enqueueNodeJob(state.graphId, nodeState.id, state.graph.nodes[nodeState.id], graphNodeJobMetadata(state));
      }
    }
  }

  async recoverStart(graphId: string): Promise<Recovery<GraphExecutionState>> {
    const data = this.graphs.get(graphId);
    // In this process no write lands after its start returned or threw, so a graph that is not here never started.
    if (!data) return { status: 'not-started' };
    return queueReadyNodesOrCancel(
      JSON.parse(JSON.stringify(data.state)),
      () => this.enqueueWaitingNodes(data.state),
      (reason) => this.cancelGraph(graphId, reason),
      () => this.getGraphState(graphId)
    );
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
    // A node completes once: a repeated completion leaves counters and child in-degrees unchanged.
    if (!nodeState || !RUNNABLE_NODE_STATUSES.has(nodeState.status)) {
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
          await this.enqueueNodeJob(graphId, childId, childNode, graphNodeJobMetadata(data.state));
        }
      }
    }

    const graphCompleted = allNodesEnded(data.state) && recordEnd(data.state, 'completed');
    if (graphCompleted) await finishGraph(endedGraph(data), completedEnd(data));

    return {
      graphCompleted,
      graphStatus: data.state.status,
      readyNodeIds,
    };
  }

  async onNodeFailed(
    graphId: string,
    nodeId: NodeId,
    reportedError: string
  ): Promise<NodeFailureResult> {
    // The reason is stored, returned by the job API and sent in webhooks: credentials and server paths are masked here, on write.
    const error = maskServerText(reportedError);
    const data = this.graphs.get(graphId);
    const nodeState = data?.state.nodes[nodeId];
    if (!data || data.state.status !== 'running' || !nodeState || !RUNNABLE_NODE_STATUSES.has(nodeState.status)) {
      return {
        graphFailed: false,
        graphStatus: data?.state.status || 'failed',
        cancelledJobIds: [],
        skippedNodeIds: [],
      };
    }

    nodeState.status = 'failed';
    nodeState.error = error;
    nodeState.finishedAt = Date.now();
    data.state.failedNodes++;

    if (data.state.policy === 'fail_fast') {
      recordEnd(data.state, 'failed', error);
      const stopped = cancelUnended(data.state, ['completed', 'failed', 'cancelled']);
      const cancelledJobIds = await finishGraph(endedGraph(data), { outcome: { status: 'failed', error }, reservation: { kind: 'rollback' } }, async () => {
        const cancelled: string[] = [];
        for (const nid of stopped) {
          if (await cancelGraphNodeJobOrLog(graphId, nid, data.state.graph.nodes[nid], `Graph failed due to node ${nodeId}`)) cancelled.push(graphNodeJobId(graphId, nid));
        }
        return cancelled;
      });

      return {
        graphFailed: true,
        graphStatus: 'failed',
        cancelledJobIds: cancelledJobIds ?? [],
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
              await cancelGraphNodeJobOrLog(graphId, childId, data.state.graph.nodes[childId], `Skipped because upstream node ${nodeId} failed`);
            }
          }
        }
      }

      // The cancels above awaited, so another node may have ended the graph meanwhile: recordEnd acts only on a running graph.
      if (allNodesEnded(data.state) && recordEnd(data.state, 'completed')) await finishGraph(endedGraph(data), completedEnd(data));

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
    if (!data || !recordEnd(data.state, 'cancelled', reason)) return false;
    const stopped = cancelUnended(data.state, ['completed', 'failed', 'skipped']);
    await finishGraph(endedGraph(data), { outcome: { status: 'cancelled' }, reservation: { kind: 'rollback' } }, async () => {
      for (const nid of stopped) await cancelGraphNodeJobOrLog(graphId, nid, data.state.graph.nodes[nid], reason);
    });
    return true;
  }

  async getNodeOutputs(graphId: string, nodeIds: NodeId | NodeId[]): Promise<string[]> {
    const data = this.graphs.get(graphId);
    if (!data) return [];

    const targetIds = Array.isArray(nodeIds) ? nodeIds : [nodeIds];
    return [...new Set(targetIds.flatMap((id) => data.state.nodes[id]?.outputs ?? []))];
  }

  private async enqueueNodeJob(
    graphId: string,
    nodeId: NodeId,
    node: any,
    meta: GraphNodeJobMetadata
  ): Promise<void> {
    const inputArtifacts = await this.getNodeOutputs(graphId, getNodeInputs(node));
    await enqueueGraphNodeJob(graphId, nodeId, node, meta, inputArtifacts);
  }
}

/** The graph of `data` whose end its scheduler recorded. */
function endedGraph(data: InternalGraphData): EndedGraph {
  return {
    graphId: data.state.graphId,
    reservationId: data.state.reservationId,
    inputKeys: graphInputKeys(data.state.graph.nodes),
    readState: async () => data.state,
  };
}

/** Marks every node of the ended `state` whose status is not in `ended` cancelled, and answers their ids. */
function cancelUnended(state: GraphExecutionState, ended: readonly NodeExecutionStatus[]): NodeId[] {
  const stopped = Object.values(state.nodes).filter((node) => !ended.includes(node.status));
  for (const node of stopped) node.status = 'cancelled';
  return stopped.map((node) => node.id);
}

/** The end of the completed graph of `data`, settled to the units its nodes charged. */
function completedEnd(data: InternalGraphData): GraphEnd {
  return { outcome: { status: 'completed' }, reservation: { kind: 'settle', units: data.accumulatedUnits } };
}

/** Whether every node of `state` ended, by completing, failing or being skipped. */
function allNodesEnded(state: GraphExecutionState): boolean {
  return Object.values(state.nodes).every((n) => n.status === 'completed' || n.status === 'failed' || n.status === 'skipped');
}

/**
 * Moves a running graph to the terminal `status`, before any await of the caller, and answers whether it did: a graph that
 * already ended is left alone, so of two nodes that end it at once, only the first settles its reservation.
 */
function recordEnd(state: GraphExecutionState, status: Exclude<GraphStatus, 'running'>, failedReason?: string): boolean {
  if (state.status !== 'running') return false;
  state.status = status;
  state.finishedAt = Date.now();
  if (failedReason !== undefined) state.failedReason = failedReason;
  return true;
}
