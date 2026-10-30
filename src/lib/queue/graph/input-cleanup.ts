import { isUploadKey } from '../../storage/key-namespace';
import type { IStorageBackend } from '../../storage/oci-storage';
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

/** The uploaded files the `import.upload` nodes of `graph` read. A user's own earlier output chained as the input is not listed: it is theirs to keep until it expires. */
export function graphUploadKeys(graph: JobGraph): string[] {
  return graphInputKeys(graph).filter(isUploadKey);
}

/**
 * Starts the graph `graphId` while every earlier result it reads as an input is held for it (see `withInputHeld`), so
 * that no deletion removes one before a node reads it; `releaseGraphInputHolds` ends the holds when the graph ends.
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

/** Ends the holds the graph `graphId` took on earlier results it read as inputs, once it has ended. */
export async function releaseGraphInputHolds(graphId: string, graph: JobGraph): Promise<void> {
  for (const key of graphInputKeys(graph)) {
    if (!isUploadKey(key)) await releaseResultHold(key, graphId);
  }
}

/**
 * Deletes the uploaded inputs of a graph that has ended (completed, failed or cancelled). No node can still
 * read them then, so they are not kept for their lifetime. Returns how many were deleted.
 */
export async function removeGraphUploads(graph: JobGraph, storage: Pick<IStorageBackend, 'deleteObject'>): Promise<number> {
  let removed = 0;
  for (const key of graphUploadKeys(graph)) {
    try {
      if (await storage.deleteObject(key)) removed++;
    } catch (err) {
      console.warn(`[GraphScheduler] Input cleanup failed to delete key "${key}":`, err);
    }
  }
  return removed;
}
