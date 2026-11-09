import path from 'node:path';
import { isAnonymousUserId } from '../../auth/anonymous-identity';
import { redisKeyStore } from '../../api-keys/redis-key-store';
import { storageProvider } from '../../storage';
import { resolveRetentionPolicy } from '../../storage/result-retention';
import type { GraphExecutionState } from './scheduler-types';

/** The id a final output is recorded under: the graph, the export node and the place in the node's outputs, so a completion reported again replaces the record. */
function outputRecordId(graphId: string, nodeId: string, index: number): string {
  return `${graphId}:${nodeId}:${index}`;
}

/**
 * Puts the final outputs of a completed graph in the history of converted files of its owner (`/api/account/files`): the
 * stored files of its `export.internal` nodes, which are the results the graph returns (the intermediate files of the other
 * nodes are removed when the graph ends). Each is recorded under its own stable id with the storage key it lives at and the
 * graph's id, and is kept as long as a job's result is. Not recorded: a graph without an owner or of a visitor without an
 * account, an output whose file is gone, and a key outside `results/<graphId>/`. A history that cannot be written for one
 * output is logged and the others are still recorded; nothing here throws.
 */
export async function recordGraphOutputsInHistory(state: GraphExecutionState): Promise<void> {
  const { graphId, ownerUserId } = state;
  if (!ownerUserId || isAnonymousUserId(ownerUserId)) return;
  const ttlMs = resolveRetentionPolicy().undeliveredTtlMs;
  for (const [nodeId, node] of Object.entries(state.graph.nodes)) {
    const nodeState = state.nodes[nodeId];
    if (node.op !== 'export.internal' || nodeState?.status !== 'completed') continue;
    for (const [index, storageKey] of nodeState.outputs.entries()) {
      if (!storageKey.startsWith(`results/${graphId}/`)) continue;
      try {
        const stat = await storageProvider.stat(storageKey);
        if (!stat) continue;
        const fileName = stat.filename || path.basename(storageKey);
        await redisKeyStore.recordUserFile({
          id: outputRecordId(graphId, nodeId, index),
          userId: ownerUserId,
          fileName,
          fromFormat: state.sourceFormat ?? '',
          toFormat: path.extname(fileName).slice(1).toLowerCase(),
          size: stat.size,
          downloadUrl: `/api/storage/file/${encodeURIComponent(storageKey)}`,
          storageKey,
          graphId,
          ttlMs,
        });
      } catch (err) {
        console.error(`[GraphScheduler] Failed to record the output ${storageKey} of graph ${graphId} in the file history:`, err);
      }
    }
  }
}
