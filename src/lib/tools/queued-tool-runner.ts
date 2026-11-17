import crypto from 'node:crypto';
import type { Job } from '../queue/bullmq-engine';
import { JobCancelledError } from '../queue/bullmq-engine';
import { isFinalFailure } from '../queue/job-failure';
import { sanitizeNodeOutputFilename } from '../queue/graph/node-jobs';
import { openPasswordOption } from '../queue/option-secrets';
import type { IStorageBackend } from '../storage/oci-storage';
import { isUploadKey } from '../storage/key-namespace';
import { saveRetainedResult } from '../storage/retention-service';
import { scopeStorageObjects } from '../storage/scoped-storage';
import type { ConversionJobData, ConversionJobResult } from '../types';
import type { WebTool, WebToolOptions } from './tool-names';
import { getToolJob, saveToolJob, type StoredToolJobResult, type ToolJobState } from './tool-job-store';
import { assertToolInput, runWebTool, type WebToolFile, type WebToolOutput } from './web-tools';

export async function storeQueuedToolOutput(
  storage: IStorageBackend,
  output: WebToolOutput,
  ownerUserId: string
): Promise<StoredToolJobResult> {
  if (output.kind === 'file') {
    const safeName = sanitizeNodeOutputFilename(output.filename, 'output.bin');
    const storageKey = `conversions/${ownerUserId}/${crypto.randomUUID()}_${safeName}`;
    await saveRetainedResult(storage, storageKey, output.buffer, output.mimeType, safeName);
    return {
      kind: 'file',
      file: {
        name: output.filename,
        size: output.buffer.length,
        key: storageKey,
        url: `/api/storage/file/${encodeURIComponent(storageKey)}`,
      },
    };
  }
  const entries = await Promise.all(
    output.entries.map(async (entry, index) => {
      const safeName = sanitizeNodeOutputFilename(entry.name, `file_${index + 1}`);
      const storageKey = `conversions/${ownerUserId}/${crypto.randomUUID()}_${safeName}`;
      await saveRetainedResult(storage, storageKey, entry.buffer, entry.mimeType, safeName);
      return {
        name: entry.name,
        size: entry.size,
        mimeType: entry.mimeType,
        key: storageKey,
        url: `/api/storage/file/${encodeURIComponent(storageKey)}`,
      };
    })
  );
  return { kind: 'entries', entries };
}

export async function cleanupQueuedToolUploads(
  storage: IStorageBackend,
  keys: readonly string[] | undefined
): Promise<void> {
  if (!keys || keys.length === 0) return;
  await Promise.all(
    keys
      .filter((key) => isUploadKey(key))
      .map((key) => Promise.resolve().then(() => storage.deleteObject(key)).catch(() => undefined))
  );
}

async function markToolJobRunningOrThrow(
  job: Job<ConversionJobData, ConversionJobResult>,
  rootStorage: IStorageBackend,
  baseState: ToolJobState,
  cleanupKeys: readonly string[],
  isTransientWait: boolean
): Promise<void> {
  if (isTransientWait) return;
  const current = await getToolJob(job.id);
  if (current?.status === 'cancelled' || job.signal?.aborted) {
    await cleanupQueuedToolUploads(rootStorage, cleanupKeys);
    throw new JobCancelledError('Tool job cancelled before execution');
  }
  await saveToolJob({ ...(current ?? baseState), status: 'running', progress: 25 });
}

async function loadQueuedToolFiles(
  storage: IStorageBackend,
  storedRefs: ReadonlyArray<{ key: string; name: string }>
): Promise<WebToolFile[]> {
  return Promise.all(
    storedRefs.map(async (ref) => {
      const stored = await storage.getObject(ref.key);
      if (!stored) throw new Error(`Input storage object missing for key "${ref.key}".`);
      return { name: ref.name, buffer: stored.buffer };
    })
  );
}

async function assertNotCancelledAfterRun(
  job: Job<ConversionJobData, ConversionJobResult>,
  rootStorage: IStorageBackend,
  cleanupKeys: readonly string[],
  isTransientWait: boolean
): Promise<void> {
  if (isTransientWait) {
    job.signal?.throwIfAborted();
    return;
  }
  const afterRun = await getToolJob(job.id);
  if (afterRun?.status === 'cancelled' || job.signal?.aborted) {
    await cleanupQueuedToolUploads(rootStorage, cleanupKeys);
    throw new JobCancelledError('Tool job cancelled');
  }
}

