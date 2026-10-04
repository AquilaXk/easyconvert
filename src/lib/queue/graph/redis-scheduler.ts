import Redis from 'ioredis';
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
import {
  INIT_GRAPH_LUA_SCRIPT,
  NODE_STARTED_LUA_SCRIPT,
  NODE_COMPLETED_LUA_SCRIPT,
  NODE_FAILED_LUA_SCRIPT,
  CANCEL_GRAPH_LUA_SCRIPT,
} from './lua-scripts';
import { s3Storage } from '../../storage/s3-storage';
import { redisKeyStore } from '../../api-keys/redis-key-store';
import { webhookDispatcher } from '../../api-keys/webhook-dispatcher';

export interface RedisGraphSchedulerOptions {
  redisClient: Redis;
  keyPrefix?: string;
  queueName?: string;
}

export class RedisGraphScheduler implements IGraphScheduler {
  private readonly redisClient: Redis;
  private readonly keyPrefix: string;
  private readonly queueName: string;

  constructor(options: RedisGraphSchedulerOptions) {
    this.redisClient = options.redisClient;
    this.keyPrefix = options.keyPrefix || 'bull:';
    this.queueName = options.queueName || 'easyconvert-jobs';
  }

  private graphKey(gid: string): string {
    return `${this.keyPrefix}graph:{${gid}}`;
  }

  private depsKey(gid: string): string {
    return `${this.keyPrefix}graph:{${gid}}:deps`;
  }

  private childrenKey(gid: string): string {
    return `${this.keyPrefix}graph:{${gid}}:children`;
  }

  private nodesKey(gid: string): string {
    return `${this.keyPrefix}graph:{${gid}}:nodes`;
  }

  private outputsKey(gid: string): string {
    return `${this.keyPrefix}graph:{${gid}}:outputs`;
  }

  private get waitingKey(): string {
    return `${this.keyPrefix}{${this.queueName}}:waiting`;
  }

  private get jobKeyPrefix(): string {
    return `${this.keyPrefix}{${this.queueName}}:job:`;
  }

  async initGraph(
    graphId: string,
    graph: JobGraph,
    meta: GraphMetadata = {}
  ): Promise<GraphExecutionState> {
    const nodeEntries = Object.entries(graph.nodes);
    const totalNodes = nodeEntries.length;
    const policy = graph.failurePolicy || 'fail_fast';
    const createdAt = meta.createdAt || Date.now();

    const childrenMap = new Map<NodeId, NodeId[]>();
    for (const [nodeId] of nodeEntries) {
      childrenMap.set(nodeId, []);
    }
    for (const [nodeId, node] of nodeEntries) {
      const inputs = getNodeInputs(node);
      for (const inputNodeId of inputs) {
        childrenMap.get(inputNodeId)?.push(nodeId);
      }
    }

    const nodesPayload = nodeEntries.map(([nodeId, node]) => {
      const inputs = getNodeInputs(node);
      const inDegree = inputs.length;
      const children = childrenMap.get(nodeId) || [];

      const jobData = {
        jobId: `${graphId}:${nodeId}`,
        originalFilename: meta.originalFilename || `${nodeId}.bin`,
        sourceFormat: 'bin',
        targetFormat: (node as any).targetFormat || 'bin',
        fileSize: 0,
        options: (node as any).options || {},
        userId: meta.ownerUserId,
        reservationId: meta.reservationId,
        graphId,
        graphNodeId: nodeId,
        graphNode: node,
        inputArtifacts: [] as string[],
      };

      return {
        id: nodeId,
        op: node.op,
        inDegree,
        children,
        jobData: JSON.stringify(jobData),
      };
    });

    await this.redisClient.eval(
      INIT_GRAPH_LUA_SCRIPT,
      7,
      this.graphKey(graphId),
      this.depsKey(graphId),
      this.childrenKey(graphId),
      this.nodesKey(graphId),
      this.outputsKey(graphId),
      this.waitingKey,
      this.jobKeyPrefix,
      graphId,
      policy,
      meta.ownerUserId || 'anonymous',
      String(createdAt),
      String(totalNodes),
      JSON.stringify(nodesPayload),
      meta.reservationId || '',
      JSON.stringify(graph)
    );

    const state = await this.getGraphState(graphId);
    if (!state) {
      throw new Error(`Failed to retrieve newly initialized graph: ${graphId}`);
    }
    return state;
  }

  async onNodeStarted(graphId: string, nodeId: NodeId): Promise<void> {
    await this.redisClient.eval(
      NODE_STARTED_LUA_SCRIPT,
      2,
      this.graphKey(graphId),
      this.nodesKey(graphId),
      nodeId,
      String(Date.now())
    );
  }

