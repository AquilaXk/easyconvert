import fs from 'node:fs';
import path from 'node:path';
import type { Job } from './bullmq-engine';
import { isFinalFailure } from './job-failure';
import type {
  ConversionJobData,
  ConversionJobResult,
  ConversionOptions,
  ConversionResult,
} from '../types';
import type { IStorageBackend } from '../storage/oci-storage';
import { s3Storage } from '../storage/s3-storage';
import { convertFile } from '../conversions';
import { PayloadTooLargeForMemoryError, getMaxInMemoryBytes } from '../storage/errors';
import { secureShredBuffer } from '../security/memory-shredder';
import { isUploadKey } from '../storage/key-namespace';
import { processGraphNodeJob } from './graph/node-executor';
import type { ConversionEnginePort, EngineResult, VfsPayload } from './engine-port';
import { dispatchEngine } from './dispatch-engine';
import { assertConversionOptionsObject } from '../conversions/options-guard';

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

/** Deletes a job's uploaded input upon final attempt failure. */
function removeJobInput(jobId: string, storageKey: string, storage: IStorageBackend): void {
  if (!isUploadKey(storageKey)) {
    return;
  }
  try {
    if (!storage.deleteObject(storageKey)) {
      console.warn(`[NodeProcessor] Input cleanup for job ${jobId} found no object at key "${storageKey}".`);
    }
  } catch (err) {
    console.warn(`[NodeProcessor] Input cleanup for job ${jobId} failed to delete key "${storageKey}":`, err);
  }
}

/**
 * Canonical unified node processor.
 * Routes graph node jobs, multi-stage task pipelines, and single conversions
 * identically through the provided conversion engine and storage backend.
 */
