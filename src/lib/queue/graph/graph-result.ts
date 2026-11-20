import path from 'node:path';
import { storageProvider } from '../../storage';
import type { ConversionJobResult } from '../../types';
import { finalOutputs } from './graph-history';
import type { GraphExecutionState } from './scheduler-types';

/**
 * The `result` of a graph job that completed, as the job API gives it for any other job: the first final output of the graph
 * (the stored file of its `export.internal` node under `results/<graphId>/`) with its download URL, name, type and size. A
 * pipeline submitted as a `tasks` array is a graph of one chain, so its caller reads the file here and not in a task report.
 * Undefined when the graph has not completed or kept no file; the type and size are left out when the store cannot stat the file.
 */
export async function graphJobResult(state: GraphExecutionState): Promise<Partial<ConversionJobResult> | undefined> {
  if (state.status !== 'completed') return undefined;
  const [first] = finalOutputs(state);
  if (first === undefined) return undefined;
  const stat = await Promise.resolve(storageProvider.stat(first.storageKey)).catch(() => null);
  return {
    jobId: state.graphId,
    status: 'completed',
    resultKey: first.storageKey,
    downloadUrl: `/api/storage/file/${encodeURIComponent(first.storageKey)}`,
    filename: stat?.filename || path.posix.basename(first.storageKey),
    ...(stat ? { mimeType: stat.mimeType, size: stat.size } : {}),
    ...(state.finishedAt !== undefined ? { durationMs: state.finishedAt - state.createdAt } : {}),
  };
}
