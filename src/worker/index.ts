import fs from 'node:fs';
import {
  conversionQueue,
  attachJobLifecycleListeners,
  attachInputCleanupOnCompletion,
} from '../lib/queue/conversion-queue';
import { Worker, Job } from '../lib/queue/bullmq-engine';
import { ConversionJobData, ConversionJobResult } from '../lib/types';
import { storageProvider as ociStorage } from '../lib/storage';
import {
  executeWorkerConversion,
  WorkerConversionResult,
  WorkerVfsPayload,
  WorkerEngineOptions,
} from './engines';
import { secureShredBuffer } from '../lib/security/memory-shredder';

const CONCURRENCY = Number.parseInt(process.env.WORKER_CONCURRENCY || '3', 10);

console.log(`[EasyConvert OCI Worker] Initializing daemon (Concurrency: ${CONCURRENCY})...`);

/** Removes the output file an aborted attempt produced, so nothing of that attempt is persisted. */
function discardConversionOutput(jobId: string, result: WorkerConversionResult): void {
  if (!result.filePath) {
    return;
  }
  try {
    fs.rmSync(result.filePath, { force: true });
  } catch (err) {
    console.warn(`[EasyConvert OCI Worker] Failed to discard output of aborted job ${jobId} at "${result.filePath}":`, err);
  }
}

export const ociWorker = new Worker<ConversionJobData, ConversionJobResult>(
  conversionQueue,
  async (job: Job<ConversionJobData, ConversionJobResult>): Promise<ConversionJobResult> => {
    const startTime = Date.now();
    // Capture this attempt's signal before the first await: a retry gets a fresh one, and a stale
    // attempt that outlived its timeout must still see its own aborted signal.
    const attemptSignal = job.signal;
    await job.log(`[OCI Worker] Picked up job ${job.id} for "${job.data.originalFilename}" (${job.data.sourceFormat} -> ${job.data.targetFormat})`);
    await job.updateProgress(10);

    // Reject multi-stage pipeline tasks until Phase 3 DAG orchestration lands
    if (job.data.tasks && job.data.tasks.length > 1) {
      throw new Error(
        `Multi-stage pipeline tasks (length ${job.data.tasks.length}) are not supported in worker until DAG orchestration (Phase 3); rejected to prevent silent chain omission`
      );
    }

    let inputPayload: Buffer | WorkerVfsPayload | undefined;
    let shouldShred = false;

    try {
      // 1. Fetch input from OCI Object Storage or direct Base64
      if (job.data.storageKey) {
        const stored = ociStorage.getObject(job.data.storageKey);
        if (!stored) {
          throw new Error(`OCI Object not found for key: "${job.data.storageKey}"`);
        }
        // Zero-Heap optimization: If stored object has a disk filePath, pass it directly without buffering into memory!
        if (stored.filePath && fs.existsSync(stored.filePath)) {
          inputPayload = { inputPath: stored.filePath };
        } else {
          inputPayload = stored.buffer;
        }
      } else if (job.data.inputBufferBase64) {
        inputPayload = Buffer.from(job.data.inputBufferBase64, 'base64');
        shouldShred = true;
      } else {
        throw new Error('Invalid job payload: neither storageKey nor inputBufferBase64 provided.');
      }

      await job.log(`[OCI Worker] Loaded input context. Dispatching to conversion engine...`);
      await job.updateProgress(30);

      // 2. Execute conversion (Native LibreOffice / FFmpeg or pure TS fallback)
      attemptSignal.throwIfAborted();
      const singleTask = job.data.tasks && job.data.tasks.length === 1 ? job.data.tasks[0] : undefined;
      const effectiveTargetFormat = singleTask?.targetFormat || job.data.targetFormat;
      const conversionOptions: WorkerEngineOptions = {
        ...job.data.options,
        ...(singleTask?.options || {}),
        signal: attemptSignal,
      };
      if (singleTask?.operation === 'ocr') {
        conversionOptions.ocrEnabled = true;
      }
      const result: WorkerConversionResult = await executeWorkerConversion(
        inputPayload,
        job.data.sourceFormat,
        effectiveTargetFormat,
        conversionOptions,
        job.data.originalFilename
      );

      await job.updateProgress(75);
      await job.log(`[OCI Worker] Conversion completed via [${result.engineUsed}] in ${result.executionTimeMs}ms. Size: ${result.size} bytes`);
      if (result.fallbackChain && result.fallbackChain.length > 0) {
        for (const step of result.fallbackChain) {
          await job.log(`[OCI Worker] Engine fallback: ${step}`);
        }
      }

      // 3. Store result in OCI Object Storage with 1-hour TTL (Zero-Heap from file if available),
      //    never for a cancelled or timed-out attempt
      if (attemptSignal.aborted) {
        discardConversionOutput(job.id, result);
        attemptSignal.throwIfAborted();
      }
      const resultKey = `results/${job.id}/${result.filename}`;
      const oneHourTtlMs = 60 * 60 * 1000;
      if (result.filePath && fs.existsSync(result.filePath) && typeof ociStorage.saveObjectFromFile === 'function') {
        ociStorage.saveObjectFromFile(resultKey, result.filePath, result.mimeType, result.filename, oneHourTtlMs);
      } else {
        ociStorage.saveObject(resultKey, result.buffer, result.mimeType, result.filename, oneHourTtlMs);
      }

      // 4. Generate Presigned Download URL
      let downloadUrl = `/api/storage/file/${resultKey}`;
      if (typeof ociStorage.generatePresignedDownloadUrl === 'function') {
        const presigned = ociStorage.generatePresignedDownloadUrl(resultKey, 3600);
        downloadUrl = presigned.url;
      }

      await job.updateProgress(100);
      await job.log(`[OCI Worker] Output saved with 1-hour TTL. Download URL ready.`);

      return {
        jobId: job.id,
        status: 'completed',
        resultKey,
        downloadUrl,
        filename: result.filename,
        mimeType: result.mimeType,
        size: result.size,
        durationMs: Date.now() - startTime,
      };
    } finally {
      if (shouldShred && inputPayload && Buffer.isBuffer(inputPayload)) {
        secureShredBuffer(inputPayload, 2);
      }
    }
  },
  { concurrency: CONCURRENCY }
);

// Attach 2-phase quota accounting, webhook dispatch listeners, and input cleanup
attachJobLifecycleListeners(ociWorker);
attachInputCleanupOnCompletion(ociWorker);

// Graceful shutdown
function shutdown(signal: string) {
  console.log(`[EasyConvert OCI Worker] Received ${signal}. Shutting down cleanly...`);
  void ociWorker
    .close()
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error(`[EasyConvert OCI Worker] Shutdown error:`, err);
      process.exit(1);
    });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log(`[EasyConvert OCI Worker] Worker daemon online and listening for jobs.`);
