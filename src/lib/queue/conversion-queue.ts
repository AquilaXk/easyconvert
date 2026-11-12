import { Queue, Worker, Job, createQueueEngine, IQueueEngine, WorkerOptions } from './bullmq-engine';
import type { ConversionJobData, ConversionJobResult, ResourceClass } from '../types';
import { storageProvider } from '../storage';
import { releaseResultHold } from '../storage/retention-service';
import { redisKeyStore } from '../api-keys/redis-key-store';
import { leaseToHandedOffWork } from '../api-keys/hand-off';
import { MISSING_WEBHOOK_SECRET_REASON, webhookDispatcher } from '../api-keys/webhook-dispatcher';
import { processNodeJob } from './node-processor';
import { recordJobResultInHistory } from './job-history';
import { isFinalFailure } from './job-failure';
import { refusalCodeList } from '../refusal-codes';
import { dispatchEngine } from './dispatch-engine';
import { openWebhookSecretOrLog } from '../security/sealed-webhook-secret';
import { resolveResourceClass } from './resource-class';
import { endedJobRetentionMs, legacyJobTimeoutMs } from './enqueue';
import { graphScheduler } from './graph/scheduler';
import { recordJobCompleted, recordJobFailed } from '../metrics/recorders';

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
  return processNodeJob(job, dispatchEngine, storageProvider);
}

/**
 * Tells the graph scheduler that the job of a graph node ended without a result: its last attempt failed, the stalled
 * sweep failed it, or it was cancelled. Every end of a node job raises one of those events, so each reaches the scheduler
 * however the node ended, also when the node never ran its own failure path (a stalled or killed worker, a cancel by an
 * operator). A node that already ended is ignored by the scheduler, so a second report changes nothing.
 */
async function reportGraphNodeEnded(job: Job<ConversionJobData, ConversionJobResult>, reason: string, failure?: unknown): Promise<void> {
  const graphId = job.data?.graphId;
  const nodeId = job.data?.graphNodeId;
  if (!graphId || !nodeId) return;
  try {
    await graphScheduler.onNodeFailed(graphId, nodeId, reason, ...refusalCodeList(failure));
  } catch (graphErr) {
    console.error(`[ConversionQueue] Failed to fail graph node ${nodeId} of ${graphId}:`, graphErr);
  }
}

/**
 * Attaches unified job lifecycle event listeners for 2-phase quota accounting and webhook dispatching.
 * Shared across both in-process and dedicated OCI backend daemon workers.
 */
