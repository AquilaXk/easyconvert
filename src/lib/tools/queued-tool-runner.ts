import crypto from 'node:crypto';
import type { Job } from '../queue/bullmq-engine';
import { JobCancelledError } from '../queue/bullmq-engine';
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

  if (!isTransientWait) {
    const current = await getToolJob(job.id);
    if (current?.status === 'cancelled' || job.signal?.aborted) {
      await cleanupQueuedToolUploads(rootStorage, cleanupKeys);
      throw new JobCancelledError('Tool job cancelled before execution');
    }
    await saveToolJob({ ...(current ?? baseState), status: 'running', progress: 25 });
  }

  const scope = scopeStorageObjects(rootStorage);
  const storage = scope.storage;

  try {
    job.signal?.throwIfAborted();
    const files: WebToolFile[] = await Promise.all(
      payload.storedRefs.map(async (ref) => {
        const stored = await storage.getObject(ref.key);
        if (!stored) {
          throw new Error(`Input storage object missing for key "${ref.key}".`);
        }
        return { name: ref.name, buffer: stored.buffer };
      })
    );

    assertToolInput(toolName, files);
    const openedOptions = openPasswordOption(payload.options, job.id) as WebToolOptions;
    const output = await runWebTool(toolName, files, openedOptions, job.signal);

    if (!isTransientWait) {
      const afterRun = await getToolJob(job.id);
      if (afterRun?.status === 'cancelled' || job.signal?.aborted) {
        await cleanupQueuedToolUploads(rootStorage, cleanupKeys);
        throw new JobCancelledError('Tool job cancelled');
      }
    } else {
      job.signal?.throwIfAborted();
    }

    const storedResult = await storeQueuedToolOutput(rootStorage, output, ownerUserId);
    await cleanupQueuedToolUploads(rootStorage, cleanupKeys);

    if (!isTransientWait) {
      const latest = await getToolJob(job.id);
      await saveToolJob({
        ...(latest ?? baseState),
        status: 'completed',
        progress: 100,
        result: storedResult,
      });
    }

    const primaryFile = storedResult.kind === 'file' ? storedResult.file : undefined;
    const firstEntry = storedResult.kind === 'entries' ? storedResult.entries[0] : undefined;
    return {
      jobId: job.id,
      status: 'completed',
      downloadUrl: primaryFile?.url ?? firstEntry?.url ?? '',
      resultKey: primaryFile?.key ?? firstEntry?.key ?? '',
      filename: primaryFile?.name ?? `${toolName}-entries`,
      mimeType: output.kind === 'file' ? output.mimeType : (firstEntry?.mimeType ?? 'application/octet-stream'),
      size: primaryFile?.size ?? storedResult.entries.reduce((sum, entry) => sum + entry.size, 0),
      durationMs: Date.now() - startedAt,
      toolResult: storedResult,
    };
  } catch (err: unknown) {
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

    // Only remove temporary uploads and mark ToolJobState failed when no queue retry remains.
    const maxAttempts = job.opts?.attempts ?? 1;
    const willRetry = (job.attemptsMade + 1) < maxAttempts;
    if (!willRetry) {
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
  } finally {
    await scope.releaseAll();
  }
}
