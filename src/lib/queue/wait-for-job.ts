import crypto from 'node:crypto';
import { inspectArchive } from '../conversions';
import { dispatchConversion } from '../conversions/dispatch';
import { CONVERSION_REFUSAL_CODES, isCodeOf, type ConversionRefusalCode } from '../refusal-codes';
import { maskServerText } from '../security/server-paths';
import { storageProvider } from '../storage';
import { StorageNotFoundError } from '../storage/adapters/adapter-interface';
import { eraseOwnedFile } from '../storage/retention-service';
import type { WorkerConversionResult, WorkerEngineOptions } from '../../worker/worker-types';
import type {
  ArchiveInspectResponse,
  ConversionJobData,
  ConversionJobResult,
} from '../types';
import {
  ArchiveEncryptedHeaderError,
  ArchiveInputUnprocessableError,
  ConversionFailedError,
  EncryptedOfficeDocumentError,
  EngineMissingError,
  MissingVolumeError,
  PayloadLimitError,
  QueueUnavailableError,
  WORKER_OUTPUT_MISSING_DETAIL,
  WorkerOutputMissingError,
} from '../types';
import type { Job, JobState } from './bullmq-engine';
import { sanitizeNodeOutputFilename } from './graph/node-jobs';
import { cancelJobAcrossQueues, conversionQueue, getQueueForResourceClass } from './conversion-queue';
import { resolveResourceClass, tierToPriority } from './resource-class';
import {
  failedTelemetryFieldsFromPayload,
  subscribeToJobTelemetry,
  type JobTelemetryEvent,
} from './job-telemetry';
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
const CANCEL_SETTLE_MAX_MS = 1_000;
const CANCEL_SETTLE_STEP_MS = 50;
const MAX_CANCEL_SETTLE_STEPS = Math.floor(CANCEL_SETTLE_MAX_MS / CANCEL_SETTLE_STEP_MS);
const HTTP_BAD_REQUEST_MIN = 400;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_UNPROCESSABLE_ENTITY = 422;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const HTTP_MAX_STATUS = 599;
const INTERNAL_ERROR_DETAIL = 'Internal conversion error';

type QueueEngine = ReturnType<typeof getQueueForResourceClass>;

export interface RehydrateQueuedFailureInfo {
  message?: string;
  failedCode?: string;
  failedStatus?: number;
  failedRefusalCode?: string;
}

/**
 * Rehydrates a queued worker failure on the control plane using only allowlisted refusal codes and finite HTTP error
 * statuses, preserving typed 413/422/503/WorkerOutputMissingError subclasses for route error handlers. Server faults
 * (>= 500) and untyped crashes are replaced with a generic message so internal paths never leak or collapse to HTTP 400.
 */