export function attachJobLifecycleListeners(
  worker: Worker<ConversionJobData, ConversionJobResult>
): void {
  // The worker emits `completed` and `failed` once per job, at its end, so each counts one job (src/lib/metrics, docs/slo.md).
  worker.on('completed', (job: Job<ConversionJobData, ConversionJobResult>) => recordJobCompleted(job));
  worker.on('failed', (job: Job<ConversionJobData, ConversionJobResult>, err: unknown) => recordJobFailed(job, err));
  // The result joins its owner's history on a listener of its own, so a webhook that is slow to answer does not delay it.
  worker.on('completed', (job: Job<ConversionJobData, ConversionJobResult>, result: ConversionJobResult) => {
    void recordJobResultInHistory(job, result);
  });

  // A worker that takes a job renews its reservation to the lease of handed-off work, so a job whose request could not tell
  // that it was stored is still charged however long it runs, when a worker takes it within the provisional lease.
  worker.on('active', async (job: Job<ConversionJobData, ConversionJobResult>) => {
    if (job.data?.reservationId) await leaseToHandedOffWork(job.data.reservationId);
  });

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
        const webhookSecret = openWebhookSecretOrLog(job.data.webhookSecret, String(job.id), `job ${job.id}`);
        if (!webhookSecret) {
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
              webhookSecret,
              { ownerUserId: job.data.userId, ownerKeyId: job.data.webhookKeyId }
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
      // Only a successful conversion is charged: every unrecoverable failure, a job past its deadline included, rolls
      // the reservation back (QA decision 2026-10-10).
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

      // The worker emits `failed` once, for the last attempt of a job, so a graph node is failed in its graph here.
      await reportGraphNodeEnded(job, err instanceof Error ? err.message : String(err), err);

      // Asynchronous Webhook Failure Notification
      if (job.data?.webhookUrl) {
        const webhookSecret = openWebhookSecretOrLog(job.data.webhookSecret, String(job.id), `job ${job.id}`);
        if (!webhookSecret) {
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
                error: job.failedReason,
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
                error: job.failedReason,
                originalFilename: job.data.originalFilename,
              },
              webhookSecret,
              { ownerUserId: job.data.userId, ownerKeyId: job.data.webhookKeyId }
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
 * Ends the hold of a job on its input once the worker has recorded its completion or its last failure; an upload no
 * other job holds is deleted after a short grace period (see `releaseResultHold`). Attach it to every worker that
 * runs processConversionJob.
 */
export function attachInputCleanupOnCompletion(
  worker: Worker<ConversionJobData, ConversionJobResult>
): void {
  worker.on('completed', (job: Job<ConversionJobData, ConversionJobResult>) => {
    if (job.data?.storageKey) {
      void releaseResultHold(job.data.storageKey, job.id);
    }
  });
  worker.on('failed', (job: Job<ConversionJobData, ConversionJobResult>, err: unknown) => {
    if (job.data?.storageKey && isFinalFailure(job, err)) {
      void releaseResultHold(job.data.storageKey, job.id);
    }
  });
}

/**
 * Owns the quota refund and the release of the input for cancelled jobs. The engine emits `cancelled` once per cancelled
 * job, in the process whose cancelJob won the transition, so every cancel path refunds exactly once. Attach it to one
 * queue only: the resource queues pass their `cancelled` events on to the default queue, which holds it.
 */
export function attachJobCancellationListeners(
  queue: IQueueEngine<ConversionJobData, ConversionJobResult>
): void {
  queue.on('cancelled', async (job: Job<ConversionJobData, ConversionJobResult>) => {
    // A cancelled job never runs again, so it no longer needs its input, and a graph node it ran ended without a result.
    if (job.data?.storageKey) {
      await releaseResultHold(job.data.storageKey, job.id);
    }
    await reportGraphNodeEnded(job, job.failedReason || 'The job was cancelled.');
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
/** The counts of the default queue alone; `conversionQueue.getJobCounts` below adds those of the resource queues. */
export const defaultQueueOwnJobCounts = origConversionQueueGetJobCounts;
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

// The default queue is popped from on behalf of the resource queues (above), so a job it hands out lives in one of
// them: the deadline is claimed where the job is, and never written to a queue that does not hold it.
const origConversionQueueClaimDeadline = conversionQueue._claimDeadline?.bind(conversionQueue);
if (origConversionQueueClaimDeadline) {
  conversionQueue._claimDeadline = async (job, candidateAt) => {
    const direct = await origConversionQueueClaimDeadline(job, candidateAt);
    if (direct !== undefined) return direct;
    for (const q of Object.values(resourceQueues)) {
      if (q._claimDeadline) {
        const recorded = await q._claimDeadline(job, candidateAt);
        if (recorded !== undefined) return recorded;
      }
    }
    return undefined;
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
  const removed: string[] = [];
  for (const q of [{ clean: origConversionQueueClean }, ...Object.values(resourceQueues)]) {
    if (removed.length >= limit) break;
    removed.push(...(await q.clean(grace, limit - removed.length, type)));
  }
  return removed;
};

const origConversionQueueForgetUser = conversionQueue.forgetUser?.bind(conversionQueue);
if (origConversionQueueForgetUser) {
  conversionQueue.forgetUser = async (userId: string, processed: ReadonlySet<string>) => {
    const left = await Promise.all([origConversionQueueForgetUser(userId, processed), ...Object.values(resourceQueues).map((q) => q.forgetUser?.(userId, processed) ?? [])]);
    return left.flat();
  };
}

const origConversionQueueRemove = conversionQueue.remove.bind(conversionQueue);
conversionQueue.remove = async (id: string) => {
  const removed = await Promise.all([origConversionQueueRemove(id), ...Object.values(resourceQueues).map((q) => q.remove(id))]);
  return removed.includes(true);
};

const origConversionQueueGetJobsByUser = conversionQueue.getJobsByUser.bind(conversionQueue);
conversionQueue.getJobsByUser = async (userId: string, states?: import('./bullmq-engine').JobState[], limit: number = 50, offset: number = 0, options?: import('./bullmq-engine').UserJobsOptions) => {
  const [direct, ...otherLists] = await Promise.all([
    origConversionQueueGetJobsByUser(userId, states, limit + offset, 0, options),
    ...Object.values(resourceQueues).map((q) => q.getJobsByUser(userId, states, limit + offset, 0, options)),
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

const ENDED_RECORD_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const ENDED_RECORD_SWEEP_LIMIT = 1000;
const ENDED_JOB_STATES = ['completed', 'failed', 'cancelled'] as const;

/**
 * Removes the conversion jobs that ended more than `endedJobRetentionMs` ago, with their dead letters, and the webhook dead
 * letters past their retention. A job's own `removeOnComplete` / `removeOnFail` age removes ended jobs only when a later job
 * of its queue ends, so this sweep covers a queue that went quiet, cancelled jobs, and jobs queued before the option existed.
 */
export async function sweepEndedRecords(): Promise<void> {
  const grace = endedJobRetentionMs();
  for (const state of ENDED_JOB_STATES) {
    await conversionQueue.clean(grace, ENDED_RECORD_SWEEP_LIMIT, state);
  }
  await webhookDispatcher.purgeExpiredDlqEntries();
}

let endedRecordSweepTimer: NodeJS.Timeout | null = null;

/** Runs `sweepEndedRecords` now and every ENDED_RECORD_SWEEP_INTERVAL_MS; a failed run is logged and the next one tries again. */
export function startEndedRecordSweep(): void {
  if (endedRecordSweepTimer) return;
  const run = () => {
    sweepEndedRecords().catch((err: unknown) => console.error('[ConversionQueue] The sweep of ended jobs failed:', err));
  };
  run();
  endedRecordSweepTimer = setInterval(run, ENDED_RECORD_SWEEP_INTERVAL_MS);
  endedRecordSweepTimer.unref();
}

export function stopEndedRecordSweep(): void {
  if (endedRecordSweepTimer) clearInterval(endedRecordSweepTimer);
  endedRecordSweepTimer = null;
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
    { concurrency: opts.concurrency || 5, defaultTimeoutMs: legacyJobTimeoutMs }
  );
  attachJobLifecycleListeners(worker);
  attachInputCleanupOnCompletion(worker);
  startEndedRecordSweep();
  workerInstance = worker;
  return worker;
}

export async function stopConversionWorker(): Promise<void> {
  stopEndedRecordSweep();
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