export async function processNodeJob(
  job: Job<ConversionJobData, ConversionJobResult>,
  engine: ConversionEnginePort = dispatchEngine,
  storage: IStorageBackend = s3Storage
): Promise<ConversionJobResult> {
  // If this job is part of an orchestrated DAG JobGraph, route directly to the graph node executor
  if (job.data?.graphId && job.data?.graphNodeId && job.data?.graphNode) {
    return processGraphNodeJob(job, engine, storage);
  }

  // Job data comes from the queue, not only from the routes: options that are not an object fail
  // the job with a typed error instead of being spread into {} or an index-keyed object.
  if (job.data.options !== undefined) assertConversionOptionsObject(job.data.options);

  const startTime = Date.now();
  const attemptSignal = job.signal;
  await job.log(
    `[${engine.name}] Picked up conversion job for file: "${job.data.originalFilename}" (${job.data.sourceFormat} -> ${job.data.targetFormat})`
  );
  await job.updateProgress(10);

  let inputPayload: Buffer | VfsPayload | undefined;
  let inputBufferForShredding: Buffer | null = null;
  let conversionSucceeded = false;
  let failure: unknown;
  let lastProducedResult: EngineResult | undefined;
  const intermediateFilePaths: string[] = [];

  try {
    // 1. Fetch input from Storage backend or Base64 payload
    if (job.data.storageKey) {
      const stored = storage.getObject(job.data.storageKey);
      if (!stored) {
        throw new Error(`Storage object not found for key: "${job.data.storageKey}"`);
      }
      const stat = typeof storage.stat === 'function' ? storage.stat(job.data.storageKey) : undefined;
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

    await job.log(`[${engine.name}] Loaded input context. Dispatching to conversion engine...`);
    await job.updateProgress(30);
    await job.updateProgress(35);

    // 2. Execute conversion (Pipeline tasks chaining or single-target conversion)
    let finalResult: EngineResult;

    if (job.data.tasks && job.data.tasks.length > 0) {
      await job.log(`[${engine.name}] Executing ${job.data.tasks.length}-stage pipeline chaining...`);
      let currentPayload: Buffer | VfsPayload = inputPayload;
      let currentSourceFormat = job.data.sourceFormat;
      let currentFilename = job.data.originalFilename;

      for (let i = 0; i < job.data.tasks.length; i++) {
        attemptSignal.throwIfAborted();
        const task = job.data.tasks[i];
        const taskProgress = Math.round(20 + ((i + 1) / job.data.tasks.length) * 60);
        const stageTarget = task.targetFormat || (
          task.operation === 'ocr'
            ? 'pdf'
            : task.operation === 'media.thumbnail'
            ? (task.options?.thumbnail?.format || 'jpg')
            : task.operation === 'media.package'
            ? (task.options?.packaging?.format || 'hls')
            : job.data.targetFormat
        );

        await job.log(
          `[${engine.name}] [Stage ${i + 1}/${job.data.tasks.length}] Task "${task.name}" (${task.operation}): ${currentSourceFormat} -> ${stageTarget}`
        );

        const mergedOptions: ConversionOptions & { signal?: AbortSignal; ocrEnabled?: boolean } = {
          ...job.data.options,
          ...(task.options || {}),
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

        lastProducedResult = stageResult;
        if (stageResult.filePath) {
          intermediateFilePaths.push(stageResult.filePath);
        }

        currentPayload = stageResult.filePath && fs.existsSync(stageResult.filePath)
          ? { inputPath: stageResult.filePath }
          : stageResult.buffer;
        currentSourceFormat = stageTarget;
        currentFilename = stageResult.filename;
        await job.updateProgress(taskProgress);
      }

      if (!lastProducedResult) {
        throw new Error('Pipeline task chain execution did not produce an output result.');
      }
      finalResult = lastProducedResult;

      // Clean up intermediate disk files from previous stages
      for (const p of intermediateFilePaths.slice(0, -1)) {
        try {
          fs.rmSync(p, { force: true });
        } catch {}
      }
    } else {
      attemptSignal.throwIfAborted();
      const conversionOptions: ConversionOptions & { signal?: AbortSignal } = {
        ...job.data.options,
        signal: attemptSignal,
      };
      finalResult = await engine.convert(
        inputPayload,
        job.data.sourceFormat,
        job.data.targetFormat,
        conversionOptions,
        job.data.originalFilename
      );
      lastProducedResult = finalResult;
    }

    await job.updateProgress(75);
    await job.log(
      `[${engine.name}] Conversion completed via [${finalResult.engineUsed || engine.name}] in ${finalResult.executionTimeMs || Date.now() - startTime}ms. Size: ${finalResult.size} bytes`
    );
    if (finalResult.fallbackChain && finalResult.fallbackChain.length > 0) {
      for (const step of finalResult.fallbackChain) {
        await job.log(`[${engine.name}] Engine fallback: ${step}`);
      }
    }

    // 3. Save output artifact to storage with 1-hour TTL
    if (attemptSignal.aborted) {
      if (lastProducedResult) {
        discardConversionOutput(job.id, lastProducedResult);
      }
      attemptSignal.throwIfAborted();
    }
    const resultKey = `results/${job.id}/${finalResult.filename}`;
    const oneHourTtlMs = 60 * 60 * 1000;

    if (
      finalResult.filePath &&
      fs.existsSync(finalResult.filePath) &&
      typeof storage.saveObjectFromFile === 'function'
    ) {
      storage.saveObjectFromFile(
        resultKey,
        finalResult.filePath,
        finalResult.mimeType,
        finalResult.filename,
        oneHourTtlMs
      );
    } else {
      storage.saveObject(
        resultKey,
        finalResult.buffer,
        finalResult.mimeType,
        finalResult.filename,
        oneHourTtlMs
      );
    }

    conversionSucceeded = true;
    const durationMs = Date.now() - startTime;
    await job.updateProgress(100);

    let downloadUrl = `/api/storage/file/${encodeURIComponent(resultKey)}`;
    if (typeof storage.generatePresignedDownloadUrl === 'function') {
      const presigned = storage.generatePresignedDownloadUrl(resultKey, 3600);
      downloadUrl = presigned.url;
    }

    await job.log(
      `[${engine.name}] Output saved with 1-hour TTL. Download URL ready. Available at: ${downloadUrl} (took ${durationMs}ms)`
    );

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
    };
  } catch (err) {
    failure = err;
    throw err;
  } finally {
    if (attemptSignal.aborted) {
      for (const p of intermediateFilePaths) {
        try {
          fs.rmSync(p, { force: true });
        } catch {}
      }
      if (lastProducedResult) {
        discardConversionOutput(job.id, lastProducedResult);
      }
    }
    if (inputBufferForShredding) {
      secureShredBuffer(inputBufferForShredding, 2);
    }
    if (job.data.storageKey && !conversionSucceeded && isFinalFailure(job, failure)) {
      removeJobInput(job.id, job.data.storageKey, storage);
    }
  }
}
