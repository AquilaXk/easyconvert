import { Queue, Worker, Job, createQueueEngine, IQueueEngine, WorkerOptions } from './bullmq-engine';
import { ConversionJobData, ConversionJobResult } from '../types';
import { convertFile } from '../conversions';
import { s3Storage } from '../storage/s3-storage';
import { redisKeyStore } from '../api-keys/redis-key-store';
import { webhookDispatcher } from '../api-keys/webhook-dispatcher';

// 1. Initialize Conversion Queue (Pluggable In-Memory or Distributed Redis/BullMQ Engine)
export const conversionQueue: IQueueEngine<ConversionJobData, ConversionJobResult> =
  createQueueEngine<ConversionJobData, ConversionJobResult>('easyconvert-jobs');


/**
 * Standard Conversion Job Processor for in-process fallback / development workers.
 */
export async function processConversionJob(
  job: Job<ConversionJobData, ConversionJobResult>
): Promise<ConversionJobResult> {
  const startTime = Date.now();
  await job.log(`Worker picked up conversion job for file: ${job.data.originalFilename}`);
  await job.updateProgress(10);

  // 1. Obtain input buffer from Storage Key or Base64 payload
  let inputBuffer: Buffer | undefined;
  let shouldShredInput = false;

  let conversionSucceeded = false;
  try {
    if (job.data.storageKey) {
      const stored = s3Storage.getObject(job.data.storageKey);
      if (!stored) {
        throw new Error(`S3 object not found for key: "${job.data.storageKey}"`);
      }
      inputBuffer = stored.buffer;
    } else if (job.data.inputBufferBase64) {
      inputBuffer = Buffer.from(job.data.inputBufferBase64, 'base64');
      shouldShredInput = true;
    } else {
      throw new Error('Missing input file data. Neither storageKey nor inputBufferBase64 was provided.');
    }

    await job.log(
      `Input payload loaded (${inputBuffer.length} bytes). Transcoding ${job.data.sourceFormat} -> ${job.data.targetFormat}...`
    );
    await job.updateProgress(35);

    // 2. Execute conversion engine
    const conversionResult = await convertFile(
      inputBuffer,
      job.data.sourceFormat,
      job.data.targetFormat,
      job.data.options,
      job.data.originalFilename
    );

    await job.updateProgress(80);
    await job.log(`Conversion completed (${conversionResult.size} bytes). Uploading result to S3 storage...`);

    // 3. Save output artifact to storage with 1-hour TTL
    const resultKey = `results/${job.id}/${conversionResult.filename}`;
    s3Storage.saveObject(
      resultKey,
      conversionResult.buffer,
      conversionResult.mimeType,
      conversionResult.filename,
      60 * 60 * 1000
    );

    conversionSucceeded = true;
    const durationMs = Date.now() - startTime;
    await job.updateProgress(100);
    await job.log(
      `Result persisted. Available at: /api/storage/file/${encodeURIComponent(resultKey)} (took ${durationMs}ms)`
    );

    return {
      jobId: job.id,
      status: 'completed',
      resultKey,
      downloadUrl: `/api/storage/file/${encodeURIComponent(resultKey)}`,
      filename: conversionResult.filename,
      mimeType: conversionResult.mimeType,
      size: conversionResult.size,
      durationMs,
      ocrExtracted: Boolean(conversionResult.ocrExtractedText),
    };
  } finally {
    // Cryptographically shred ephemeral memory buffer
    if (shouldShredInput && inputBuffer) {
      try {
        inputBuffer.fill(0);
      } catch {
        // Ignore if detached
      }
    }
    // Clean up temporary input object from storage backend upon job success or when retry attempts are exhausted
    const isFinalAttempt = !job.opts?.attempts || job.attemptsMade >= job.opts.attempts;
    if (job.data.storageKey && (conversionSucceeded || isFinalAttempt)) {
      try {
        s3Storage.deleteObject(job.data.storageKey);
      } catch {
        // Ignore
      }
    }
  }
}

