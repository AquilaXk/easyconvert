import fs from 'node:fs';
import { conversionQueue } from '../lib/queue/conversion-queue';
import { Worker, Job } from '../lib/queue/bullmq-engine';
import { ConversionJobData, ConversionJobResult } from '../lib/types';
import { storageProvider as ociStorage } from '../lib/storage';
import { executeWorkerConversion, WorkerConversionResult, WorkerVfsPayload } from './engines';
import { secureShredBuffer } from '../lib/security/memory-shredder';

const CONCURRENCY = Number.parseInt(process.env.WORKER_CONCURRENCY || '3', 10);

console.log(`[EasyConvert OCI Worker] Initializing daemon (Concurrency: ${CONCURRENCY})...`);

export const ociWorker = new Worker<ConversionJobData, ConversionJobResult>(
  conversionQueue,
  async (job: Job<ConversionJobData, ConversionJobResult>): Promise<ConversionJobResult> => {
    const startTime = Date.now();
    await job.log(`[OCI Worker] Picked up job ${job.id} for "${job.data.originalFilename}" (${job.data.sourceFormat} -> ${job.data.targetFormat})`);
    await job.updateProgress(10);

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
      const result: WorkerConversionResult = await executeWorkerConversion(
        inputPayload,
        job.data.sourceFormat,
        job.data.targetFormat,
        job.data.options,
        job.data.originalFilename
      );

      await job.updateProgress(75);
      await job.log(`[OCI Worker] Conversion completed via [${result.engineUsed}] in ${result.executionTimeMs}ms. Size: ${result.size} bytes`);

      // 3. Store result in OCI Object Storage with 1-hour TTL (Zero-Heap from file if available)
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

// Graceful shutdown
function shutdown(signal: string) {
  console.log(`[EasyConvert OCI Worker] Received ${signal}. Shutting down cleanly...`);
  ociWorker.close().then(() => {
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log(`[EasyConvert OCI Worker] Worker daemon online and listening for jobs.`);
