import crypto from 'node:crypto';
import { dispatchConversion } from '../conversions/dispatch';
import { storageProvider } from '../storage';
import { eraseOwnedFile } from '../storage/retention-service';
import type { WorkerConversionResult, WorkerEngineOptions } from '../../worker/worker-types';
import type {
  ConversionJobData,
  ConversionJobResult,
} from '../types';
import { ConversionFailedError, QueueUnavailableError } from '../types';
import { sanitizeNodeOutputFilename } from './graph/node-jobs';
import { cancelJobAcrossQueues, conversionQueue, getQueueForResourceClass } from './conversion-queue';
import { resolveResourceClass, tierToPriority } from './resource-class';
import { subscribeToJobTelemetry, type JobTelemetryEvent } from './job-telemetry';
import { enqueueConversionJob } from './enqueue';
import { hasLiveQueueWorker, isQueueOnlyWebMode } from './worker-presence';
import { stagedInputKey } from '../storage/key-namespace';
import type { StoredToolJobResult } from '../tools/tool-job-store';
import type { WebTool } from '../tools/tool-names';
import { runWebTool, type WebToolFile, type WebToolOptions, type WebToolOutput } from '../tools/web-tools';

/**
 * Stateless Web control-plane wait helper (`WEB_EXECUTION_MODE=queue-only`, Reference Service `wait=true` model).
 *
 * When `WEB_EXECUTION_MODE=queue-only`, Web replicas never execute native conversion engines or heavy tool buffers
 * in-process: they stage inputs into shared storage, enqueue onto the Worker fleet via `enqueueConversionJob`,
 * subscribe to completion/failure events (backed by bounded Redis polling), and propagate request/deadline aborts
 * via `cancelJobAcrossQueues`.
 */

/** Resolves the format family used to select a resource-class queue for a web tool run. */
export function webToolResourceFormat(tool: WebTool): 'zip' | 'pdf' {
  return tool === 'archive-extract' || tool === 'archive-create' ? 'zip' : 'pdf';
}

const POLL_INTERVAL_MS = 120;