  async onNodeCompleted(
    graphId: string,
    nodeId: NodeId,
    outputs: string[],
    actualUnits: number = 1
  ): Promise<NodeCompletionResult> {
    const rawResult = (await this.redisClient.eval(
      NODE_COMPLETED_LUA_SCRIPT,
      7,
      this.graphKey(graphId),
      this.depsKey(graphId),
      this.childrenKey(graphId),
      this.nodesKey(graphId),
      this.outputsKey(graphId),
      this.waitingKey,
      this.jobKeyPrefix,
      graphId,
      nodeId,
      JSON.stringify(outputs),
      String(Date.now()),
      String(actualUnits)
    )) as [number, string, string, string];

    const isOk = Number(rawResult[0]) === 1;
    const finalGraphStatus = (rawResult[1] || 'running') as GraphExecutionState['status'];
    let readyNodeIds: NodeId[] = [];
    try {
      const parsed = JSON.parse(rawResult[2] || '[]');
      readyNodeIds = Array.isArray(parsed) ? parsed : [];
    } catch {}

    const totalUnits = Number(rawResult[3] || actualUnits);
    const graphCompleted = isOk && finalGraphStatus === 'completed';

    if (graphCompleted) {
      await this.cleanupIntermediates(graphId);
      const state = await this.getGraphState(graphId);
      if (state) {
        if (state.reservationId) {
          await redisKeyStore.settleQuota(state.reservationId, totalUnits).catch(() => {});
        }
        if (state.webhookUrl && state.webhookSecret) {
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
    }

    return {
      graphCompleted,
      graphStatus: finalGraphStatus,
      readyNodeIds,
    };
  }

  async onNodeFailed(
    graphId: string,
    nodeId: NodeId,
    error: string
  ): Promise<NodeFailureResult> {
    const rawResult = (await this.redisClient.eval(
      NODE_FAILED_LUA_SCRIPT,
      7,
      this.graphKey(graphId),
      this.depsKey(graphId),
      this.childrenKey(graphId),
      this.nodesKey(graphId),
      this.outputsKey(graphId),
      this.waitingKey,
      this.jobKeyPrefix,
      graphId,
      nodeId,
      error,
      String(Date.now())
    )) as [number, string, string, string];

    const finalStatus = (rawResult[1] || 'failed') as GraphExecutionState['status'];
    let cancelledJobIds: string[] = [];
    let skippedNodeIds: NodeId[] = [];
    try {
      const parsed = JSON.parse(rawResult[2] || '[]');
      cancelledJobIds = Array.isArray(parsed) ? parsed : [];
    } catch {}
    try {
      const parsed = JSON.parse(rawResult[3] || '[]');
      skippedNodeIds = Array.isArray(parsed) ? parsed : [];
    } catch {}

    const graphFailed = finalStatus === 'failed';

    if (graphFailed) {
      await this.cleanupIntermediates(graphId);
      const state = await this.getGraphState(graphId);
      if (state?.reservationId) {
        await redisKeyStore.rollbackQuota(state.reservationId).catch(() => {});
      }
      if (state?.webhookUrl && state?.webhookSecret) {
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
      graphStatus: finalStatus,
      cancelledJobIds,
      skippedNodeIds,
    };
  }

  async getGraphState(graphId: string): Promise<GraphExecutionState | undefined> {
    const rawGraph = await this.redisClient.hgetall(this.graphKey(graphId));
    if (!rawGraph || Object.keys(rawGraph).length === 0) {
      return undefined;
    }

    const rawNodes = await this.redisClient.hgetall(this.nodesKey(graphId));
    const nodesRecord: Record<NodeId, GraphNodeState> = {};
    for (const [nid, jsonStr] of Object.entries(rawNodes)) {
      try {
        nodesRecord[nid] = JSON.parse(jsonStr);
      } catch {}
    }

    let parsedGraph: JobGraph = { nodes: {} };
    if (rawGraph.graph) {
      try {
        parsedGraph = JSON.parse(rawGraph.graph);
      } catch {}
    }

    return {
      graphId: rawGraph.graphId || graphId,
      status: (rawGraph.status || 'running') as any,
      policy: (rawGraph.policy || 'fail_fast') as any,
      ownerUserId: rawGraph.owner || undefined,
      reservationId: rawGraph.reservationId || undefined,
      createdAt: Number(rawGraph.createdAt || Date.now()),
      finishedAt: rawGraph.finishedOn ? Number(rawGraph.finishedOn) : undefined,
      failedReason: rawGraph.failedReason || undefined,
      totalNodes: Number(rawGraph.totalNodes || 0),
      completedNodes: Number(rawGraph.completedNodes || 0),
      failedNodes: Number(rawGraph.failedNodes || 0),
      nodes: nodesRecord,
      graph: parsedGraph,
    };
  }

  async cancelGraph(graphId: string, reason: string = 'Cancelled by user'): Promise<boolean> {
    const rawResult = (await this.redisClient.eval(
      CANCEL_GRAPH_LUA_SCRIPT,
      4,
      this.graphKey(graphId),
      this.nodesKey(graphId),
      this.waitingKey,
      this.jobKeyPrefix,
      graphId,
      reason,
      String(Date.now())
    )) as [number, string, string];

    const isCancelled = Number(rawResult[0]) === 1;
    if (isCancelled) {
      await this.cleanupIntermediates(graphId);
      const state = await this.getGraphState(graphId);
      if (state?.reservationId) {
        await redisKeyStore.rollbackQuota(state.reservationId).catch(() => {});
      }
    }
    return isCancelled;
  }

  async getNodeOutputs(graphId: string, nodeIds: NodeId | NodeId[]): Promise<string[]> {
    const targetIds = Array.isArray(nodeIds) ? nodeIds : [nodeIds];
    if (targetIds.length === 0) return [];

    const outputs: string[] = [];
    const rawValues = await this.redisClient.hmget(this.outputsKey(graphId), ...targetIds);

    for (const val of rawValues) {
      if (val) {
        try {
          const parsed = JSON.parse(val);
          if (Array.isArray(parsed)) {
            outputs.push(...parsed);
          }
        } catch {}
      }
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
}
