import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  conversionQueue,
  resourceQueues,
  allConversionQueues,
  attachJobLifecycleListeners,
  attachInputCleanupOnCompletion,
} from '../lib/queue/conversion-queue';
import { Worker, Job, IQueueEngine, JobCancelledError } from '../lib/queue/bullmq-engine';
import type { ConversionJobData, ConversionJobResult, ResourceClass } from '../lib/types';
import { storageProvider as ociStorage } from '../lib/storage';
import { processNodeJob, nativeEngine } from '../lib/queue/node-processor';
import { killProcessGroup } from '../lib/security/process-sandbox';
import { probeNativeEngines } from './engines';
import { shutdownSharedOcrWorkerPool } from '../lib/conversions/ocr-worker-pool';

export interface WorkerLifecycleConfig {
  concurrency: number;
  maxJobsBeforeRecycle: number;
  maxRssMbBeforeRecycle: number;
  drainTimeoutMs: number;
  heartbeatIntervalMs: number;
  heartbeatFilePath: string;
}

export function getWorkerLifecycleConfig(): WorkerLifecycleConfig {
  return {
    concurrency: Number.parseInt(process.env.WORKER_CONCURRENCY || '3', 10),
    maxJobsBeforeRecycle: Number.parseInt(process.env.WORKER_MAX_JOBS || '1000', 10),
    maxRssMbBeforeRecycle: Number.parseInt(process.env.WORKER_MAX_RSS_MB || '4096', 10),
    drainTimeoutMs: Number.parseInt(process.env.WORKER_DRAIN_TIMEOUT_MS || '60000', 10),
    heartbeatIntervalMs: Number.parseInt(process.env.WORKER_HEARTBEAT_INTERVAL_MS || '5000', 10),
    heartbeatFilePath: process.env.WORKER_HEARTBEAT_FILE || path.join(os.tmpdir(), 'worker-heartbeat.json'),
  };
}

export const activeJobs = new Set<Job<ConversionJobData, ConversionJobResult>>();
export let processedJobsCount = 0;
export let isDraining = false;
let heartbeatTimer: NodeJS.Timeout | null = null;

export function setProcessedJobsCount(count: number): void {
  processedJobsCount = count;
}

export function resetWorkerLifecycleState(): void {
  activeJobs.clear();
  processedJobsCount = 0;
  isDraining = false;
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/**
 * Checks whether the worker should be recycled due to processed job count or RSS memory threshold.
 */
export function checkRecycleNeeded(
  config: WorkerLifecycleConfig = getWorkerLifecycleConfig()
): { needed: boolean; reason?: 'job_count' | 'rss_memory' } {
  if (config.maxJobsBeforeRecycle > 0 && processedJobsCount >= config.maxJobsBeforeRecycle) {
    return { needed: true, reason: 'job_count' };
  }

  if (config.maxRssMbBeforeRecycle > 0) {
    const rssMb = process.memoryUsage().rss / (1024 * 1024);
    if (rssMb >= config.maxRssMbBeforeRecycle) {
      return { needed: true, reason: 'rss_memory' };
    }
  }

  return { needed: false };
}

/**
 * Writes heartbeat metadata to local filesystem for healthcheck monitoring.
 */
export function writeHeartbeatSync(
  status: 'healthy' | 'draining' | 'stopped' = 'healthy',
  filePath?: string
): void {
  const targetPath = filePath || getWorkerLifecycleConfig().heartbeatFilePath;
  const rssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
  const payload = {
    pid: process.pid,
    timestamp: Date.now(),
    status,
    activeJobs: activeJobs.size,
    processedJobs: processedJobsCount,
    rssMb,
  };
  try {
    const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), { encoding: 'utf-8', mode: 0o644 });
    fs.renameSync(tmpPath, targetPath);
  } catch {
    // Non-fatal error in restricted test/local environments
  }
}

/**
 * Starts periodic heartbeat updates.
 */
export function startHeartbeat(
  intervalMs: number = getWorkerLifecycleConfig().heartbeatIntervalMs,
  filePath?: string
): NodeJS.Timeout {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }
  writeHeartbeatSync('healthy', filePath);
  heartbeatTimer = setInterval(() => {
    if (!isDraining) {
      writeHeartbeatSync('healthy', filePath);
    }
  }, intervalMs);
  if (typeof heartbeatTimer.unref === 'function') {
    heartbeatTimer.unref();
  }
  return heartbeatTimer;
}

/**
 * Stops periodic heartbeat and marks heartbeat file as stopped/cleaned.
 */
export function stopHeartbeat(filePath?: string): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  const targetPath = filePath || getWorkerLifecycleConfig().heartbeatFilePath;
  try {
    if (fs.existsSync(targetPath)) {
      writeHeartbeatSync('stopped', targetPath);
    }
  } catch {}
}

/**
 * Parses WORKER_QUEUES environment variable (e.g. 'light,cpu') to determine subscribed queues.
 * Defaults to all queues (all resource queues + default conversion queue) for unified local DX.
 */
