import { releaseResultHold, takeInputHold, withInputHeld } from '../../storage/retention-service';

/** The stored files the `import.upload` nodes of a graph with these `nodes` read. */
export function graphInputKeys(nodes: Readonly<Record<string, object>>): string[] {
  const keys = new Set<string>();
  for (const node of Object.values(nodes)) {
    const { op, storageKey } = node as { op?: string; storageKey?: unknown };
    if (op === 'import.upload' && typeof storageKey === 'string') keys.add(storageKey);
  }
  return [...keys];
}

/**
 * Runs `start`, which starts the graph `graphId` with these `nodes`, while every file its `import.upload` nodes read, an
 * upload or an earlier result, is held for it (see `withInputHeld`), so that no deletion removes one before a node reads it;
 * `releaseInputHolds` ends the holds when the graph ends. A `start` that throws gives the holds up.
 */
export function withGraphInputsHeld<T>(graphId: string, nodes: Readonly<Record<string, object>>, start: () => Promise<T>): Promise<T> {
  const holding = graphInputKeys(nodes).reduceRight<() => Promise<T>>((startHolding, key) => () => withInputHeld(key, graphId, startHolding), start);
  return holding();
}

/**
 * Holds `key`, the file an `import.upload` node of the graph `graphId` reads, for the graph when the node runs (`takeInputHold`),
 * so a graph whose start gave the hold up holds it from then until it ends, and returns `key`. Throws a StorageNotFoundError
 * when the file was deleted.
 */
export async function heldGraphInput(graphId: string, key: string): Promise<string> {
  await takeInputHold(key, graphId);
  return key;
}

/**
 * Ends the holds the graph `graphId` took on `inputKeys`, the files it read as inputs (`graphInputKeys`), once it has
 * ended (completed, failed or cancelled). An upload no other job or graph holds is then deleted after the grace period.
 */
export async function releaseInputHolds(graphId: string, inputKeys: readonly string[]): Promise<void> {
  for (const key of inputKeys) await releaseResultHold(key, graphId);
}
