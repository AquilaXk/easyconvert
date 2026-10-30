import type { JobGraph, GraphNode, NodeId } from './types';

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

export interface IGraphScheduler {
  initGraph(graphId: string, graph: JobGraph, meta?: GraphMetadata): Promise<GraphExecutionState>;
  onNodeStarted(graphId: string, nodeId: NodeId): Promise<void>;
  onNodeCompleted(
    graphId: string,
    nodeId: NodeId,
    outputs: string[],
    actualUnits?: number
  ): Promise<NodeCompletionResult>;
  onNodeFailed(graphId: string, nodeId: NodeId, error: string): Promise<NodeFailureResult>;
  getGraphState(graphId: string): Promise<GraphExecutionState | undefined>;
  cancelGraph(graphId: string, reason?: string): Promise<boolean>;
  getNodeOutputs(graphId: string, nodeIds: NodeId | NodeId[]): Promise<string[]>;
  cleanupIntermediates(graphId: string): Promise<number>;
}