function buildQueuedToolConversionResult(
  jobId: string,
  toolName: WebTool,
  output: WebToolOutput,
  storedResult: StoredToolJobResult,
  startedAt: number
): ConversionJobResult {
  if (storedResult.kind === 'file') {
    return {
      jobId,
      status: 'completed',
      downloadUrl: storedResult.file.url,
      resultKey: storedResult.file.key ?? '',
      filename: storedResult.file.name,
      mimeType: output.kind === 'file' ? output.mimeType : 'application/octet-stream',
      size: storedResult.file.size,
      durationMs: Date.now() - startedAt,
      toolResult: storedResult,
    };
  }
  const firstEntry = storedResult.entries[0];
  return {
    jobId,
    status: 'completed',
    downloadUrl: firstEntry?.url ?? '',
    resultKey: firstEntry?.key ?? '',
    filename: `${toolName}-entries`,
    mimeType: firstEntry?.mimeType ?? 'application/octet-stream',
    size: storedResult.entries.reduce((sum, entry) => sum + entry.size, 0),
    durationMs: Date.now() - startedAt,
    toolResult: storedResult,
  };
}

async function handleQueuedToolFailure(
  err: unknown,
  job: Job<ConversionJobData, ConversionJobResult>,
  rootStorage: IStorageBackend,
  baseState: ToolJobState,
  cleanupKeys: readonly string[],
  isTransientWait: boolean
): Promise<never> {
  const aborted = Boolean(job.signal?.aborted || err instanceof JobCancelledError);
  if (aborted) {
    await cleanupQueuedToolUploads(rootStorage, cleanupKeys);
    if (!isTransientWait) {
      const latest = await getToolJob(job.id);
      if (latest && latest.status !== 'completed') {
        await saveToolJob({ ...latest, status: 'cancelled' }).catch(() => undefined);
      }
    }
    throw err instanceof JobCancelledError ? err : new JobCancelledError('Tool job cancelled');
  }

  if (isFinalFailure(job, err)) {
    await cleanupQueuedToolUploads(rootStorage, cleanupKeys);
    if (!isTransientWait) {
      const latest = await getToolJob(job.id);
      await saveToolJob({
        ...(latest ?? baseState),
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      }).catch(() => undefined);
    }
  }
  throw err;
}

/**
 * Executes a queued `/api/tools/jobs` (or stateless `queue-only` `/api/tools/*`) job inside a Worker
 * with full `AbortSignal` cancellation propagation, temporary upload cleanup, and Redis state sync.
 */
export async function processQueuedToolJob(
  job: Job<ConversionJobData, ConversionJobResult>,
  rootStorage: IStorageBackend
): Promise<ConversionJobResult> {
  const payload = job.data.toolJob!;
  const toolName = payload.tool as WebTool;
  const ownerUserId = job.data.userId || 'anonymous';
  const isTransientWait = job.data.transientSyncWait === true;
  const startedAt = Date.now();
  const cleanupKeys = payload.cleanupUploadKeys ?? payload.storedRefs.map((ref) => ref.key);

  const baseState: ToolJobState = {
    id: job.id,
    userId: ownerUserId,
    tool: toolName,
    status: 'queued',
    progress: 0,
    createdAt: job.timestamp || startedAt,
  };

  await markToolJobRunningOrThrow(job, rootStorage, baseState, cleanupKeys, isTransientWait);

  const scope = scopeStorageObjects(rootStorage);
  try {
    job.signal?.throwIfAborted();
    const files = await loadQueuedToolFiles(scope.storage, payload.storedRefs);
    assertToolInput(toolName, files);
    const openedOptions = openPasswordOption(payload.options, job.id) as WebToolOptions;
    const output = await runWebTool(toolName, files, openedOptions, job.signal);
    await assertNotCancelledAfterRun(job, rootStorage, cleanupKeys, isTransientWait);

    const storedResult = await storeQueuedToolOutput(rootStorage, output, ownerUserId);
    await cleanupQueuedToolUploads(rootStorage, cleanupKeys);

    if (!isTransientWait) {
      const latest = await getToolJob(job.id);
      await saveToolJob({ ...(latest ?? baseState), status: 'completed', progress: 100, result: storedResult });
    }
    return buildQueuedToolConversionResult(job.id, toolName, output, storedResult, startedAt);
  } catch (err: unknown) {
    return await handleQueuedToolFailure(err, job, rootStorage, baseState, cleanupKeys, isTransientWait);
  } finally {
    await scope.releaseAll();
  }
}
