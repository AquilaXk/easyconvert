import type { GraphExecutionState, NodeExecutionStatus } from './scheduler-types';

const PERCENT = 100;
const TERMINAL_NODE_STATUSES: ReadonlySet<NodeExecutionStatus> = new Set<NodeExecutionStatus>(['completed', 'failed', 'cancelled', 'skipped']);

/** Percentage of graph nodes that reached a terminal state. */
export function graphProgress(state: GraphExecutionState): number {
  if (state.totalNodes === 0) {
    return 0;
  }
  const finished = Object.values(state.nodes).filter((n) => TERMINAL_NODE_STATUSES.has(n.status)).length;
  return Math.round((finished / state.totalNodes) * PERCENT);
}