export function rehydrateQueuedJobFailure(info: RehydrateQueuedFailureInfo): Error {
  const refusalCode = isCodeOf(CONVERSION_REFUSAL_CODES, info.failedRefusalCode)
    ? info.failedRefusalCode
    : undefined;
  const status =
    typeof info.failedStatus === 'number' &&
    Number.isFinite(info.failedStatus) &&
    info.failedStatus >= HTTP_BAD_REQUEST_MIN &&
    info.failedStatus <= HTTP_MAX_STATUS
      ? info.failedStatus
      : undefined;
  const code = typeof info.failedCode === 'string' && info.failedCode ? info.failedCode : 'ConversionFailedError';

  if (
    info.failedCode === 'EngineMissingError' ||
    info.failedCode === 'EngineUnavailableError' ||
    refusalCode === 'engine_unavailable'
  ) {
    return new EngineMissingError(maskServerText(info.message || 'Engine unavailable.'));
  }

  if (info.failedCode === 'WorkerOutputMissingError') {
    return new WorkerOutputMissingError(WORKER_OUTPUT_MISSING_DETAIL);
  }

  if (refusalCode !== undefined && status !== undefined && status < HTTP_INTERNAL_SERVER_ERROR) {
    const maskedMessage = maskServerText(info.message || 'Queued conversion failed.');
    if (status === HTTP_PAYLOAD_TOO_LARGE) {
      const err = new PayloadLimitError(maskedMessage);
      err.name = code;
      (err as { refusalCode: ConversionRefusalCode }).refusalCode = refusalCode;
      return err;
    }
    if (status === HTTP_UNPROCESSABLE_ENTITY) {
      let err: ConversionFailedError;
      if (info.failedCode === 'ArchiveEncryptedHeaderError') {
        err = new ArchiveEncryptedHeaderError(maskedMessage);
      } else if (info.failedCode === 'MissingVolumeError' || refusalCode === 'missing_volume') {
        err = new MissingVolumeError('', maskedMessage);
      } else if (refusalCode === 'encrypted_input') {
        err = new EncryptedOfficeDocumentError(maskedMessage);
      } else {
        err = new ArchiveInputUnprocessableError(maskedMessage);
      }
      err.name = code;
      (err as { refusalCode: ConversionRefusalCode }).refusalCode = refusalCode;
      return err;
    }
    const err = new ConversionFailedError(maskedMessage);
    err.name = code;
    (err as { status?: number }).status = status;
    (err as { refusalCode?: ConversionRefusalCode }).refusalCode = refusalCode;
    return err;
  }

  const serverStatus =
    status !== undefined && status >= HTTP_INTERNAL_SERVER_ERROR ? status : HTTP_INTERNAL_SERVER_ERROR;
  if (refusalCode !== undefined) {
    const err = new ConversionFailedError(INTERNAL_ERROR_DETAIL);
    err.name = code;
    (err as { status?: number }).status = serverStatus;
    (err as { refusalCode?: ConversionRefusalCode }).refusalCode = refusalCode;
    return err;
  }

  const err = new Error(INTERNAL_ERROR_DETAIL);
  (err as { status?: number }).status = serverStatus;
  return err;
}

async function readJobAcrossQueues(
  targetQueue: QueueEngine,
  jobId: string
): Promise<Job<ConversionJobData, ConversionJobResult> | undefined> {
  const direct = await targetQueue.getJob(jobId);
  if (direct || targetQueue === conversionQueue) return direct;
  return conversionQueue.getJob(jobId);
}

async function jobStateOf(job: Job<ConversionJobData, ConversionJobResult>): Promise<JobState> {
  return typeof job.getState === 'function' ? await job.getState() : job.state;
}

async function tryReadJobAcrossQueues(
  targetQueue: QueueEngine,
  jobId: string
): Promise<{ ok: true; job: Job<ConversionJobData, ConversionJobResult> | undefined } | { ok: false }> {
  try {
    return { ok: true, job: await readJobAcrossQueues(targetQueue, jobId) };
  } catch {
    return { ok: false };
  }
}

async function settleQueueOnlyCleanup(params: {
  targetQueue: QueueEngine;
  jobId: string;
  inputKeys: readonly string[];
  resultKeysToErase: readonly string[];
  aborted: boolean;
  pendingCancel?: Promise<unknown>;
}): Promise<void> {
  const { targetQueue, jobId, inputKeys, resultKeysToErase, aborted, pendingCancel } = params;
  if (aborted) {
    await (
      pendingCancel ??
      cancelJobAcrossQueues(jobId, 'Synchronous caller disconnected or timed out').catch(() => undefined)
    );
    for (let step = 0; step < MAX_CANCEL_SETTLE_STEPS; step++) {
      const probe = await tryReadJobAcrossQueues(targetQueue, jobId);
      if (probe.ok && (!probe.job || (await jobStateOf(probe.job)) !== 'active')) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, CANCEL_SETTLE_STEP_MS));
    }
  }

  const finalProbe = await tryReadJobAcrossQueues(targetQueue, jobId);
  const settledNotActive = finalProbe.ok
    ? !finalProbe.job || (await jobStateOf(finalProbe.job)) !== 'active'
    : !aborted;
  if (settledNotActive) {
    await Promise.all(
      inputKeys.map((key) => Promise.resolve().then(() => storageProvider.deleteObject(key)).catch(() => undefined))
    );
    await targetQueue.remove(jobId).catch(() => undefined);
  }

  await Promise.all(
    resultKeysToErase.map((key) => eraseOwnedFile(storageProvider, key).catch(() => undefined))
  );
}

