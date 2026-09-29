import { Queue, Worker, Job, createQueueEngine, IQueueEngine, WorkerOptions } from './bullmq-engine';
import { ConversionJobData, ConversionJobResult, ConversionResult } from '../types';
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
  // Capture this attempt's signal before the first await: a retry gets a fresh one, and a stale
  // attempt that outlived its timeout must still see its own aborted signal.
  const attemptSignal = job.signal;
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

    // 2. Execute conversion engine or multi-task pipeline chaining
    let conversionResult: ConversionResult;
    if (job.data.tasks && job.data.tasks.length > 0) {
      await job.log(`Executing ${job.data.tasks.length}-stage pipeline chaining...`);
      let currentBuffer = inputBuffer;
      let currentSourceFormat = job.data.sourceFormat;
      let currentFilename = job.data.originalFilename;
      let lastResult: ConversionResult | undefined;

      for (let i = 0; i < job.data.tasks.length; i++) {
        attemptSignal.throwIfAborted();
        const task = job.data.tasks[i];
        const taskProgress = Math.round(20 + ((i + 1) / job.data.tasks.length) * 60);
        const stageTarget = task.targetFormat || (task.operation === 'ocr' ? 'pdf' : job.data.targetFormat);
        await job.log(
          `[Stage ${i + 1}/${job.data.tasks.length}] Task "${task.name}" (${task.operation}): ${currentSourceFormat} -> ${stageTarget}`
        );

        const mergedOptions = { ...job.data.options, ...(task.options || {}) };
        if (task.operation === 'ocr') {
          mergedOptions.ocrEnabled = true;
        }

        lastResult = await convertFile(
          currentBuffer,
          currentSourceFormat,
          stageTarget,
          mergedOptions,
          currentFilename
        );

        currentBuffer = lastResult.buffer;
        currentSourceFormat = stageTarget;
        currentFilename = lastResult.filename;
        await job.updateProgress(taskProgress);
      }

      if (!lastResult) {
        throw new Error('Pipeline task chain execution did not produce an output result.');
      }
      conversionResult = lastResult;
    } else {
      attemptSignal.throwIfAborted();
      conversionResult = await convertFile(
        inputBuffer,
        job.data.sourceFormat,
        job.data.targetFormat,
        job.data.options,
        job.data.originalFilename
      );
    }

    await job.updateProgress(80);
    await job.log(`Conversion completed (${conversionResult.size} bytes). Uploading result to S3 storage...`);

    // 3. Save output artifact to storage with 1-hour TTL (never for a cancelled or timed-out attempt)
    attemptSignal.throwIfAborted();
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
    // Delete the uploaded input once retry attempts are exhausted. After a success the input is kept
    // until the completion is recorded (attachInputCleanupOnCompletion): if recording fails, the
    // stalled sweep runs the job again and it needs the input to convert again.
    const isFinalAttempt = !job.opts?.attempts || job.attemptsMade >= job.opts.attempts;
    if (job.data.storageKey && !conversionSucceeded && isFinalAttempt) {
      removeJobInput(job.id, job.data.storageKey);
    }
  }
}

/** Deletes a job's uploaded input, reporting a missing object or a failed delete. */
function removeJobInput(jobId: string, storageKey: string): void {
  try {
    if (!s3Storage.deleteObject(storageKey)) {
      console.warn(`[ConversionQueue] Input cleanup for job ${jobId} found no object at key "${storageKey}".`);
    }
  } catch (err) {
    console.warn(`[ConversionQueue] Input cleanup for job ${jobId} failed to delete key "${storageKey}":`, err);
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
            job.data.webhookSecret || 'easyconvert-default-secret',
            { ownerUserId: job.data.userId }
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
            job.data.webhookSecret || 'easyconvert-default-secret',
            { ownerUserId: job.data.userId }
          );
        } catch (dispatchErr) {
          console.error(`[ConversionQueue] Failed to dispatch failed webhook for job ${job.id}:`, dispatchErr);
        }
      }
    }
  );
}

/**
 * Deletes a job's uploaded input once the worker has recorded its completion. Attach it to every
 * worker that runs processConversionJob.
 */
export function attachInputCleanupOnCompletion(
  worker: Worker<ConversionJobData, ConversionJobResult>
): void {
  worker.on('completed', (job: Job<ConversionJobData, ConversionJobResult>) => {
    if (job.data?.storageKey) {
      removeJobInput(job.id, job.data.storageKey);
    }
  });
}

/**
 * Owns the quota refund for cancelled jobs. The engine emits `cancelled` once per cancelled job, in
 * the process whose cancelJob won the transition, so every cancel path refunds exactly once.
 */
export function attachJobCancellationListeners(
  queue: IQueueEngine<ConversionJobData, ConversionJobResult>
): void {
  queue.on('cancelled', async (job: Job<ConversionJobData, ConversionJobResult>) => {
    if (!job.data?.reservationId) {
      return;
    }
    try {
      await redisKeyStore.rollbackQuota(job.data.reservationId);
    } catch (err) {
      console.error(
        `[ConversionQueue] Failed to rollback quota for cancelled job ${job.id} (reservation ${job.data.reservationId}):`,
        err
      );
    }
  });
}

attachJobCancellationListeners(conversionQueue);

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
  attachInputCleanupOnCompletion(worker);
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

