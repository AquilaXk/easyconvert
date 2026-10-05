import Redis from 'ioredis';
import type { GraphNode, JobGraph, NodeId } from './types';
import { getNodeInputs } from './validate-graph';
import type {
  GraphExecutionState,
  GraphMetadata,
  GraphNodeState,
  IGraphScheduler,
  NodeCompletionResult,
  NodeFailureResult,
} from './scheduler-types';
import {
  INIT_GRAPH_LUA_SCRIPT,
  NODE_STARTED_LUA_SCRIPT,
  NODE_COMPLETED_LUA_SCRIPT,
  NODE_FAILED_LUA_SCRIPT,
  CANCEL_GRAPH_LUA_SCRIPT,
} from './lua-scripts';
import { cancelGraphNodeJob, enqueueGraphNodeJob, graphNodeJobId } from './node-jobs';
import { maskTaskRecords, sealJobGraph } from './sealed-nodes';
import { DEFAULT_QUEUE_KEY_PREFIX } from '../bullmq-engine';
import { s3Storage } from '../../storage/s3-storage';
import { redisKeyStore } from '../../api-keys/redis-key-store';
import { webhookDispatcher } from '../../api-keys/webhook-dispatcher';

export interface RedisGraphSchedulerOptions {
  redisClient: Redis;
  /** Defaults to the queue engine prefix so graph and queue keys share one namespace. */
  keyPrefix?: string;
  /** Moves a ready node onto a queue. Defaults to the node's resource-class queue. */
  enqueueNode?: typeof enqueueGraphNodeJob;
  /** Cancels a node's queue job. Defaults to the node's resource-class queue. */
  cancelNode?: typeof cancelGraphNodeJob;
}

/** Graph hash fields that hold the submission metadata needed to enqueue nodes later. */
const META_FIELDS = ['owner', 'reservationId', 'webhookUrl', 'webhookSecret', 'originalFilename', 'sourceStorageKey'] as const;

function toArray<T>(value: unknown): T[] {
  // cjson encodes an empty table as `{}`; treat it as an empty list.
  return Array.isArray(value) ? (value as T[]) : [];
}

function parseJsonArray<T>(raw: unknown): T[] {
  try {
    return toArray<T>(JSON.parse(String(raw ?? '[]')));
  } catch {
    return [];
  }
}

export class RedisGraphScheduler implements IGraphScheduler {
  private readonly redisClient: Redis;
  private readonly keyPrefix: string;
  private readonly enqueueNode: typeof enqueueGraphNodeJob;
  private readonly cancelNode: typeof cancelGraphNodeJob;

  constructor(options: RedisGraphSchedulerOptions) {
    this.redisClient = options.redisClient;
    this.keyPrefix = options.keyPrefix ?? DEFAULT_QUEUE_KEY_PREFIX;
    this.enqueueNode = options.enqueueNode ?? enqueueGraphNodeJob;
    this.cancelNode = options.cancelNode ?? cancelGraphNodeJob;
  }

  /** Keys of one graph; all carry the `{gid}` hash tag so a script stays in one cluster slot. */
  graphKeys(gid: string) {
    const base = `${this.keyPrefix}graph:{${gid}}`;
    return {
      graph: base,
      deps: `${base}:deps`,
      children: `${base}:children`,
      nodes: `${base}:nodes`,
      outputs: `${base}:outputs`,
      outbox: `${base}:outbox`,
    };
  }

  async initGraph(graphId: string, graph: JobGraph, meta: GraphMetadata = {}): Promise<GraphExecutionState> {
    const k = this.graphKeys(graphId);
    // Bearer secrets are sealed before anything reaches Redis or a queue; the caller's graph is untouched.
    const sealedGraph = sealJobGraph(graph, (nodeId) => graphNodeJobId(graphId, nodeId));
    const entries = Object.entries(sealedGraph.nodes);
    const children = new Map<NodeId, NodeId[]>(entries.map(([id]) => [id, []]));
    for (const [id, node] of entries) {
      for (const input of getNodeInputs(node)) children.get(input)?.push(id);
    }
    const nodes = entries.map(([id, node]) => ({
      id,
      op: node.op,
      inDegree: getNodeInputs(node).length,
      children: children.get(id) ?? [],
    }));
    const createdAt = meta.createdAt ?? Date.now();
    const fields: Record<string, string> = {
      policy: graph.failurePolicy || 'fail_fast',
      owner: meta.ownerUserId || '',
      reservationId: meta.reservationId || '',
      webhookUrl: meta.webhookUrl || '',
      webhookSecret: meta.webhookSecret || '',
      originalFilename: meta.originalFilename || '',
      sourceStorageKey: meta.sourceStorageKey || '',
      sourceFormat: meta.sourceFormat || '',
      targetFormat: meta.targetFormat || '',
      tasks: meta.tasks ? JSON.stringify(maskTaskRecords(meta.tasks)) : '',
      createdAt: String(createdAt),
      totalNodes: String(entries.length),
      graph: JSON.stringify(sealedGraph),
    };

    await this.redisClient.eval(
      INIT_GRAPH_LUA_SCRIPT,
      6,
      k.graph,
      k.deps,
      k.children,
      k.nodes,
      k.outputs,
      k.outbox,
      graphId,
      JSON.stringify(fields),
      JSON.stringify(nodes),
      String(createdAt)
    );
    await this.drainOutbox(graphId);

    const state = await this.getGraphState(graphId);
    if (!state) {
      throw new Error(`Failed to retrieve newly initialized graph: ${graphId}`);
    }
    return state;
  }

