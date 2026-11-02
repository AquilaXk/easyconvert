import Redis, { ReplyError } from 'ioredis';
import type { GraphNode, JobGraph, NodeId } from './types';
import { getNodeInputs } from './validate-graph';
import type {
  GraphExecutionState,
  GraphMetadata,
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
import { cancelGraphNodeJob, cancelGraphNodeJobOrLog, enqueueGraphNodeJob, graphNodeJobId, graphNodeJobMetadata, queueReadyNodesOrCancel } from './node-jobs';
import { graphInputKeys } from './input-cleanup';
import { maskTaskRecords, sealJobGraph } from './sealed-nodes';
import { maskServerText } from '../../security/server-paths';
import { DEFAULT_QUEUE_KEY_PREFIX } from '../bullmq-engine';
import { GraphStateCorruptError, QueueUnavailableError } from '../../types';
import { finishGraph, type EndedGraph, type GraphEnd, type ReservationEnd } from './graph-end';
import { parseGraphMeta, parseGraphStatus, parseNodeStates, parseStoredCount, parseStoredList } from './redis-state-parsers';
import { RECOVERY_UNKNOWN, type Recovery } from '../hand-off';

export interface RedisGraphSchedulerOptions {
  redisClient: Redis;
  /** Defaults to the queue engine prefix so graph and queue keys share one namespace. */
  keyPrefix?: string;
  /** Moves a ready node onto a queue. Defaults to the node's resource-class queue. */
  enqueueNode?: typeof enqueueGraphNodeJob;
  /** Cancels a node's queue job. Defaults to the node's resource-class queue. */
  cancelNode?: typeof cancelGraphNodeJob;
}

/** The Redis commands this scheduler sends. */
const SCHEDULER_REDIS_COMMANDS: ReadonlySet<PropertyKey> = new Set(['eval', 'hgetall', 'hmget', 'lrange', 'lrem']);
const SCHEDULER_QUEUE_NAME = 'graph-scheduler';

/**
 * Fails closed when Redis does not answer: a rejected command becomes `QueueUnavailableError` (503
 * at the API). A reply error is Redis answering (a script refusing a duplicate graph, for example)
 * and propagates unchanged.
 */
function failClosedRedis(client: Redis): Redis {
  return new Proxy(client, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== 'function' || !SCHEDULER_REDIS_COMMANDS.has(prop)) {
        return value;
      }
      return (...args: unknown[]) =>
        Promise.resolve(value.apply(target, args)).catch((err: unknown) => {
          if (err instanceof ReplyError) {
            throw err;
          }
          throw new QueueUnavailableError(SCHEDULER_QUEUE_NAME, err instanceof Error ? err.message : String(err));
        });
    },
  });
}

export class RedisGraphScheduler implements IGraphScheduler {
  private readonly redisClient: Redis;
  private readonly keyPrefix: string;
  private readonly enqueueNode: typeof enqueueGraphNodeJob;
  private readonly cancelNode: typeof cancelGraphNodeJob;

  constructor(options: RedisGraphSchedulerOptions) {
    this.redisClient = failClosedRedis(options.redisClient);
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
      inputKeys: JSON.stringify(graphInputKeys(sealedGraph.nodes)),
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
    // A damaged record fails the graph here; a ready node is never skipped or dropped from the outbox.
    const record = parseGraphMeta(graphId, await this.redisClient.hgetall(k.graph));
    const graph = record.graph;
    const graphMeta = graphNodeJobMetadata(record);

    for (const nodeId of ready) {
      const node = Object.hasOwn(graph.nodes, nodeId) ? graph.nodes[nodeId] : undefined;
      if (!node) {
        throw new GraphStateCorruptError(`Graph ${graphId} has a corrupt scheduler record: the outbox names node "${nodeId}", which the graph does not define.`);
      }
      const inputArtifacts = await this.getNodeOutputs(graphId, getNodeInputs(node));
      await this.enqueueNode(graphId, nodeId, node, graphMeta, inputArtifacts);
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
    )) as [number, string, string, string, string?, string?];