async function waitForQueuedJobResult(
  jobId: string,
  signal?: AbortSignal,
  targetQueue: QueueEngine = conversionQueue,
  onCancelStarted?: (promise: Promise<unknown>) => void
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
      const payload = (ev.data ?? {}) as Record<string, unknown> & {
        result?: ConversionJobResult;
        error?: unknown;
      };
      if (ev.event === 'completed' && payload.result) {
        finishResolve(payload.result);
      } else if (ev.event === 'failed') {
        const failedFields = failedTelemetryFieldsFromPayload(payload);
        finishReject(
          rehydrateQueuedJobFailure({
            message: typeof payload.error === 'string' && payload.error ? payload.error : undefined,
            ...failedFields,
          })
        );
      } else if (ev.event === 'cancelled') {
        const message = typeof payload.error === 'string' && payload.error ? payload.error : 'Job cancelled.';
        finishReject(signal?.aborted ? signal.reason : new ConversionFailedError(message));
      }
    };

    const onAbort = (): void => {
      const cancelPromise = cancelJobAcrossQueues(jobId, 'Synchronous caller disconnected or timed out').catch(
        () => undefined
      );
      onCancelStarted?.(cancelPromise);
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
        const job = await readJobAcrossQueues(targetQueue, jobId);
        if (!job) return;
        const state = await jobStateOf(job);
        if (state === 'completed' && job.returnvalue) {
          finishResolve(job.returnvalue);
        } else if (state === 'failed') {
          finishReject(
            rehydrateQueuedJobFailure({
              message: job.failedReason || undefined,
              failedCode: job.failedCode,
              failedStatus: job.failedStatus,
              failedRefusalCode: job.failedRefusalCode,
            })
          );
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
  let enqueued = false;
  let pendingCancel: Promise<unknown> | undefined;
  try {
    await enqueueConversionJob(
      targetQueue,
      'convert',
      jobData,
      { jobId, priority: tierToPriority(params.tier) },
      { tier: params.tier, inputBytes: params.inputBuffer.length, notAfter: deadlineAt }
    );
    enqueued = true;
    const jobResult = await waitForQueuedJobResult(jobId, signal, targetQueue, (promise) => {
      pendingCancel = promise;
    });
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
    await settleQueueOnlyCleanup({
      targetQueue,
      jobId,
      inputKeys: [tempInputKey],
      resultKeysToErase: resultKeyToErase ? [resultKeyToErase] : [],
      aborted: Boolean(signal?.aborted || pendingCancel) && enqueued,
      pendingCancel,
    });
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
  const sourceFormat = webToolResourceFormat(params.tool);
  const resClass = resolveResourceClass(sourceFormat, sourceFormat, totalBytes, {});
  const targetQueue = getQueueForResourceClass(resClass);

  let resultKeysToErase: string[] = [];
  let enqueued = false;
  let pendingCancel: Promise<unknown> | undefined;
  try {
    for (let i = 0; i < params.files.length; i++) {
      const file = params.files[i];
      const safeName = sanitizeNodeOutputFilename(file.name, `input_${i + 1}.bin`);
      const key = stagedInputKey(params.userId, `synctool_${jobId}_${i}_${safeName}`);
      await storageProvider.saveObject(key, file.buffer, 'application/octet-stream', safeName);
      storedRefs.push({ key, name: file.name });
      cleanupKeys.push(key);
    }

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
    enqueued = true;

    const completed = await waitForQueuedJobResult(jobId, params.signal, targetQueue, (promise) => {
      pendingCancel = promise;
    });
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
    await settleQueueOnlyCleanup({
      targetQueue,
      jobId,
      inputKeys: cleanupKeys,
      resultKeysToErase,
      aborted: Boolean(params.signal?.aborted || pendingCancel) && enqueued,
      pendingCancel,
    });
  }
}

export interface SyncArchiveInspectParams {
  archiveBuffer?: Buffer;
  storageKey?: string;
  inputBytes: number;
  filename?: string;
  password?: string;
  userId: string;
  tier: string;
  signal?: AbortSignal;
  deadlineAt?: number;
}

export async function dispatchSyncArchiveInspection(
  params: SyncArchiveInspectParams
): Promise<ArchiveInspectResponse> {
  if (!isQueueOnlyWebMode()) {
    if (params.archiveBuffer) {
      return inspectArchive(params.archiveBuffer, {
        filename: params.filename,
        password: params.password,
        signal: params.signal,
      });
    }
    if (!params.storageKey) {
      throw new ConversionFailedError('Archive buffer or storageKey is required for inspection.');
    }
    const stored = await storageProvider.getObject(params.storageKey);
    if (!stored) {
      throw new StorageNotFoundError(params.storageKey, storageProvider.providerName);
    }
    try {
      return await inspectArchive(stored.buffer, {
        filename: params.filename ?? stored.filename,
        password: params.password,
        signal: params.signal,
      });
    } finally {
      await stored.release?.().catch(() => undefined);
    }
  }

  if (!(await hasLiveQueueWorker())) {
    throw new QueueUnavailableError(
      'worker-pool',
      'No live conversion worker is available to process WEB_EXECUTION_MODE=queue-only archive inspections.'
    );
  }

  params.signal?.throwIfAborted();
  const jobId = `syncinspect_${crypto.randomUUID()}`;
  const inputKeys: string[] = [];
  let effectiveStorageKey = params.storageKey;
  const resourceClass = resolveResourceClass('zip', 'zip', params.inputBytes, {});
  const targetQueue = getQueueForResourceClass(resourceClass);
  let enqueued = false;
  let pendingCancel: Promise<unknown> | undefined;
  try {
    if (!effectiveStorageKey) {
      if (!params.archiveBuffer) {
        throw new ConversionFailedError('Archive buffer or storageKey is required for inspection.');
      }
      const safeName = sanitizeNodeOutputFilename(params.filename ?? 'archive.zip', 'archive.zip');
      const tempInputKey = stagedInputKey(params.userId, `sync_inspect_${jobId}_${safeName}`);
      await storageProvider.saveObject(tempInputKey, params.archiveBuffer, 'application/octet-stream', safeName);
      effectiveStorageKey = tempInputKey;
      inputKeys.push(tempInputKey);
    }

    await enqueueConversionJob(
      targetQueue,
      'archive-inspect-sync',
      {
        jobId,
        originalFilename: params.filename ?? 'archive',
        sourceFormat: 'zip',
        targetFormat: 'zip',
        fileSize: params.inputBytes,
        options: {},
        userId: params.userId,
        resourceClass,
        transientSyncWait: true,
        archiveInspect: {
          storageKey: effectiveStorageKey,
          ...(params.filename ? { filename: params.filename } : {}),
          ...(params.password ? { options: { password: params.password } } : {}),
        },
      },
      { jobId, priority: tierToPriority(params.tier) },
      { tier: params.tier, inputBytes: params.inputBytes, notAfter: params.deadlineAt }
    );
    enqueued = true;

    const completed = await waitForQueuedJobResult(jobId, params.signal, targetQueue, (promise) => {
      pendingCancel = promise;
    });
    if (!completed.archiveInspection) {
      throw new ConversionFailedError('Worker completed archive inspection without returning archiveInspection.');
    }
    return completed.archiveInspection as ArchiveInspectResponse;
  } finally {
    await settleQueueOnlyCleanup({
      targetQueue,
      jobId,
      inputKeys,
      resultKeysToErase: [],
      aborted: Boolean(params.signal?.aborted || pendingCancel) && enqueued,
      pendingCancel,
    });
  }
}
