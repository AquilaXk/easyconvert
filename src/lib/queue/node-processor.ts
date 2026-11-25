import fs from 'node:fs';
import path from 'node:path';
import { JobCancelledError, type Job } from './bullmq-engine';
import { isFinalFailure } from './job-failure';
import {
  ConversionFailedError,
  type ConversionJobData,
  type ConversionJobResult,
  type ConversionOptions,
  type ConversionResult,
} from '../types';
import type { IStorageBackend, StoredObject } from '../storage/types';
import { storageProvider } from '../storage';
import { scopeStorageObjects } from '../storage/scoped-storage';
import { convertFile, inspectArchive } from '../conversions';
import { PayloadTooLargeForMemoryError, getMaxInMemoryBytes } from '../storage/errors';
import { secureShredBuffer } from '../security/memory-shredder';
import { resolveRetentionPolicy } from '../storage/result-retention';
import { registerStoredResult, releaseResultHold, takeInputHold } from '../storage/retention-service';
import { processGraphNodeJobIfAlive } from './graph/node-executor';
import type { ConversionEnginePort, EngineResult, VfsPayload } from './engine-port';
import { dispatchEngine } from './dispatch-engine';
import { deadlineBoundEngine } from './job-deadline';
import { frameMetadataFields } from '../api/frame-headers';
import { engineTraceFields } from '../api/engine-trace';
import { conversionWarningsFields } from '../api/conversion-warnings';
import { droppedStreamsFields } from '../api/dropped-streams';
import { assertConversionOptionsObject } from '../conversions/options-guard';
import { cleanupQueuedToolUploads, processQueuedToolJob } from '../tools/queued-tool-runner';
import { openPasswordOption } from './option-secrets';

export type { ConversionEnginePort, EngineResult, VfsPayload };

/**
 * In-process TypeScript conversion engine adapter.
 */
export const tsEngine: ConversionEnginePort = {
  name: 'ts-engine',
  async convert(
    input: Buffer | VfsPayload,
    sourceFormat: string,
    targetFormat: string,
    options: ConversionOptions & { signal?: AbortSignal; ocrEnabled?: boolean },
    originalFilename: string
  ): Promise<EngineResult> {
    const startTime = Date.now();
    let buf: Buffer;
    if (Buffer.isBuffer(input)) {
      buf = input;
    } else if (input && input.inputBuffer) {
      buf = input.inputBuffer;
    } else if (input && input.inputPath) {
      const stat = fs.statSync(input.inputPath);
      if (stat.size > getMaxInMemoryBytes()) {
        throw new PayloadTooLargeForMemoryError(
          `Payload size (${stat.size} bytes) exceeds in-memory buffer limit of ${getMaxInMemoryBytes()} bytes. Native worker required.`,
          { size: stat.size, limit: getMaxInMemoryBytes() }
        );
      }
      buf = fs.readFileSync(input.inputPath);
    } else {
      throw new Error('Invalid input payload: neither Buffer nor inputPath available.');
    }

    // The in-process engine cannot be interrupted once it runs: it must not start for an aborted job.
    options.signal?.throwIfAborted();
    const res: ConversionResult = await convertFile(
      buf,
      sourceFormat,
      targetFormat,
      options,
      originalFilename
    );

    return {
      buffer: res.buffer,
      size: res.size,
      mimeType: res.mimeType,
      filename: res.filename,
      engineUsed: 'ts-engine',
      executionTimeMs: Date.now() - startTime,
      ocrExtractedText: res.ocrExtractedText,
      sourceFrameCount: res.sourceFrameCount,
      frameUsed: res.frameUsed,
      metadata: res.metadata,
    };
  },
};

/**
 * Conversion engine adapter for the OCI worker: the shared dispatcher, which runs the native
 * engines (LibreOffice / FFmpeg / 7z / Poppler) and falls back in-process only where that is valid.
 */