    const graphCompleted = Number(raw[0]) === 1 && raw[1] === 'completed';
    const proceed = async (): Promise<NodeCompletionResult> => {
      const graphStatus = parseGraphStatus(graphId, raw[1]);
      const readyNodeIds = parseStoredList<NodeId>(graphId, 'the ready node list', raw[2]);
      await this.drainOutbox(graphId);
      return { graphCompleted, graphStatus, readyNodeIds };
    };
    // Only the call whose script recorded the completion ends the graph. A failure while it proceeds is then logged, as the
    // node is done, and the answer is what the script recorded: a completed graph readies no node. Any other completion
    // fails with it, so the node job is tried again and the outbox drained then.
    if (!graphCompleted) return proceed();
    const end: GraphEnd = { outcome: { status: 'completed' }, reservation: reservationEnd(graphId, raw[3]) };
    return (await finishGraph(this.endedGraph(graphId, raw[4], raw[5]), end, proceed)) ?? { graphCompleted, graphStatus: 'completed', readyNodeIds: [] };
  }

  /** The graph `graphId` whose end a script recorded, with the reservation id and the input keys the script returned. */
  private endedGraph(graphId: string, reservationId: string | undefined, inputKeys: string | undefined): EndedGraph {
    return { graphId, reservationId: reservationId || undefined, inputKeys: endedInputKeys(graphId, inputKeys), readState: () => this.getGraphState(graphId) };
  }

  async onNodeFailed(graphId: string, nodeId: NodeId, reportedError: string): Promise<NodeFailureResult> {
    // The reason is stored, returned by the job API and sent in webhooks: credentials and server paths are masked here, on write.
    const error = maskServerText(reportedError);
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
    )) as [number, string, string, string, string?, string?, string?];

    const graphStatus = parseGraphStatus(graphId, raw[1]);
    const cancelledNodeIds = parseStoredList<NodeId>(graphId, 'the cancelled node list', raw[2]);
    const skippedNodeIds = parseStoredList<NodeId>(graphId, 'the skipped node list', raw[3]);
    const stoppedNodeIds = [...cancelledNodeIds, ...skippedNodeIds];
    /** Cancels the node jobs the script cancelled or skipped, with their nodes read from `state`, and answers what it did. */
    const stopNodes = async (state: GraphExecutionState | undefined): Promise<Omit<NodeFailureResult, 'graphFailed'>> => {
      const reason = `Graph failed due to node ${nodeId}`;
      const cancelledJobIds: string[] = [];
      for (const nid of stoppedNodeIds) {
        const cancelled = await cancelGraphNodeJobOrLog(graphId, nid, state?.graph.nodes[nid], reason, this.cancelNode);
        if (cancelled && cancelledNodeIds.includes(nid)) cancelledJobIds.push(graphNodeJobId(graphId, nid));
      }
      return { graphStatus, cancelledJobIds, skippedNodeIds };
    };
    const end = recordedFailureEnd(graphId, raw, error);
    if (!end) return { graphFailed: false, ...(await stopNodes(stoppedNodeIds.length > 0 ? await this.getGraphState(graphId) : undefined)) };
    // A graph whose end this call recorded has no stopped nodes to report when stopping them failed (`finishGraph` logs it).
    const stopped = await finishGraph(this.endedGraph(graphId, raw[5], raw[6]), end, stopNodes);
    return { graphFailed: end.outcome.status === 'failed', ...(stopped ?? { graphStatus: end.outcome.status, cancelledJobIds: [], skippedNodeIds: [] }) };
  }

  async getGraphState(graphId: string): Promise<GraphExecutionState | undefined> {
    const k = this.graphKeys(graphId);
    const rawGraph = await this.redisClient.hgetall(k.graph);
    if (!rawGraph || Object.keys(rawGraph).length === 0) {
      return undefined;
    }

    const meta = parseGraphMeta(graphId, rawGraph);
    const nodes = parseNodeStates(graphId, await this.redisClient.hgetall(k.nodes), meta.totalNodes);
    return { ...meta, nodes };
  }

  async recoverStart(graphId: string): Promise<Recovery<GraphExecutionState>> {
    const state = await this.getGraphState(graphId);
    if (!state) return RECOVERY_UNKNOWN;
    return queueReadyNodesOrCancel(state, () => this.drainOutbox(graphId), (reason) => this.cancelGraph(graphId, reason));
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
    )) as [number, string, string, string?, string?];

    if (Number(raw[0]) !== 1) {
      return false;
    }
    await finishGraph(this.endedGraph(graphId, raw[3], raw[4]), { outcome: { status: 'cancelled' }, reservation: { kind: 'rollback' } }, async (state) => {
      for (const nid of parseStoredList<NodeId>(graphId, 'the cancelled node list', raw[2])) {
        await cancelGraphNodeJobOrLog(graphId, nid, state?.graph.nodes[nid] as GraphNode | undefined, reason, this.cancelNode);
      }
    });
    return true;
  }

  async getNodeOutputs(graphId: string, nodeIds: NodeId | NodeId[]): Promise<string[]> {
    const targetIds = Array.isArray(nodeIds) ? nodeIds : [nodeIds];
    if (targetIds.length === 0) return [];
    const values = await this.redisClient.hmget(this.graphKeys(graphId).outputs, ...targetIds);
    return [...new Set(values.flatMap((v) => (v ? parseStoredList<string>(graphId, 'a node output list', v) : [])))];
  }

}

/** The input keys a script returned for an ended graph; a corrupt list is logged and none are released. */
function endedInputKeys(graphId: string, raw: string | undefined): string[] {
  try {
    return parseStoredList<string>(graphId, 'the input key list', raw ?? '[]');
  } catch (err) {
    console.error(`[GraphScheduler] Graph ${graphId} ended with a corrupt input key list, so the holds on its inputs end by themselves:`, err);
    return [];
  }
}

/**
 * The reservation of a completed graph settled to the units its script reports, or given back when the stored count cannot
 * be read, the corrupt count logged, since charging a guessed count would be worse.
 */
function reservationEnd(graphId: string, raw: unknown): ReservationEnd {
  try {
    return { kind: 'settle', units: parseStoredCount(graphId, 'the charged units', raw) };
  } catch (err) {
    console.error(`[GraphScheduler] Graph ${graphId} ended with a corrupt count of charged units, so its reservation is given back:`, err);
    return { kind: 'rollback' };
  }
}

/**
 * How the graph ended when the failure script of a call recorded its end: failed (fail_fast), which charges nothing, or
 * completed (continue, its last node failing), settled to the units its nodes charged. Undefined when the script recorded
 * no end.
 */
function recordedFailureEnd(graphId: string, raw: readonly unknown[], error: string): GraphEnd | undefined {
  if (Number(raw[0]) !== 1) return undefined;
  if (raw[1] === 'failed') return { outcome: { status: 'failed', error }, reservation: { kind: 'rollback' } };
  if (raw[1] === 'completed') return { outcome: { status: 'completed' }, reservation: reservationEnd(graphId, raw[4]) };
  return undefined;
}
