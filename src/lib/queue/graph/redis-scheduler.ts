import Redis, { ReplyError } from 'ioredis';
import type { GraphNode, NodeId } from './types';
import { getNodeInputs } from './validate-graph';
import {
  MAX_INDEXED_GRAPHS_PER_USER,
  type GraphExecutionState,
  type GraphMetadata,
  type GraphStatus,
  type IGraphScheduler,
  type NodeCompletionResult,
  type NodeFailureResult,
  type SealedJobGraph,
} from './scheduler-types';
import {
  INIT_GRAPH_LUA_SCRIPT,
  NODE_STARTED_LUA_SCRIPT,
  NODE_COMPLETED_LUA_SCRIPT,
  NODE_FAILED_LUA_SCRIPT,
  CANCEL_GRAPH_LUA_SCRIPT,
  FORGET_ENDED_GRAPH_LUA_SCRIPT,
  INDEX_USER_GRAPH_LUA_SCRIPT,
} from './lua-scripts';
import { endedJobRetentionMs } from '../enqueue';
import { JOB_DEADLINE_CEILING_MS } from '../../config/schema';
import { isAnonymousUserId } from '../../auth/anonymous-identity';
import { assertSealedFor, cancelGraphNodeJob, cancelGraphNodeJobOrLog, enqueueGraphNodeJob, graphNodeJobId, graphNodeJobMetadata, queueReadyNodesOrCancel, type StartingGraphScheduler } from './node-jobs';
import { graphInputKeys } from './input-cleanup';
import { maskTaskRecords } from './sealed-nodes';
import { maskServerText } from '../../security/server-paths';
import { DEFAULT_QUEUE_KEY_PREFIX } from '../bullmq-engine';
import { GraphStateCorruptError, QueueUnavailableError } from '../../types';
import { finishGraph, type EndedGraph, type GraphEnd, type ReservationEnd } from './graph-end';
import { parseGraphMeta, parseGraphStatus, parseNodeStates, parseStoredCount, parseStoredList } from './redis-state-parsers';
import { leaseToHandedOffWork, RECOVERY_UNKNOWN, type Recovery } from '../../api-keys/hand-off';

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
const SCHEDULER_REDIS_COMMANDS: ReadonlySet<PropertyKey> = new Set(['eval', 'hgetall', 'hmget', 'lrange', 'lrem', 'del', 'hget', 'scan', 'zrevrange', 'zrem']);
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

export class RedisGraphScheduler implements IGraphScheduler, StartingGraphScheduler {
  private readonly redisClient: Redis;
  private readonly keyPrefix: string;
  private readonly enqueueNode: typeof enqueueGraphNodeJob;
  readonly cancelNode: typeof cancelGraphNodeJob;

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

  /** The sorted set of the graphs of `userId`, scored by creation time; the `{userId}` tag puts it in one slot, and `erase-account` finds it with the rest of the account's keys. */
  userGraphsKey(userId: string): string {
    return `${this.keyPrefix}user_graphs:{${userId}}`;
  }

  /**
   * Adds the graph to the index of its owner, after its state is stored, so an indexed graph always has a state. The index holds
   * a graph as long as its state can live (its deadline, then the retention of an ended job) and at most
   * MAX_INDEXED_GRAPHS_PER_USER graphs. A graph without an account owner is not indexed: no list names it.
   */
  private async indexGraph(graphId: string, ownerUserId: string | undefined, createdAt: number): Promise<void> {
    if (!ownerUserId || isAnonymousUserId(ownerUserId)) return;
    await this.redisClient.eval(
      INDEX_USER_GRAPH_LUA_SCRIPT,
      1,
      this.userGraphsKey(ownerUserId),
      graphId,
      String(createdAt),
      String(Date.now()),
      String(endedJobRetentionMs() + JOB_DEADLINE_CEILING_MS),
      String(MAX_INDEXED_GRAPHS_PER_USER)
    );
  }

  async initGraph(graphId: string, graph: SealedJobGraph, meta: GraphMetadata = {}): Promise<GraphExecutionState> {
    assertSealedFor(graphId, graph);
    const k = this.graphKeys(graphId);
    const entries = Object.entries(graph.nodes);
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
      webhookKeyId: meta.webhookKeyId || '',
      originalFilename: meta.originalFilename || '',
      sourceStorageKey: meta.sourceStorageKey || '',
      sourceFormat: meta.sourceFormat || '',
      targetFormat: meta.targetFormat || '',
      tasks: meta.tasks ? JSON.stringify(maskTaskRecords(meta.tasks)) : '',
      inputKeys: JSON.stringify(graphInputKeys(graph.nodes)),
      createdAt: String(createdAt),
      totalNodes: String(entries.length),
      graph: JSON.stringify(graph),
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
    await this.indexGraph(graphId, meta.ownerUserId, createdAt);
    await this.drainOutbox(graphId);
    const state = await this.getGraphState(graphId);
    if (!state) {
      throw new Error(`Failed to retrieve newly initialized graph: ${graphId}`);
    }
    // Renewed after the last step, so a start that throws leaves the reservation on the provisional lease.
    if (meta.reservationId) await leaseToHandedOffWork(meta.reservationId);
    return state;
  }

