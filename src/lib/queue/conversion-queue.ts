import { Queue, Worker, Job, createQueueEngine, IQueueEngine, WorkerOptions } from './bullmq-engine';
import type { ConversionJobData, ConversionJobResult, ResourceClass } from '../types';
import { s3Storage } from '../storage/s3-storage';
import { isUploadKey } from '../storage/key-namespace';
import { redisKeyStore } from '../api-keys/redis-key-store';
import { MISSING_WEBHOOK_SECRET_REASON, webhookDispatcher } from '../api-keys/webhook-dispatcher';
import { processNodeJob } from './node-processor';
import { dispatchEngine } from './dispatch-engine';
import { resolveResourceClass } from './resource-class';

// 1. Initialize Conversion Queue (Pluggable In-Memory or Distributed Redis/BullMQ Engine)
export const conversionQueue: IQueueEngine<ConversionJobData, ConversionJobResult> =
  createQueueEngine<ConversionJobData, ConversionJobResult>('easyconvert-jobs');

export const resourceQueues: Record<ResourceClass, IQueueEngine<ConversionJobData, ConversionJobResult>> = {
  light: createQueueEngine<ConversionJobData, ConversionJobResult>('easyconvert-jobs:light'),
  cpu: createQueueEngine<ConversionJobData, ConversionJobResult>('easyconvert-jobs:cpu'),
  memory: createQueueEngine<ConversionJobData, ConversionJobResult>('easyconvert-jobs:memory'),
  gpu: createQueueEngine<ConversionJobData, ConversionJobResult>('easyconvert-jobs:gpu'),
};

export const allConversionQueues: readonly IQueueEngine<ConversionJobData, ConversionJobResult>[] = [
  conversionQueue,
  resourceQueues.light,
  resourceQueues.cpu,
  resourceQueues.memory,
  resourceQueues.gpu,
];

/**
 * Standard Conversion Job Processor for in-process fallback / development workers.
 * Delegates to canonical shared node processor with the shared conversion dispatcher.
 */
