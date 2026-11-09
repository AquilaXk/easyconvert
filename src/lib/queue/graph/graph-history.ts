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

/** Most outputs of one graph put in the history: a fifth of the 500 records a user keeps, so one graph (an archive with thousands of entries) cannot push out the rest of the history. */
export const MAX_RECORDED_OUTPUTS_PER_GRAPH = 100;
/** Outputs recorded at once: enough to hide the latency of the store, few enough not to flood it. */
export const RECORD_BATCH_SIZE = 8;
/** How long the whole step may take before the end of the graph goes on to its webhook and cleanup. */
export const RECORD_STEP_TIMEOUT_MS = 5000;

export interface RecordGraphOutputsOptions {
  maxOutputs?: number;
  timeoutMs?: number;
}

async function recordOutput(state: GraphExecutionState, ownerUserId: string, nodeId: string, index: number, storageKey: string, ttlMs: number): Promise<void> {
  const { graphId } = state;
  try {
    const stat = await storageProvider.stat(storageKey);
    if (!stat) return;
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

/** The final outputs of `state`: the stored files of its completed `export.internal` nodes that lie under `results/<graphId>/`. */
function finalOutputs(state: GraphExecutionState): { nodeId: string; index: number; storageKey: string }[] {
  const outputs: { nodeId: string; index: number; storageKey: string }[] = [];
  for (const [nodeId, node] of Object.entries(state.graph.nodes)) {
    const nodeState = state.nodes[nodeId];
    if (node.op !== 'export.internal' || nodeState?.status !== 'completed') continue;
    for (const [index, storageKey] of nodeState.outputs.entries()) {
      if (storageKey.startsWith(`results/${state.graphId}/`)) outputs.push({ nodeId, index, storageKey });
    }
  }
  return outputs;
}

/**
 * Puts the final outputs of a completed graph in the history of converted files of its owner (`/api/account/files`): the
 * stored files of its `export.internal` nodes, which are the results the graph returns (the intermediate files of the other
 * nodes are removed when the graph ends). Each is recorded under its own stable id with the storage key it lives at and the
 * graph's id, and is kept as long as a job's result is. Not recorded: a graph without an owner or of a visitor without an
 * account, an output whose file is gone, and a key outside `results/<graphId>/`. The step is bounded, as the webhook and the
 * cleanup of the graph wait for it: at most `maxOutputs` outputs (the rest is logged with its count), recorded
 * RECORD_BATCH_SIZE at a time, and at most `timeoutMs` for all of it (what is recorded by then stays, the rest is logged). A
 * history that cannot be written for one output is logged and the others are still recorded; nothing here throws.
 */
export async function recordGraphOutputsInHistory(state: GraphExecutionState, options: RecordGraphOutputsOptions = {}): Promise<void> {
  const { graphId, ownerUserId } = state;
  if (!ownerUserId || isAnonymousUserId(ownerUserId)) return;
  const { maxOutputs = MAX_RECORDED_OUTPUTS_PER_GRAPH, timeoutMs = RECORD_STEP_TIMEOUT_MS } = options;
  const all = finalOutputs(state);
  const outputs = all.slice(0, maxOutputs);
  if (all.length > outputs.length) console.error(`[GraphScheduler] Graph ${graphId} has ${all.length} final outputs; ${all.length - outputs.length} were not put in the file history (limit ${maxOutputs}).`);
  const ttlMs = resolveRetentionPolicy().undeliveredTtlMs;
  let expired = false;
  const recordAll = async () => {
    for (let start = 0; start < outputs.length && !expired; start += RECORD_BATCH_SIZE) {
      await Promise.all(outputs.slice(start, start + RECORD_BATCH_SIZE).map((o) => recordOutput(state, ownerUserId, o.nodeId, o.index, o.storageKey, ttlMs)));
    }
  };
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    if ((await Promise.race([recordAll(), timedOut])) === 'timeout') {
      expired = true;
      console.error(`[GraphScheduler] Recording the outputs of graph ${graphId} in the file history took longer than ${timeoutMs} ms; the end of the graph goes on.`);
    }
  } finally {
    clearTimeout(timer);
  }
}