export const nativeEngine: ConversionEnginePort = dispatchEngine;

/** Discards the temporary output file an aborted attempt produced on disk. */
function discardConversionOutput(jobId: string, result: EngineResult): void {
  if (!result.filePath) {
    return;
  }
  try {
    fs.rmSync(result.filePath, { force: true });
  } catch (err) {
    console.warn(
      `[NodeProcessor] Failed to discard output of aborted job ${jobId} at "${result.filePath}":`,
      err
    );
  }
}

/**
 * An attempt that learns after its save that it was aborted removes the result it stored, unless a later attempt has
 * stored its own under the key since, and fails. A save the signal stopped earlier stored nothing. A backend that cannot
 * tell two saves of a key apart keeps the result until it expires.
 */
async function discardResultOfAbortedAttempt(
  storage: IStorageBackend,
  resultKey: string,
  written: StoredObject,
  signal?: AbortSignal
): Promise<void> {
  if (!signal?.aborted) return;
  await storage.deleteObjectIfUnchanged?.(resultKey, written);
  signal.throwIfAborted();
}

function cleanupProcessorAttemptFiles(params: {
  jobId: string;
  intermediateFilePaths: string[];
  lastProducedResult?: EngineResult;
  conversionSucceeded: boolean;
  attemptSignal?: AbortSignal;
  savedFilePath?: string;
}): void {
  const keptPath = params.conversionSucceeded && !params.attemptSignal?.aborted ? params.savedFilePath : undefined;
  for (const p of params.intermediateFilePaths) {
    if (p === keptPath) continue;
    try {
      fs.rmSync(p, { force: true });
    } catch {}
  }
  if (params.lastProducedResult?.filePath && params.lastProducedResult.filePath !== keptPath) {
    discardConversionOutput(params.jobId, params.lastProducedResult);
  }
}

function throwIfAttemptAborted(
  jobId: string,
  signal: AbortSignal | undefined,
  produced?: EngineResult,
  intermediateFilePaths?: readonly string[]
): void {
  if (!signal?.aborted) return;
  if (intermediateFilePaths) {
    for (const p of intermediateFilePaths) {
      try {
        fs.rmSync(p, { force: true });
      } catch {}
    }
  }
  if (produced) {
    discardConversionOutput(jobId, produced);
  }
  signal.throwIfAborted();
}

async function logConversionDiagnostics(
  job: Job<ConversionJobData, ConversionJobResult>,
  engineName: string,
  finalResult: EngineResult,
  startTime: number,
  attemptSignal?: AbortSignal
): Promise<void> {
  const signal = attemptSignal ?? job.signal;
  const logIfAlive = async (line: string): Promise<boolean> => {
    if (signal?.aborted) return false;
    await job.log(line);
    return true;
  };
  if (
    !(await logIfAlive(
      `[${engineName}] Conversion completed via [${finalResult.engineUsed || engineName}] in ${finalResult.executionTimeMs || Date.now() - startTime}ms. Size: ${finalResult.size} bytes`
    ))
  ) {
    return;
  }
  if (finalResult.skippedLinks && finalResult.skippedLinks.length > 0) {
    if (
      !(await logIfAlive(
        `[${engineName}] Skipped ${finalResult.skippedLinks.length} link entries: ${finalResult.skippedLinks.join(', ')}`
      ))
    ) {
      return;
    }
  }
  const warnings = finalResult.metadata?.warnings;
  if (Array.isArray(warnings)) {
    for (const warning of warnings) {
      if (typeof warning === 'string' && !(await logIfAlive(`[${engineName}] Warning: ${warning}`))) return;
    }
  }
  if (finalResult.fallbackChain && finalResult.fallbackChain.length > 0) {
    for (const step of finalResult.fallbackChain) {
      if (!(await logIfAlive(`[${engineName}] Engine fallback: ${step}`))) return;
    }
  }
}

