import { releaseResultHold, withInputHeld } from '../../storage/retention-service';
import type { GraphExecutionState, GraphMetadata, IGraphScheduler } from './scheduler-types';
import type { JobGraph } from './types';

/** The stored files the `import.upload` nodes of `graph` read. */
function graphInputKeys(graph: JobGraph): string[] {
  const keys = new Set<string>();
  for (const node of Object.values(graph.nodes)) {
    const storageKey = (node as { op?: string; storageKey?: unknown }).op === 'import.upload' ? (node as { storageKey?: unknown }).storageKey : undefined;
    if (typeof storageKey === 'string') keys.add(storageKey);
  }
  return [...keys];
}

/**
 * Starts the graph `graphId` while every file its `import.upload` nodes read, an upload or an earlier result, is held
 * for it (see `withInputHeld`), so that no deletion removes one before a node reads it; `releaseGraphInputHolds` ends
 * the holds when the graph ends.
 */
export function initGraphHoldingInputs(
  scheduler: Pick<IGraphScheduler, 'initGraph'>,
  graphId: string,
  graph: JobGraph,
  meta: GraphMetadata
): Promise<GraphExecutionState> {
  const start = graphInputKeys(graph).reduceRight<() => Promise<GraphExecutionState>>(
    (startHolding, key) => () => withInputHeld(key, graphId, startHolding),
    () => scheduler.initGraph(graphId, graph, meta)
  );
  return start();
}

/**
 * Ends the holds the graph `graphId` took on the files it read as inputs, once it has ended (completed, failed or
 * cancelled). An upload no other job or graph holds is then deleted after the grace period.
 */
export async function releaseGraphInputHolds(graphId: string, graph: JobGraph): Promise<void> {
  for (const key of graphInputKeys(graph)) await releaseResultHold(key, graphId);
}
