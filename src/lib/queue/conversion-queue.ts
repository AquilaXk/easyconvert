import { Queue, Worker, Job, createQueueEngine, IQueueEngine, WorkerOptions } from './bullmq-engine';
import type { ConversionJobData, ConversionJobResult } from '../types';
import { s3Storage } from '../storage/s3-storage';
import { isUploadKey } from '../storage/key-namespace';
import { redisKeyStore } from '../api-keys/redis-key-store';
import { webhookDispatcher } from '../api-keys/webhook-dispatcher';
import { processNodeJob, tsEngine } from './node-processor';

// 1. Initialize Conversion Queue (Pluggable In-Memory or Distributed Redis/BullMQ Engine)
export const conversionQueue: IQueueEngine<ConversionJobData, ConversionJobResult> =
  createQueueEngine<ConversionJobData, ConversionJobResult>('easyconvert-jobs');

/**
 * Standard Conversion Job Processor for in-process fallback / development workers.
 * Delegates to canonical shared node processor with the TypeScript engine.
 */
export async function processConversionJob(
  job: Job<ConversionJobData, ConversionJobResult>
): Promise<ConversionJobResult> {
  return processNodeJob(job, tsEngine, s3Storage);
}

/**
 * Deletes a job's uploaded input, reporting a missing object or a failed delete. Only an upload
 * belongs to the job: a user's `conversions/` or `results/` output chained as the input is kept.
 */
function removeJobInput(jobId: string, storageKey: string): void {
  if (!isUploadKey(storageKey)) {
    return;
  }
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
        if (!job.data.webhookSecret) {
          console.warn(
            `[ConversionQueue] Skipping webhook dispatch for job ${job.id}: missing webhookSecret`
          );
          const deliveryId = `wh_missing_secret_${job.id}_${Date.now()}`;
          await webhookDispatcher
            .saveToDlq({
              id: `dlq_${deliveryId}`,
              originalDeliveryId: deliveryId,
              targetUrl: job.data.webhookUrl,
              event: 'job.completed',
              payload: result as unknown as Record<string, unknown>,
              secret: '',
              failedAt: Date.now(),
              errorMessage: 'missing_webhook_secret',
              retryCount: 0,
              status: 'failed',
              ownerUserId: job.data.userId,
            })
            .catch(() => {});
        } else {
          try {
            await webhookDispatcher.dispatch(
              job.data.webhookUrl,
              'job.completed',
              result,
              job.data.webhookSecret,
              { ownerUserId: job.data.userId }
            );
          } catch (err) {
            console.error(`[ConversionQueue] Failed to dispatch completed webhook for job ${job.id}:`, err);
          }
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
        if (!job.data.webhookSecret) {
          console.warn(
            `[ConversionQueue] Skipping webhook dispatch for job ${job.id}: missing webhookSecret`
          );
          const deliveryId = `wh_missing_secret_${job.id}_${Date.now()}`;
          await webhookDispatcher
            .saveToDlq({
              id: `dlq_${deliveryId}`,
              originalDeliveryId: deliveryId,
              targetUrl: job.data.webhookUrl,
              event: 'job.failed',
              payload: {
                jobId: job.id,
                error: err instanceof Error ? err.message : String(err),
                originalFilename: job.data.originalFilename,
              },
              secret: '',
              failedAt: Date.now(),
              errorMessage: 'missing_webhook_secret',
              retryCount: 0,
              status: 'failed',
              ownerUserId: job.data.userId,
            })
            .catch(() => {});
        } else {
          try {
            await webhookDispatcher.dispatch(
              job.data.webhookUrl,
              'job.failed',
              {
                jobId: job.id,
                error: err instanceof Error ? err.message : String(err),
                originalFilename: job.data.originalFilename,
              },
              job.data.webhookSecret,
              { ownerUserId: job.data.userId }
            );
          } catch (dispatchErr) {
            console.error(`[ConversionQueue] Failed to dispatch failed webhook for job ${job.id}:`, dispatchErr);
          }
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
  worker.on('failed', (job: Job<ConversionJobData, ConversionJobResult>) => {
    const isFinalAttempt = !job.opts?.attempts || job.attemptsMade >= job.opts.attempts;
    if (job.data?.storageKey && isFinalAttempt) {
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

