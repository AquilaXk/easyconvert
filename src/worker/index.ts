import {
  conversionQueue,
  attachJobLifecycleListeners,
  attachInputCleanupOnCompletion,
} from '../lib/queue/conversion-queue';
import { Worker, Job } from '../lib/queue/bullmq-engine';
import type { ConversionJobData, ConversionJobResult } from '../lib/types';
import { storageProvider as ociStorage } from '../lib/storage';
import { processNodeJob, nativeEngine } from '../lib/queue/node-processor';

const CONCURRENCY = Number.parseInt(process.env.WORKER_CONCURRENCY || '3', 10);

console.log(`[EasyConvert OCI Worker] Initializing daemon (Concurrency: ${CONCURRENCY})...`);

export const ociWorker = new Worker<ConversionJobData, ConversionJobResult>(
  conversionQueue,
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