  /** Queues the ready nodes of graph `graphId` by draining its outbox. */
  async queueReadyNodes(graphId: string): Promise<number> {
    return this.drainOutbox(graphId);
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

  async onNodeStarted(graphId: string, nodeId: NodeId): Promise<boolean> {
    const k = this.graphKeys(graphId);
    return Number(await this.redisClient.eval(NODE_STARTED_LUA_SCRIPT, 2, k.graph, k.nodes, nodeId, String(Date.now()))) === 1;
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
    return {
      graphId,
      reservationId: reservationId || undefined,
      inputKeys: endedInputKeys(graphId, inputKeys),
      readState: () => this.getGraphState(graphId),
      forget: () => this.forgetEndedGraph(graphId),
    };
  }

  /** Empties the webhook secret of the ended graph `graphId` and sets every key of it to expire `endedJobRetentionMs` from now. */
  async forgetEndedGraph(graphId: string): Promise<void> {
    const k = this.graphKeys(graphId);
    await this.redisClient.eval(FORGET_ENDED_GRAPH_LUA_SCRIPT, 6, k.graph, k.deps, k.children, k.nodes, k.outputs, k.outbox, String(endedJobRetentionMs()));
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
    // A start that threw after it stored the graph may not have indexed it.
    await this.indexGraph(graphId, state.ownerUserId, state.createdAt);
    return queueReadyNodesOrCancel(state, this);
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

  async graphsOfUser(userId: string): Promise<string[]> {
    const prefix = `${this.keyPrefix}graph:{`;
    const graphIds = new Set<string>();
    let cursor = '0';
    do {
      const [next, keys] = await this.redisClient.scan(cursor, 'MATCH', `${prefix}*}`, 'COUNT', 500);
      const validKeys = keys.filter((key) => key.endsWith('}'));
      if (validKeys.length > 0) {
        const owners = await Promise.all(validKeys.map((key) => this.redisClient.hget(key, 'owner')));
        for (let i = 0; i < validKeys.length; i++) {
          if (owners[i] === userId) {
            graphIds.add(validKeys[i].slice(prefix.length, -1));
          }
        }
      }
      cursor = next;
    } while (cursor !== '0');
    return [...graphIds].sort((a, b) => a.localeCompare(b));
  }

  async listGraphsOfUser(userId: string, limit: number, statuses?: readonly GraphStatus[]): Promise<GraphExecutionState[]> {
    if (limit <= 0) return [];
    const index = this.userGraphsKey(userId);
    const ids = await this.redisClient.zrevrange(index, 0, MAX_INDEXED_GRAPHS_PER_USER - 1);
    const listed: GraphExecutionState[] = [];
    const vanished: string[] = [];
    // The index knows no status, so a page that a filter thins reads the next graphs, a page at a time, until it is full.
    for (let at = 0; at < ids.length && listed.length < limit; at += limit) {
      const page = ids.slice(at, at + limit);
      const states = await Promise.all(page.map((graphId) => this.readIndexedGraph(graphId)));
      states.forEach((state, position) => {
        if (state === undefined) vanished.push(page[position]);
        else if (state && state.ownerUserId === userId && (!statuses || statuses.includes(state.status))) listed.push(state);
      });
    }
    // A graph whose state expired leaves the index; the index is also pruned whenever a graph is added.
    if (vanished.length > 0) await this.redisClient.zrem(index, ...vanished).catch(() => undefined);
    return listed.slice(0, limit);
  }

  /** The state of an indexed graph: undefined when it expired, null when its record is damaged (logged; the list goes on without it). */
  private async readIndexedGraph(graphId: string): Promise<GraphExecutionState | undefined | null> {
    try {
      return await this.getGraphState(graphId);
    } catch (err) {
      if (!(err instanceof GraphStateCorruptError)) throw err;
      console.error(`[GraphScheduler] Graph ${graphId} is left out of a list because its record is damaged:`, err);
      return null;
    }
  }

  async deleteGraph(graphId: string): Promise<boolean> {
    const k = this.graphKeys(graphId);
    return (await this.redisClient.del(k.graph, k.deps, k.children, k.nodes, k.outputs, k.outbox)) > 0;
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