async function waitForQueuedJobResult(
  jobId: string,
  signal?: AbortSignal,
  targetQueue: ReturnType<typeof getQueueForResourceClass> = conversionQueue
): Promise<ConversionJobResult> {
  signal?.throwIfAborted();

  return new Promise<ConversionJobResult>((resolve, reject) => {
    let settled = false;
    let pollTimer: NodeJS.Timeout | null = null;
    const unsubscribers: Array<() => void> = [];

    const cleanup = (): void => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      while (unsubscribers.length > 0) {
        unsubscribers.pop()?.();
      }
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    const finishResolve = (result: ConversionJobResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const finishReject = (err: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onTelemetryEvent = (ev: JobTelemetryEvent): void => {
      const payload = (ev.data ?? {}) as { result?: ConversionJobResult; error?: unknown };
      if (ev.event === 'completed' && payload.result) {
        finishResolve(payload.result);
      } else if (ev.event === 'failed') {
        const message = typeof payload.error === 'string' && payload.error ? payload.error : 'Queued conversion failed.';
        finishReject(new ConversionFailedError(message));
      } else if (ev.event === 'cancelled') {
        const message = typeof payload.error === 'string' && payload.error ? payload.error : 'Job cancelled.';
        finishReject(signal?.aborted ? signal.reason : new ConversionFailedError(message));
      }
    };

    const onAbort = (): void => {
      void cancelJobAcrossQueues(jobId, 'Synchronous caller disconnected or timed out').catch(() => undefined);
      finishReject(signal?.reason ?? new Error('The operation was aborted.'));
    };

    unsubscribers.push(subscribeToJobTelemetry(targetQueue, jobId, onTelemetryEvent));
    if (targetQueue !== conversionQueue) {
      unsubscribers.push(subscribeToJobTelemetry(conversionQueue, jobId, onTelemetryEvent));
    }
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const pollOnce = async (): Promise<void> => {
      if (settled) return;
      try {
        const job = await conversionQueue.getJob(jobId);
        if (!job) return;
        const state = await job.getState();
        if (state === 'completed' && job.returnvalue) {
          finishResolve(job.returnvalue);
        } else if (state === 'failed') {
          finishReject(new ConversionFailedError(job.failedReason || 'Queued conversion failed.'));
        } else if (state === 'cancelled') {
          finishReject(signal?.aborted ? signal.reason : new ConversionFailedError(job.failedReason || 'Job cancelled.'));
        }
      } catch {
        // Transient poll error; next tick or event listener will settle or deadline will abort.
      }
    };

    void pollOnce();
    pollTimer = setInterval(() => {
      void pollOnce();
    }, POLL_INTERVAL_MS);
    pollTimer.unref?.();
  });
}

export interface SyncConversionDispatchParams {
  inputBuffer: Buffer;
  sourceFormat: string;
  targetFormat: string;
  options: WorkerEngineOptions & { deadlineAt?: number };
  originalFilename: string;
  userId: string;
  tier: string;
}

export async function dispatchSyncRouteConversion(
  params: SyncConversionDispatchParams
): Promise<WorkerConversionResult> {
  if (!isQueueOnlyWebMode()) {
    return dispatchConversion(
      params.inputBuffer,
      params.sourceFormat,
      params.targetFormat,
      params.options,
      params.originalFilename
    );
  }

  if (!(await hasLiveQueueWorker())) {
    throw new QueueUnavailableError(
      'worker-pool',
      'No live conversion worker is available to process WEB_EXECUTION_MODE=queue-only requests.'
    );
  }

  const jobId = `sync_${crypto.randomUUID()}`;
  const safeName = sanitizeNodeOutputFilename(params.originalFilename, `input.${params.sourceFormat}`);
  const tempInputKey = stagedInputKey(params.userId, `sync_${jobId}_${safeName}`);
  await storageProvider.saveObject(tempInputKey, params.inputBuffer, 'application/octet-stream', safeName);

  const { signal, deadlineAt, ...serializableOptions } = params.options;
  const resourceClass = resolveResourceClass(
    params.sourceFormat,
    params.targetFormat,
    params.inputBuffer.length,
    serializableOptions
  );
  const jobData: ConversionJobData = {
    jobId,
    originalFilename: params.originalFilename,
    sourceFormat: params.sourceFormat,
    targetFormat: params.targetFormat,
    fileSize: params.inputBuffer.length,
    storageKey: tempInputKey,
    options: serializableOptions,
    userId: params.userId,
    resourceClass,
    transientSyncWait: true,
  };

  const targetQueue = getQueueForResourceClass(resourceClass);
  let resultKeyToErase: string | undefined;
  try {
    await enqueueConversionJob(
      targetQueue,
      'convert',
      jobData,
      { jobId, priority: tierToPriority(params.tier) },
      { tier: params.tier, inputBytes: params.inputBuffer.length, notAfter: deadlineAt }
    );
    const jobResult = await waitForQueuedJobResult(jobId, signal, targetQueue);
    resultKeyToErase = jobResult.resultKey;
    const stored = await storageProvider.getObject(jobResult.resultKey);
    if (!stored) {
      throw new ConversionFailedError('Worker completed conversion without a readable output object.');
    }
    try {
      const outputBuffer = Buffer.from(stored.buffer);
      return {
        buffer: outputBuffer,
        mimeType: jobResult.mimeType,
        filename: jobResult.filename,
        size: outputBuffer.length,
        engineUsed: (jobResult.engineUsed ?? 'internal-fallback') as WorkerConversionResult['engineUsed'],
        executionTimeMs: jobResult.durationMs,
        engine: jobResult.engine as WorkerConversionResult['engine'],
        engineVersion: jobResult.engineVersion,
        fallbackReason: jobResult.fallbackReason,
        sourceFrameCount: jobResult.sourceFrameCount,
        frameUsed: jobResult.frameUsed,
        metadata: {
          ...(jobResult.warnings ? { warnings: jobResult.warnings } : {}),
          ...(jobResult.droppedStreams ? { droppedStreams: jobResult.droppedStreams } : {}),
        },
      };
    } finally {
      await stored.release?.().catch(() => undefined);
    }
  } finally {
    await Promise.resolve().then(() => storageProvider.deleteObject(tempInputKey)).catch(() => undefined);
    if (resultKeyToErase) {
      await eraseOwnedFile(storageProvider, resultKeyToErase).catch(() => undefined);
    }
    await conversionQueue.remove(jobId).catch(() => undefined);
  }
}

export async function dispatchSyncWebTool(params: {
  tool: WebTool;
  files: WebToolFile[];
  options: WebToolOptions;
  userId: string;
  tier: string;
  signal?: AbortSignal;
  deadlineAt?: number;
}): Promise<WebToolOutput> {
  if (!isQueueOnlyWebMode()) {
    return runWebTool(params.tool, params.files, params.options, params.signal);
  }

  if (!(await hasLiveQueueWorker())) {
    throw new QueueUnavailableError(
      'worker-pool',
      'No live conversion worker is available to process WEB_EXECUTION_MODE=queue-only tool requests.'
    );
  }

  const jobId = `synctool_${crypto.randomUUID()}`;
  const totalBytes = params.files.reduce((sum, f) => sum + f.buffer.length, 0);
  const storedRefs: Array<{ key: string; name: string }> = [];
  const cleanupKeys: string[] = [];

  let resultKeysToErase: string[] = [];
  try {
    for (let i = 0; i < params.files.length; i++) {
      const file = params.files[i];
      const safeName = sanitizeNodeOutputFilename(file.name, `input_${i + 1}.bin`);
      const key = stagedInputKey(params.userId, `synctool_${jobId}_${i}_${safeName}`);
      await storageProvider.saveObject(key, file.buffer, 'application/octet-stream', safeName);
      storedRefs.push({ key, name: file.name });
      cleanupKeys.push(key);
    }

    const sourceFormat = webToolResourceFormat(params.tool);
    const resClass = resolveResourceClass(sourceFormat, sourceFormat, totalBytes, {});
    const targetQueue = getQueueForResourceClass(resClass);
    await enqueueConversionJob(
      targetQueue,
      'web-tool-sync',
      {
        jobId,
        originalFilename: params.tool,
        sourceFormat,
        targetFormat: sourceFormat,
        fileSize: totalBytes,
        options: {},
        userId: params.userId,
        resourceClass: resClass,
        transientSyncWait: true,
        toolJob: {
          tool: params.tool,
          options: (params.options ?? {}) as Record<string, unknown>,
          storedRefs,
          cleanupUploadKeys: cleanupKeys,
        },
      },
      { jobId, priority: tierToPriority(params.tier) },
      { tier: params.tier, inputBytes: totalBytes, notAfter: params.deadlineAt }
    );

    const completed = await waitForQueuedJobResult(jobId, params.signal, targetQueue);
    const toolResult = completed.toolResult as StoredToolJobResult | undefined;
    if (!toolResult) {
      throw new ConversionFailedError('Worker completed tool request without returning toolResult.');
    }
    if (toolResult.kind === 'file') {
      if (toolResult.file.key) resultKeysToErase.push(toolResult.file.key);
      const stored = toolResult.file.key ? await storageProvider.getObject(toolResult.file.key) : undefined;
      if (!stored) {
        throw new ConversionFailedError('Worker tool output file could not be read.');
      }
      try {
        return {
          kind: 'file',
          filename: toolResult.file.name,
          mimeType: completed.mimeType || stored.mimeType,
          buffer: Buffer.from(stored.buffer),
        };
      } finally {
        await stored.release?.().catch(() => undefined);
      }
    }
    resultKeysToErase = toolResult.entries.map((entry) => entry.key);
    const entries = await Promise.all(
      toolResult.entries.map(async (entry) => {
        const stored = await storageProvider.getObject(entry.key);
        if (!stored) {
          throw new ConversionFailedError(`Worker extracted entry "${entry.name}" could not be read.`);
        }
        try {
          return {
            name: entry.name,
            size: entry.size,
            mimeType: entry.mimeType,
            buffer: Buffer.from(stored.buffer),
          };
        } finally {
          await stored.release?.().catch(() => undefined);
        }
      })
    );
    return { kind: 'entries', entries };
  } finally {
    await Promise.all(
      cleanupKeys.map((key) => Promise.resolve().then(() => storageProvider.deleteObject(key)).catch(() => undefined))
    );
    await Promise.all(
      resultKeysToErase.map((key) => eraseOwnedFile(storageProvider, key).catch(() => undefined))
    );
    await conversionQueue.remove(jobId).catch(() => undefined);
  }
}