  /**
   * Moves ready nodes from the graph outbox onto their queues. An entry leaves the outbox only
   * after its enqueue succeeded; enqueue is idempotent by job ID, so a replay after a crash is safe.
   */
  async drainOutbox(graphId: string): Promise<number> {
    const k = this.graphKeys(graphId);
    const ready = await this.redisClient.lrange(k.outbox, 0, -1);
    if (ready.length === 0) {
      return 0;
    }
    const [graphJson, ...metaValues] = await this.redisClient.hmget(k.graph, 'graph', ...META_FIELDS);
    const graph = JSON.parse(graphJson || '{"nodes":{}}') as JobGraph;
    const meta = Object.fromEntries(META_FIELDS.map((f, i) => [f, metaValues[i] || undefined])) as Record<
      (typeof META_FIELDS)[number],
      string | undefined
    >;
    const graphMeta: GraphMetadata = {
      ownerUserId: meta.owner,
      reservationId: meta.reservationId,
      originalFilename: meta.originalFilename,
      sourceStorageKey: meta.sourceStorageKey,
    };

    for (const nodeId of ready) {
      const node = graph.nodes[nodeId];
      if (node) {
        const inputArtifacts = await this.getNodeOutputs(graphId, getNodeInputs(node));
        await this.enqueueNode(graphId, nodeId, node, graphMeta, inputArtifacts);
      }
      await this.redisClient.lrem(k.outbox, 1, nodeId);
    }
    return ready.length;
  }

  async onNodeStarted(graphId: string, nodeId: NodeId): Promise<void> {
    const k = this.graphKeys(graphId);
    await this.redisClient.eval(NODE_STARTED_LUA_SCRIPT, 2, k.graph, k.nodes, nodeId, String(Date.now()));
  }

  async onNodeCompleted(
    graphId: string,
    nodeId: NodeId,
    outputs: string[],
    actualUnits: number = 1
  ): Promise<NodeCompletionResult> {
    const k = this.graphKeys(graphId);
    const raw = (await this.redisClient.eval(
      NODE_COMPLETED_LUA_SCRIPT,
      6,
      k.graph,
      k.deps,
      k.children,
      k.nodes,
      k.outputs,
      k.outbox,
      nodeId,
      JSON.stringify(outputs),
      String(Date.now()),
      String(actualUnits)
    )) as [number, string, string, string];

    const applied = Number(raw[0]) === 1;
    const graphStatus = (raw[1] || 'running') as GraphExecutionState['status'];
    const readyNodeIds = parseJsonArray<NodeId>(raw[2]);
    await this.drainOutbox(graphId);

    const graphCompleted = applied && graphStatus === 'completed';
    if (graphCompleted) {
      await this.cleanupIntermediates(graphId);
      const state = await this.getGraphState(graphId);
      if (state?.reservationId) {
        await redisKeyStore.settleQuota(state.reservationId, Number(raw[3] || actualUnits)).catch(() => {});
      }
      if (state?.webhookUrl && state.webhookSecret) {
        await webhookDispatcher
          .dispatch(
            state.webhookUrl,
            'graph.completed',
            { jobId: graphId, status: 'completed', graphId, nodes: state.nodes },
            state.webhookSecret,
            { ownerUserId: state.ownerUserId }
          )
          .catch(() => {});
      }
    }

    return { graphCompleted, graphStatus, readyNodeIds };
  }

