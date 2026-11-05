import type { JobGraph, GraphNode, NodeId } from './types';
import type { Recovery } from '../../api-keys/hand-off';

export type GraphStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export type NodeExecutionStatus =
  | 'pending'
  | 'waiting'
  | 'active'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export interface GraphNodeState {
  id: NodeId;
  op: GraphNode['op'];
  status: NodeExecutionStatus;
  outputs: string[];
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface GraphMetadata {
  ownerUserId?: string;
  reservationId?: string;
  webhookUrl?: string;
  webhookSecret?: string;
  originalFilename?: string;
  sourceStorageKey?: string;
  /** Submission formats and legacy linear tasks, echoed by the job status API. */
  sourceFormat?: string;
  targetFormat?: string;
  tasks?: unknown[];
  createdAt?: number;
}

/** What the node jobs of a graph carry: its owner, file name and start, never its reservation, which only the graph scheduler settles or gives back. */
export type GraphNodeJobMetadata = Pick<GraphMetadata, 'ownerUserId' | 'originalFilename' | 'createdAt'>;

export interface GraphExecutionState {
  graphId: string;
  status: GraphStatus;
  policy: 'fail_fast' | 'continue';
  ownerUserId?: string;
  reservationId?: string;
  webhookUrl?: string;
  webhookSecret?: string;
  originalFilename?: string;
  /** Storage key of the submitted source object, as persisted by the Redis scheduler. */
  sourceStorageKey?: string;
  sourceFormat?: string;
  targetFormat?: string;
  tasks?: unknown[];
  createdAt: number;
  finishedAt?: number;
  failedReason?: string;
  totalNodes: number;
  completedNodes: number;
  failedNodes: number;
  nodes: Record<NodeId, GraphNodeState>;
  graph: JobGraph;
}

export interface NodeCompletionResult {
  graphCompleted: boolean;
  graphStatus: GraphStatus;
  readyNodeIds: NodeId[];
}

export interface NodeFailureResult {
  graphFailed: boolean;
  graphStatus: GraphStatus;
  cancelledJobIds: string[];
  skippedNodeIds: NodeId[];
}

declare const sealedGraph: unique symbol;

/** A graph whose nodes carry their secrets sealed under their job ids (`sealGraph` in node-jobs.ts): the only graph a scheduler stores. */
export type SealedJobGraph = JobGraph & { readonly [sealedGraph]: true };

export interface IGraphScheduler {
  initGraph(graphId: string, graph: SealedJobGraph, meta?: GraphMetadata): Promise<GraphExecutionState>;
  onNodeStarted(graphId: string, nodeId: NodeId): Promise<void>;
  onNodeCompleted(
    graphId: string,
    nodeId: NodeId,
    outputs: string[],
    actualUnits?: number
  ): Promise<NodeCompletionResult>;
  onNodeFailed(graphId: string, nodeId: NodeId, error: string): Promise<NodeFailureResult>;
  getGraphState(graphId: string): Promise<GraphExecutionState | undefined>;
  /**
   * Finishes the start of a graph whose `initGraph` threw after it stored the graph: queues the ready nodes the start left
   * unqueued (the outbox, drained until it is empty) and answers the graph as started. A graph whose nodes still cannot be
   * queued is cancelled, which gives its reservation back, and answered as not started; a graph that was not stored is
   * unknown, as its write may still land.
   */
  recoverStart(graphId: string): Promise<Recovery<GraphExecutionState>>;
  cancelGraph(graphId: string, reason?: string): Promise<boolean>;
  /** The output keys of the nodes `nodeIds`, each key once. */
  getNodeOutputs(graphId: string, nodeIds: NodeId | NodeId[]): Promise<string[]>;
  /** The ids of the graphs `userId` owns. */
  graphsOfUser?(userId: string): Promise<string[]>;
  /** Removes every stored record of `graphId`. */
  deleteGraph?(graphId: string): Promise<void>;
}
