import { isUploadKey } from '../../storage/key-namespace';
import type { IStorageBackend } from '../../storage/oci-storage';
import type { JobGraph } from './types';

/** The uploaded files the `import.upload` nodes of `graph` read. A user's own earlier output chained as the input is not listed: it is theirs to keep until it expires. */
export function graphUploadKeys(graph: JobGraph): string[] {
  const keys = new Set<string>();
  for (const node of Object.values(graph.nodes)) {
    const storageKey = (node as { op?: string; storageKey?: unknown }).op === 'import.upload' ? (node as { storageKey?: unknown }).storageKey : undefined;
    if (typeof storageKey === 'string' && isUploadKey(storageKey)) keys.add(storageKey);
  }
  return [...keys];
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