export function resolveSubscribedQueues(): IQueueEngine<ConversionJobData, ConversionJobResult>[] {
  const envQueues = process.env.WORKER_QUEUES?.trim();
  if (!envQueues) {
    return allConversionQueues as IQueueEngine<ConversionJobData, ConversionJobResult>[];
  }

  const tokens = envQueues.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  const selected: IQueueEngine<ConversionJobData, ConversionJobResult>[] = [];

  for (const token of tokens) {
    if (token === 'default' || token === 'easyconvert-jobs') {
      selected.push(conversionQueue);
    } else if (token in resourceQueues) {
      selected.push(resourceQueues[token as ResourceClass]);
    } else if (token.startsWith('easyconvert-jobs:')) {
      const cls = token.replace('easyconvert-jobs:', '') as ResourceClass;
      if (cls in resourceQueues) {
        selected.push(resourceQueues[cls]);
      }
    }
  }

  return selected.length > 0
    ? selected
    : (allConversionQueues as IQueueEngine<ConversionJobData, ConversionJobResult>[]);
}

const config = getWorkerLifecycleConfig();
const subscribedQueues = resolveSubscribedQueues();

console.log(
  `[EasyConvert OCI Worker] Initializing daemon (Concurrency: ${config.concurrency}, Queues: ${subscribedQueues.map((q) => q.name).join(', ')})...`
);

// Resolve the native binaries and probe ffmpeg's hardware encoders once at startup. The probe is
// synchronous and cached per binary, so jobs hit the cache instead of blocking the event loop.
probeNativeEngines();

export const ociWorker = new Worker<ConversionJobData, ConversionJobResult>(
  subscribedQueues,
  async (job: Job<ConversionJobData, ConversionJobResult>): Promise<ConversionJobResult> => {
    activeJobs.add(job);
    try {
      return await processNodeJob(job, nativeEngine, ociStorage);
    } finally {
      activeJobs.delete(job);
      processedJobsCount++;

      // Evaluate self-recycling criteria upon job completion
      if (!isDraining) {
        const recycle = checkRecycleNeeded(config);
        if (recycle.needed) {
          console.log(
            `[EasyConvert OCI Worker] Self-recycling triggered (reason: ${recycle.reason}, processed: ${processedJobsCount}). Draining worker cleanly...`
          );
          void drainWorker('RECYCLE').then(() => {
            if (process.env.NODE_ENV !== 'test') {
              process.exit(0);
            }
          });
        }
      }
    }
  },
  { concurrency: config.concurrency }
);

// Attach 2-phase quota accounting, webhook dispatch listeners, and input cleanup
attachJobLifecycleListeners(ociWorker);
attachInputCleanupOnCompletion(ociWorker);

/**
 * Gracefully drains the worker daemon:
 * 1. Stops popping new jobs immediately.
 * 2. Updates heartbeat to 'draining'.
 * 3. Waits up to drainTimeoutMs for active jobs to finish.
 * 4. If timeout expires, aborts remaining active jobs and forces process group termination.
 * 5. Closes queue worker and cleans up heartbeat state.
 */
export async function drainWorker(
  signal: string = 'SIGTERM',
  timeoutMs: number = getWorkerLifecycleConfig().drainTimeoutMs
): Promise<void> {
  if (isDraining) return;
  isDraining = true;
  console.log(
    `[EasyConvert OCI Worker] Received ${signal}. Draining active jobs (active: ${activeJobs.size}, timeout: ${timeoutMs}ms)...`
  );
  writeHeartbeatSync('draining');

  // Stop polling for new jobs immediately while preserving lifecycle listeners
  ociWorker.pause();

  if (activeJobs.size > 0) {
    let timer: NodeJS.Timeout | null = null;
    let checkInterval: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });

    const drainPromise = new Promise<'drained'>((resolve) => {
      checkInterval = setInterval(() => {
        if (activeJobs.size === 0) {
          if (checkInterval) clearInterval(checkInterval);
          resolve('drained');
        }
      }, 50);
    });

    try {
      const outcome = await Promise.race([drainPromise, timeoutPromise]);
      if (outcome === 'timeout' && activeJobs.size > 0) {
        console.warn(
          `[EasyConvert OCI Worker] Grace timeout (${timeoutMs}ms) expired with ${activeJobs.size} jobs still active. Forcing termination...`
        );
        for (const job of activeJobs) {
          try {
            job._abortAttempt(new JobCancelledError('Worker shutdown grace period expired'));
          } catch {}
        }
      }
    } finally {
      if (timer) clearTimeout(timer);
      if (checkInterval) clearInterval(checkInterval);
    }
  }

  // Close worker queue subscriptions and clean up listeners after active jobs finish
  await ociWorker.close();
  await shutdownSharedOcrWorkerPool();

  stopHeartbeat();
  console.log(`[EasyConvert OCI Worker] Worker daemon drain completed cleanly.`);
}

// Start local heartbeat monitoring
startHeartbeat();

// Attach signal listeners in non-test environments
if (process.env.NODE_ENV !== 'test') {
  process.on('SIGINT', () => {
    void drainWorker('SIGINT')
      .then(() => process.exit(0))
      .catch((err) => {
        console.error(`[EasyConvert OCI Worker] Shutdown error on SIGINT:`, err);
        process.exit(1);
      });
  });

  process.on('SIGTERM', () => {
    void drainWorker('SIGTERM')
      .then(() => process.exit(0))
      .catch((err) => {
        console.error(`[EasyConvert OCI Worker] Shutdown error on SIGTERM:`, err);
        process.exit(1);
      });
  });
}

console.log(`[EasyConvert OCI Worker] Worker daemon online and listening for jobs.`);