export async function processConversionJob(
  job: Job<ConversionJobData, ConversionJobResult>
): Promise<ConversionJobResult> {
  return processNodeJob(job, dispatchEngine, s3Storage);
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
              errorMessage: MISSING_WEBHOOK_SECRET_REASON,
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
              errorMessage: MISSING_WEBHOOK_SECRET_REASON,
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
for (const q of Object.values(resourceQueues)) {
  attachJobCancellationListeners(q);
}

/**
 * Returns queue engine designated for the given resource class.
 */
export function getQueueForResourceClass(
  resourceClass: ResourceClass
): IQueueEngine<ConversionJobData, ConversionJobResult> {
  return resourceQueues[resourceClass] || conversionQueue;
}

/**
 * Resolves the appropriate resource queue for a conversion job based on formats, size, and options.
 */
export function getQueueForJob(
  jobData: Partial<ConversionJobData>
): IQueueEngine<ConversionJobData, ConversionJobResult> {
  if (jobData.resourceClass && resourceQueues[jobData.resourceClass]) {
    return resourceQueues[jobData.resourceClass];
  }
  const resClass = resolveResourceClass(
    jobData.sourceFormat || '',
    jobData.targetFormat || '',
    jobData.fileSize,
    jobData.options
  );
  return resourceQueues[resClass] || conversionQueue;
}

/**
 * Retrieves a job by ID across all resource queues and default queue.
 */
export async function getJobAcrossQueues(
  jobId: string
): Promise<Job<ConversionJobData, ConversionJobResult> | undefined> {
  for (const q of allConversionQueues) {
    const job = await q.getJob(jobId);
    if (job) return job;
  }
  return undefined;
}

/**
 * Cancels a job by ID across all resource queues and default queue.
 */
export async function cancelJobAcrossQueues(
  jobId: string,
  reason: string = 'Cancelled by user'
): Promise<boolean> {
  for (const q of allConversionQueues) {
    const cancelled = await q.cancelJob(jobId, reason);
    if (cancelled) return true;
  }
  return false;
}

// Transparent cross-queue lookup delegation on default conversionQueue
const origConversionQueueGetJob = conversionQueue.getJob.bind(conversionQueue);
conversionQueue.getJob = async (id: string) => {
  const direct = await origConversionQueueGetJob(id);
  if (direct) return direct;
  for (const q of Object.values(resourceQueues)) {
    const found = await q.getJob(id);
    if (found) return found;
  }
  return undefined;
};

const origConversionQueueCancelJob = conversionQueue.cancelJob.bind(conversionQueue);
conversionQueue.cancelJob = async (id: string, reason?: string) => {
  const direct = await origConversionQueueCancelJob(id, reason);
  if (direct) return true;
  for (const q of Object.values(resourceQueues)) {
    const cancelled = await q.cancelJob(id, reason);
    if (cancelled) return true;
  }
  return false;
};

const origConversionQueueGetJobCounts = conversionQueue.getJobCounts.bind(conversionQueue);
conversionQueue.getJobCounts = async () => {
  const [counts, ...queueCounts] = await Promise.all([
    origConversionQueueGetJobCounts(),
    ...Object.values(resourceQueues).map((q) => q.getJobCounts()),
  ]);
  for (const qCounts of queueCounts) {
    for (const [state, count] of Object.entries(qCounts) as [import('./bullmq-engine').JobState, number][]) {
      counts[state] = (counts[state] || 0) + count;
    }
  }
  return counts;
};

const origConversionQueueGetJobs = conversionQueue.getJobs.bind(conversionQueue);
conversionQueue.getJobs = async (types) => {
  const [direct, ...otherLists] = await Promise.all([
    origConversionQueueGetJobs(types),
    ...Object.values(resourceQueues).map((q) => q.getJobs(types)),
  ]);
  return direct.concat(...otherLists);
};

const origConversionQueuePopNextWaiting = conversionQueue._popNextWaiting?.bind(conversionQueue);
conversionQueue._popNextWaiting = async () => {
  const direct = await origConversionQueuePopNextWaiting?.();
  if (direct) return direct;
  for (const q of Object.values(resourceQueues)) {
    if (q._popNextWaiting) {
      const popped = await q._popNextWaiting();
      if (popped) return popped;
    }
  }
  return undefined;
};

const origConversionQueueOnJobCompleted = conversionQueue._onJobCompleted?.bind(conversionQueue);
if (origConversionQueueOnJobCompleted) {
  conversionQueue._onJobCompleted = async (job, result) => {
    const direct = await origConversionQueueOnJobCompleted(job, result);
    if (direct) return true;
    for (const q of Object.values(resourceQueues)) {
      if (q._onJobCompleted) {
        const res = await q._onJobCompleted(job, result);
        if (res) return true;
      }
    }
    return false;
  };
}

const origConversionQueueOnJobFailed = conversionQueue._onJobFailed?.bind(conversionQueue);
if (origConversionQueueOnJobFailed) {
  conversionQueue._onJobFailed = async (job, err) => {
    const direct = await origConversionQueueOnJobFailed(job, err);
    if (direct) return true;
    for (const q of Object.values(resourceQueues)) {
      if (q._onJobFailed) {
        const res = await q._onJobFailed(job, err);
        if (res) return true;
      }
    }
    return false;
  };
}

const origConversionQueueRequeue = conversionQueue._requeue?.bind(conversionQueue);
if (origConversionQueueRequeue) {
  conversionQueue._requeue = async (job, delayMs) => {
    const direct = await origConversionQueueRequeue(job, delayMs);
    if (direct) return true;
    for (const q of Object.values(resourceQueues)) {
      if (q._requeue) {
        const res = await q._requeue(job, delayMs);
        if (res) return true;
      }
    }
    return false;
  };
}

const origConversionQueueClean = conversionQueue.clean.bind(conversionQueue);
conversionQueue.clean = async (grace: number, limit: number, type: 'completed' | 'failed' | 'cancelled') => {
  const [direct, ...otherLists] = await Promise.all([
    origConversionQueueClean(grace, limit, type),
    ...Object.values(resourceQueues).map((q) => q.clean(grace, limit, type)),
  ]);
  return direct.concat(...otherLists).slice(0, limit);
};

const origConversionQueueGetJobsByUser = conversionQueue.getJobsByUser.bind(conversionQueue);
conversionQueue.getJobsByUser = async (userId: string, states?: import('./bullmq-engine').JobState[], limit: number = 50, offset: number = 0) => {
  const [direct, ...otherLists] = await Promise.all([
    origConversionQueueGetJobsByUser(userId, states, limit + offset, 0),
    ...Object.values(resourceQueues).map((q) => q.getJobsByUser(userId, states, limit + offset, 0)),
  ]);
  const flattened = direct.concat(...otherLists);
  flattened.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const seen = new Set<string>();
  const unique: Job<ConversionJobData, ConversionJobResult>[] = [];
  for (const job of flattened) {
    if (!seen.has(job.id)) {
      seen.add(job.id);
      unique.push(job);
    }
  }
  return unique.slice(offset, offset + limit);
};

// Forward lifecycle events from resource queues to default conversionQueue
for (const q of Object.values(resourceQueues)) {
  q.on('waiting', (job) => {
    conversionQueue.emit('waiting', job);
  });
  q.on('progress', (job, progress) => {
    conversionQueue.emit('progress', job, progress);
  });
  q.on('completed', (job, result) => {
    conversionQueue.emit('completed', job, result);
  });
  q.on('failed', (job, err) => {
    conversionQueue.emit('failed', job, err);
  });
  q.on('cancelled', (job) => {
    conversionQueue.emit('cancelled', job);
  });
}

// 2. Worker Lifecycle Management (Producer/Consumer Decoupled)
let workerInstance: Worker<ConversionJobData, ConversionJobResult> | null = null;

export interface StartConversionWorkerOptions extends WorkerOptions {
  queues?: IQueueEngine<ConversionJobData, ConversionJobResult>[];
}

export function startConversionWorker(
  opts: StartConversionWorkerOptions = {}
): Worker<ConversionJobData, ConversionJobResult> {
  if (workerInstance) {
    return workerInstance;
  }
  const queuesToSubscribe =
    opts.queues || (allConversionQueues as IQueueEngine<ConversionJobData, ConversionJobResult>[]);
  const worker = new Worker<ConversionJobData, ConversionJobResult>(
    queuesToSubscribe,
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

