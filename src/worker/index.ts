import {
  conversionQueue,
  resourceQueues,
  allConversionQueues,
  attachJobLifecycleListeners,
  attachInputCleanupOnCompletion,
} from '../lib/queue/conversion-queue';
import { Worker, Job, IQueueEngine } from '../lib/queue/bullmq-engine';
import type { ConversionJobData, ConversionJobResult, ResourceClass } from '../lib/types';
import { storageProvider as ociStorage } from '../lib/storage';
import { processNodeJob, nativeEngine } from '../lib/queue/node-processor';

const CONCURRENCY = Number.parseInt(process.env.WORKER_CONCURRENCY || '3', 10);

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

const subscribedQueues = resolveSubscribedQueues();
console.log(
  `[EasyConvert OCI Worker] Initializing daemon (Concurrency: ${CONCURRENCY}, Queues: ${subscribedQueues.map((q) => q.name).join(', ')})...`
);

export const ociWorker = new Worker<ConversionJobData, ConversionJobResult>(
  subscribedQueues,
  async (job: Job<ConversionJobData, ConversionJobResult>): Promise<ConversionJobResult> => {
    return processNodeJob(job, nativeEngine, ociStorage);
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