/**
 * Executes a queued archive inspection inside a Worker, scoping temporary storage reads
 * so staged objects are released deterministically on both success and failure.
 */
export async function processQueuedArchiveInspection(
  job: Job<ConversionJobData, ConversionJobResult>,
  rootStorage: IStorageBackend = storageProvider
): Promise<ConversionJobResult> {
  const payload = job.data.archiveInspect!;
  const cleanupKeys = payload.cleanupUploadKeys;
  const startedAt = Date.now();
  const scope = scopeStorageObjects(rootStorage);
  try {
    job.signal?.throwIfAborted();
    const stored = await scope.storage.getObject(payload.storageKey);
    if (!stored) {
      throw new Error(`Input storage object missing for key "${payload.storageKey}".`);
    }
    const archiveBuffer = stored.buffer;
    const archiveSize = archiveBuffer.length;
    const resolvedFilename = payload.filename ?? stored.filename;
    const opened = openPasswordOption(payload.options ?? {}, job.id);
    const inspection = await inspectArchive(archiveBuffer, {
      filename: resolvedFilename,
      password: opened.password,
      signal: job.signal,
    });
    job.signal?.throwIfAborted();
    await cleanupQueuedToolUploads(rootStorage, cleanupKeys);
    return {
      jobId: job.id,
      status: 'completed',
      resultKey: '',
      downloadUrl: '',
      filename: resolvedFilename ?? 'archive',
      mimeType: 'application/json',
      size: archiveSize,
      durationMs: Date.now() - startedAt,
      archiveInspection: inspection,
    };
  } catch (err: unknown) {
    if (Boolean(job.signal?.aborted || err instanceof JobCancelledError) || isFinalFailure(job, err)) {
      await cleanupQueuedToolUploads(rootStorage, cleanupKeys);
    }
    throw err;
  } finally {
    await scope.releaseAll();
  }
}

function dispatchSpecializedNodeJob(
  job: Job<ConversionJobData, ConversionJobResult>,
  baseEngine: ConversionEnginePort,
  rootStorage: IStorageBackend
): Promise<ConversionJobResult> | null {
  if (job.data?.graphId && job.data?.graphNodeId && job.data?.graphNode) {
    return processGraphNodeJobIfAlive(job, baseEngine, rootStorage);
  }
  if (job.data?.toolJob) {
    return processQueuedToolJob(job, rootStorage);
  }
  if (job.data?.archiveInspect) {
    return processQueuedArchiveInspection(job, rootStorage);
  }
  return null;
}

const PIPELINE_INPUT_LOADED_PROGRESS = 35;
const PIPELINE_STAGES_END_PROGRESS = 80;

function resolveStageTarget(
  task: NonNullable<ConversionJobData['tasks']>[number],
  fallbackTarget: string
): string {
  if (task.targetFormat) return task.targetFormat;
  if (task.operation === 'ocr') return 'pdf';
  if (task.operation === 'media.thumbnail') return task.options?.thumbnail?.format || 'jpg';
  if (task.operation === 'media.package') return task.options?.packaging?.format || 'hls';
  return fallbackTarget;
}