/**
 * Attaches unified job lifecycle event listeners for 2-phase quota accounting and webhook dispatching.
 * Shared across both in-process and dedicated OCI backend daemon workers.
 */
export function attachJobLifecycleListeners(
  worker: Worker<ConversionJobData, ConversionJobResult>
): void {
  worker.on(
    'completed',
    async (job: Job<ConversionJobData, ConversionJobResult>, result: ConversionJobResult) => {
      // 2-Phase Quota: Commit quota upon successful conversion
      if (job.data?.reservationId) {
        try {
          await redisKeyStore.commitQuota(job.data.reservationId);
        } catch (err) {
          console.error(
            `[ConversionQueue] Failed to commit quota for reservation ${job.data.reservationId}:`,
            err
          );
        }
      }

      // Asynchronous Webhook Notification
      if (job.data?.webhookUrl) {
        try {
          await webhookDispatcher.dispatch(
            job.data.webhookUrl,
            'job.completed',
            result,
            job.data.webhookSecret || 'easyconvert-default-secret'
          );
        } catch (err) {
          console.error(`[ConversionQueue] Failed to dispatch completed webhook for job ${job.id}:`, err);
        }
      }
    }
  );

  worker.on(
    'failed',
    async (job: Job<ConversionJobData, ConversionJobResult>, err: any) => {
      // 2-Phase Quota: Rollback quota reservation upon unrecoverable job failure
      if (job.data?.reservationId) {
        try {
          await redisKeyStore.rollbackQuota(job.data.reservationId);
        } catch (rollbackErr) {
          console.error(
            `[ConversionQueue] Failed to rollback quota for reservation ${job.data.reservationId}:`,
            rollbackErr
          );
        }
      }

      // Asynchronous Webhook Failure Notification
      if (job.data?.webhookUrl) {
        try {
          await webhookDispatcher.dispatch(
            job.data.webhookUrl,
            'job.failed',
            {
              jobId: job.id,
              error: err instanceof Error ? err.message : String(err),
              originalFilename: job.data.originalFilename,
            },
            job.data.webhookSecret || 'easyconvert-default-secret'
          );
        } catch (dispatchErr) {
          console.error(`[ConversionQueue] Failed to dispatch failed webhook for job ${job.id}:`, dispatchErr);
        }
      }
    }
  );
}

// 2. Worker Lifecycle Management (Producer/Consumer Decoupled)
let workerInstance: Worker<ConversionJobData, ConversionJobResult> | null = null;

export function startConversionWorker(
  opts: WorkerOptions = {}
): Worker<ConversionJobData, ConversionJobResult> {
  if (workerInstance) {
    return workerInstance;
  }
  const worker = new Worker<ConversionJobData, ConversionJobResult>(
    conversionQueue,
    processConversionJob,
    { concurrency: opts.concurrency || 5 }
  );
  attachJobLifecycleListeners(worker);
  workerInstance = worker;
  return worker;
}

export async function stopConversionWorker(): Promise<void> {
  if (workerInstance) {
    await workerInstance.close();
    workerInstance = null;
  }
}

export function getConversionWorker(): Worker<ConversionJobData, ConversionJobResult> {
  if (!workerInstance) {
    workerInstance = startConversionWorker();
  }
  return workerInstance;
}

// Auto-start worker ONLY when explicitly enabled via environment variable
if (process.env.EASYCONVERT_WORKER_ENABLED === 'true') {
  startConversionWorker();
}

/**
 * Lazy proxy export for backward compatibility with direct conversionWorker imports.
 * Does NOT spawn the background worker loop unless explicitly accessed or enabled.
 */
export const conversionWorker = new Proxy({} as Worker<ConversionJobData, ConversionJobResult>, {
  get(_target, prop) {
    const inst = getConversionWorker();
    const val = (inst as any)[prop];
    return typeof val === 'function' ? val.bind(inst) : val;
  },
});