  async onNodeFailed(graphId: string, nodeId: NodeId, error: string): Promise<NodeFailureResult> {
    const k = this.graphKeys(graphId);
    const raw = (await this.redisClient.eval(
      NODE_FAILED_LUA_SCRIPT,
      4,
      k.graph,
      k.children,
      k.nodes,
      k.outbox,
      nodeId,
      error,
      String(Date.now())
    )) as [number, string, string, string];

    const applied = Number(raw[0]) === 1;
    const graphStatus = (raw[1] || 'failed') as GraphExecutionState['status'];
    const cancelledNodeIds = parseJsonArray<NodeId>(raw[2]);
    const skippedNodeIds = parseJsonArray<NodeId>(raw[3]);
    const state = await this.getGraphState(graphId);
    const reason = `Graph failed due to node ${nodeId}`;
    for (const nid of [...cancelledNodeIds, ...skippedNodeIds]) {
      await this.cancelNode(graphId, nid, state?.graph.nodes[nid], reason).catch(() => false);
    }

    const graphFailed = applied && graphStatus === 'failed';
    if (graphFailed) {
      await this.cleanupIntermediates(graphId);
      if (state?.reservationId) {
        await redisKeyStore.rollbackQuota(state.reservationId).catch(() => {});
      }
      if (state?.webhookUrl && state.webhookSecret) {
        await webhookDispatcher
          .dispatch(
            state.webhookUrl,
            'graph.failed',
            { jobId: graphId, status: 'failed', error, graphId, nodes: state.nodes },
            state.webhookSecret,
            { ownerUserId: state.ownerUserId }
          )
          .catch(() => {});
      }
    }

    return {
      graphFailed,
      graphStatus,
      cancelledJobIds: cancelledNodeIds.map((nid) => `${graphId}:${nid}`),
      skippedNodeIds,
    };
  }

  async getGraphState(graphId: string): Promise<GraphExecutionState | undefined> {
    const k = this.graphKeys(graphId);
    const rawGraph = await this.redisClient.hgetall(k.graph);
    if (!rawGraph || Object.keys(rawGraph).length === 0) {
      return undefined;
    }

    const rawNodes = await this.redisClient.hgetall(k.nodes);
    const nodes: Record<NodeId, GraphNodeState> = {};
    for (const [nid, json] of Object.entries(rawNodes)) {
      const parsed = JSON.parse(json) as GraphNodeState;
      nodes[nid] = { ...parsed, outputs: toArray<string>(parsed.outputs) };
    }

    return {
      graphId: rawGraph.graphId || graphId,
      status: (rawGraph.status || 'running') as GraphExecutionState['status'],
      policy: (rawGraph.policy || 'fail_fast') as GraphExecutionState['policy'],
      ownerUserId: rawGraph.owner || undefined,
      reservationId: rawGraph.reservationId || undefined,
      webhookUrl: rawGraph.webhookUrl || undefined,
      webhookSecret: rawGraph.webhookSecret || undefined,
      originalFilename: rawGraph.originalFilename || undefined,
      sourceFormat: rawGraph.sourceFormat || undefined,
      targetFormat: rawGraph.targetFormat || undefined,
      tasks: rawGraph.tasks ? (JSON.parse(rawGraph.tasks) as unknown[]) : undefined,
      createdAt: Number(rawGraph.createdAt || 0),
      finishedAt: rawGraph.finishedOn ? Number(rawGraph.finishedOn) : undefined,
      failedReason: rawGraph.failedReason || undefined,
      totalNodes: Number(rawGraph.totalNodes || 0),
      completedNodes: Number(rawGraph.completedNodes || 0),
      failedNodes: Number(rawGraph.failedNodes || 0),
      nodes,
      graph: JSON.parse(rawGraph.graph || '{"nodes":{}}') as JobGraph,
    };
  }

  async cancelGraph(graphId: string, reason: string = 'Cancelled by user'): Promise<boolean> {
    const k = this.graphKeys(graphId);
    const raw = (await this.redisClient.eval(
      CANCEL_GRAPH_LUA_SCRIPT,
      3,
      k.graph,
      k.nodes,
      k.outbox,
      reason,
      String(Date.now())
    )) as [number, string, string];

    if (Number(raw[0]) !== 1) {
      return false;
    }
    const state = await this.getGraphState(graphId);
    for (const nid of parseJsonArray<NodeId>(raw[2])) {
      await this.cancelNode(graphId, nid, state?.graph.nodes[nid] as GraphNode | undefined, reason).catch(() => false);
    }
    await this.cleanupIntermediates(graphId);
    if (state?.reservationId) {
      await redisKeyStore.rollbackQuota(state.reservationId).catch(() => {});
    }
    return true;
  }

  async getNodeOutputs(graphId: string, nodeIds: NodeId | NodeId[]): Promise<string[]> {
    const targetIds = Array.isArray(nodeIds) ? nodeIds : [nodeIds];
    if (targetIds.length === 0) return [];
    const values = await this.redisClient.hmget(this.graphKeys(graphId).outputs, ...targetIds);
    return values.flatMap((v) => (v ? parseJsonArray<string>(v) : []));
  }

  async cleanupIntermediates(graphId: string): Promise<number> {
    const prefix = `intermediate/${graphId}/`;
    if (typeof s3Storage.deleteByPrefix === 'function') {
      return s3Storage.deleteByPrefix(prefix);
    }
    return 0;
  }
}