async function runPipelineTasks(params: {
  job: Job<ConversionJobData, ConversionJobResult>;
  engine: ConversionEnginePort;
  inputPayload: Buffer | VfsPayload;
  tasks: NonNullable<ConversionJobData['tasks']>;
  startTime: number;
  attemptSignal: AbortSignal | undefined;
  intermediateFilePaths: string[];
  onProduced: (result: EngineResult) => void;
}): Promise<EngineResult> {
  const { job, engine, inputPayload, tasks, startTime, attemptSignal, intermediateFilePaths, onProduced } = params;
  await job.log(`[${engine.name}] Executing ${tasks.length}-stage pipeline chaining...`);
  let currentPayload: Buffer | VfsPayload = inputPayload;
  let currentSourceFormat = job.data.sourceFormat;
  let currentFilename = job.data.originalFilename;
  let lastResult: EngineResult | undefined;

  for (let i = 0; i < tasks.length; i++) {
    attemptSignal?.throwIfAborted();
    const task = tasks[i];
    const taskProgress = Math.round(
      PIPELINE_INPUT_LOADED_PROGRESS +
        ((i + 1) / tasks.length) * (PIPELINE_STAGES_END_PROGRESS - PIPELINE_INPUT_LOADED_PROGRESS)
    );
    const stageTarget = resolveStageTarget(task, job.data.targetFormat);

    await job.log(
      `[${engine.name}] [Stage ${i + 1}/${tasks.length}] Task "${task.name}" (${task.operation}): ${currentSourceFormat} -> ${stageTarget}`
    );
    throwIfAttemptAborted(job.id, attemptSignal, lastResult, intermediateFilePaths);

    const mergedOptions: ConversionOptions & { signal?: AbortSignal; ocrEnabled?: boolean } = {
      ...openPasswordOption(job.data.options, job.id),
      ...openPasswordOption(task.options, job.id),
      signal: attemptSignal,
    };
    if (task.operation === 'ocr') {
      mergedOptions.ocrEnabled = true;
    } else if (task.operation === 'media.thumbnail') {
      mergedOptions.thumbnail = mergedOptions.thumbnail || { at: ['00:00:01.000'] };
    } else if (task.operation === 'media.package') {
      mergedOptions.packaging = mergedOptions.packaging || {
        format: stageTarget === 'dash' ? 'dash' : 'hls',
      };
    }

    const stageResult = await engine.convert(
      currentPayload,
      currentSourceFormat,
      stageTarget,
      mergedOptions,
      currentFilename
    );

    lastResult = stageResult;
    onProduced(stageResult);
    if (stageResult.filePath) {
      intermediateFilePaths.push(stageResult.filePath);
    }
    throwIfAttemptAborted(job.id, attemptSignal, stageResult, intermediateFilePaths);

    currentPayload = stageResult.filePath && fs.existsSync(stageResult.filePath)
      ? { inputPath: stageResult.filePath }
      : stageResult.buffer;
    currentSourceFormat = stageTarget;
    currentFilename = stageResult.filename;
    if (i === tasks.length - 1) {
      await logConversionDiagnostics(job, engine.name, stageResult, startTime, attemptSignal);
      throwIfAttemptAborted(job.id, attemptSignal, stageResult, intermediateFilePaths);
    }
    await job.updateProgress(taskProgress);
  }

  if (!lastResult) {
    throw new Error('Pipeline task chain execution did not produce an output result.');
  }

  for (const p of intermediateFilePaths.slice(0, -1)) {
    try {
      fs.rmSync(p, { force: true });
    } catch {}
  }
  return lastResult;
}

async function logOutputSavedAndFinishProgress(params: {
  job: Job<ConversionJobData, ConversionJobResult>;
  engineName: string;
  downloadUrl: string;
  undeliveredTtlMs: number;
  durationMs: number;
  attemptSignal: AbortSignal | undefined;
}): Promise<void> {
  const { job, engineName, downloadUrl, undeliveredTtlMs, durationMs, attemptSignal } = params;
  if (!attemptSignal?.aborted) {
    await job.log(
      `[${engineName}] Output saved for ${Math.round(undeliveredTtlMs / 1000)} s until downloaded. Download URL ready. Available at: ${downloadUrl} (took ${durationMs}ms)`
    );
  }
  if (!attemptSignal?.aborted) {
    await job.updateProgress(100);
  }
}

/**
 * Canonical unified node processor.
 * Routes graph node jobs, multi-stage task pipelines, and single conversions
 * identically through the provided conversion engine and storage backend.
 */
export async function processNodeJob(
  job: Job<ConversionJobData, ConversionJobResult>,
  baseEngine: ConversionEnginePort = dispatchEngine,
  rootStorage: IStorageBackend = storageProvider
): Promise<ConversionJobResult> {
  const specialized = dispatchSpecializedNodeJob(job, baseEngine, rootStorage);
  if (specialized) return specialized;
  // Every conversion of the job runs under the job's deadline.
  const engine = deadlineBoundEngine(baseEngine, job);

  // Scratch files a remote backend stages for this job's input are removed when the job ends.
  const scope = scopeStorageObjects(rootStorage);
  const storage = scope.storage;
  // Job data comes from the queue, not only from the routes: options that are not an object fail
  // the job with a typed error instead of being spread into {} or an index-keyed object.
  if (job.data.options !== undefined) assertConversionOptionsObject(job.data.options);

  const startTime = Date.now();
  const attemptSignal = job.signal;
  throwIfAttemptAborted(job.id, attemptSignal);
  await job.log(
    `[${engine.name}] Picked up conversion job for file: "${job.data.originalFilename}" (${job.data.sourceFormat} -> ${job.data.targetFormat})`
  );
  throwIfAttemptAborted(job.id, attemptSignal);
  await job.updateProgress(10);

  let inputPayload: Buffer | VfsPayload | undefined;
  let inputBufferForShredding: Buffer | null = null;
  let conversionSucceeded = false;
  let failure: unknown;
  let lastProducedResult: EngineResult | undefined;
  let savedFilePath: string | undefined;
  const intermediateFilePaths: string[] = [];

  try {
    throwIfAttemptAborted(job.id, attemptSignal);
    // 1. Fetch input from Storage backend or Base64 payload
    if (job.data.storageKey) {
      await takeInputHold(job.data.storageKey, job.id);
      const stored = await storage.getObject(job.data.storageKey);
      throwIfAttemptAborted(job.id, attemptSignal);
      if (!stored) {
        throw new Error(`Storage object not found for key: "${job.data.storageKey}"`);
      }
      const stat = typeof storage.stat === 'function' ? await storage.stat(job.data.storageKey) : undefined;
      const objectSize = stat?.size ?? stored.size;

      // Objects streamed from disk bypass the limit for engines that read the file path; an object
      // held in memory, or any object given to the in-process engine, is bound by it.
      const streamsFromDisk = Boolean(stored.filePath && fs.existsSync(stored.filePath));
      if ((engine.name === 'ts-engine' || !streamsFromDisk) && objectSize > getMaxInMemoryBytes()) {
        throw new PayloadTooLargeForMemoryError(
          `Payload size (${objectSize} bytes) exceeds in-memory buffer limit of ${getMaxInMemoryBytes()} bytes. Native worker required.`,
          { size: objectSize, limit: getMaxInMemoryBytes() }
        );
      }

      // Zero-heap optimization: if stored object has a disk filePath, pass it directly
      if (stored.filePath && fs.existsSync(stored.filePath)) {
        inputPayload = { inputPath: stored.filePath };
      } else {
        inputPayload = stored.buffer;
      }
    } else if (job.data.inputBufferBase64) {
      const approxBytes = Math.ceil((job.data.inputBufferBase64.length * 3) / 4);
      if (approxBytes > getMaxInMemoryBytes()) {
        throw new PayloadTooLargeForMemoryError(
          `Payload size (${approxBytes} bytes) exceeds in-memory buffer limit of ${getMaxInMemoryBytes()} bytes. Native worker required.`,
          { size: approxBytes, limit: getMaxInMemoryBytes() }
        );
      }
      const buf = Buffer.from(job.data.inputBufferBase64, 'base64');
      inputPayload = buf;
      inputBufferForShredding = buf;
    } else {
      throw new Error('Invalid job payload: neither storageKey nor inputBufferBase64 provided.');
    }

    throwIfAttemptAborted(job.id, attemptSignal);
    await job.log(`[${engine.name}] Loaded input context. Dispatching to conversion engine...`);
    throwIfAttemptAborted(job.id, attemptSignal);
    await job.updateProgress(PIPELINE_INPUT_LOADED_PROGRESS);

    // 2. Execute conversion (Pipeline tasks chaining or single-target conversion)
    const finalResult: EngineResult =
      job.data.tasks && job.data.tasks.length > 0
        ? await runPipelineTasks({
            job,
            engine,
            inputPayload,
            tasks: job.data.tasks,
            startTime,
            attemptSignal,
            intermediateFilePaths,
            onProduced: (result) => {
              lastProducedResult = result;
            },
          })
        : await (async () => {
            attemptSignal?.throwIfAborted();
            const conversionOptions: ConversionOptions & { signal?: AbortSignal } = {
              ...openPasswordOption(job.data.options, job.id),
              signal: attemptSignal,
            };
            const result = await engine.convert(
              inputPayload,
              job.data.sourceFormat,
              job.data.targetFormat,
              conversionOptions,
              job.data.originalFilename
            );
            lastProducedResult = result;
            throwIfAttemptAborted(job.id, attemptSignal, result);
            await logConversionDiagnostics(job, engine.name, result, startTime, attemptSignal);
            throwIfAttemptAborted(job.id, attemptSignal, result);
            await job.updateProgress(75);
            return result;
          })();

    // 3. Save the output with the undelivered time as its lifetime: it is deleted soon after its first complete download.
    throwIfAttemptAborted(job.id, attemptSignal, lastProducedResult, intermediateFilePaths);
    const resultKey = `results/${job.id}/${finalResult.filename}`;
    const { undeliveredTtlMs } = resolveRetentionPolicy();

    const written =
      finalResult.filePath && fs.existsSync(finalResult.filePath) && typeof storage.saveObjectFromFile === 'function'
        ? await storage.saveObjectFromFile(
            resultKey,
            finalResult.filePath,
            finalResult.mimeType,
            finalResult.filename,
            undeliveredTtlMs,
            attemptSignal
          )
        : await storage.saveObject(resultKey, finalResult.buffer, finalResult.mimeType, finalResult.filename, undeliveredTtlMs);
    savedFilePath = written.filePath;
    await discardResultOfAbortedAttempt(storage, resultKey, written, attemptSignal);

    await registerStoredResult(storage, resultKey);
    await discardResultOfAbortedAttempt(storage, resultKey, written, attemptSignal);

    conversionSucceeded = true;
    const durationMs = Date.now() - startTime;

    // Every download goes through the application, whatever the driver: a direct link to the bucket cannot tell
    // when the file was delivered, so the retention rule could not delete it after delivery.
    const downloadUrl = `/api/storage/file/${encodeURIComponent(resultKey)}`;

    await logOutputSavedAndFinishProgress({
      job,
      engineName: engine.name,
      downloadUrl,
      undeliveredTtlMs,
      durationMs,
      attemptSignal,
    });

    return {
      jobId: job.id,
      status: 'completed',
      resultKey,
      downloadUrl,
      filename: finalResult.filename,
      mimeType: finalResult.mimeType,
      size: finalResult.size,
      durationMs,
      ocrExtracted: Boolean(finalResult.ocrExtractedText),
      ...frameMetadataFields(finalResult),
      ...engineTraceFields(finalResult),
      ...droppedStreamsFields(finalResult),
      ...conversionWarningsFields(finalResult),
    };
  } catch (err) {
    failure = err;
    throw err;
  } finally {
    cleanupProcessorAttemptFiles({
      jobId: job.id,
      intermediateFilePaths,
      lastProducedResult,
      conversionSucceeded,
      attemptSignal,
      savedFilePath,
    });
    if (inputBufferForShredding) {
      secureShredBuffer(inputBufferForShredding, 2);
    }
    if (job.data.storageKey && !conversionSucceeded && isFinalFailure(job, failure)) {
      await releaseResultHold(job.data.storageKey, job.id);
    }
    await scope.releaseAll();
  }
}
