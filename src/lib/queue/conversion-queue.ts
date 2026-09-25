import { Queue, Worker, Job } from './bullmq-engine';
import { ConversionJobData, ConversionJobResult } from '../types';
import { convertFile } from '../conversions';
import { s3Storage } from '../storage/s3-storage';

// 1. Initialize Conversion Queue
export const conversionQueue = new Queue<ConversionJobData, ConversionJobResult>('easyconvert-jobs');

// 2. Initialize Worker with Concurrency = 5
export const conversionWorker = new Worker<ConversionJobData, ConversionJobResult>(
  conversionQueue,
  async (job: Job<ConversionJobData, ConversionJobResult>): Promise<ConversionJobResult> => {
    const startTime = Date.now();
    await job.log(`Worker picked up conversion job for file: ${job.data.originalFilename}`);
    await job.updateProgress(10);

    // 1. Obtain input buffer from Storage Key or Base64 payload
    let inputBuffer: Buffer;
    if (job.data.storageKey) {
      const stored = s3Storage.getObject(job.data.storageKey);
      if (!stored) {
        throw new Error(`S3 object not found for key: "${job.data.storageKey}"`);
      }
      inputBuffer = stored.buffer;
    } else if (job.data.inputBufferBase64) {
      inputBuffer = Buffer.from(job.data.inputBufferBase64, 'base64');
    } else {
      throw new Error('Missing input file data. Neither storageKey nor inputBufferBase64 was provided.');
    }

    await job.log(`Input payload loaded (${inputBuffer.length} bytes). Transcoding ${job.data.sourceFormat} -> ${job.data.targetFormat}...`);
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

    // 3. Save output artifact to storage
    const resultKey = `results/${job.id}/${conversionResult.filename}`;
    s3Storage.saveObject(
      resultKey,
      conversionResult.buffer,
      conversionResult.mimeType,
      conversionResult.filename
    );

    const durationMs = Date.now() - startTime;
    await job.updateProgress(100);
    await job.log(`Result persisted. Available at: /api/storage/file/${encodeURIComponent(resultKey)} (took ${durationMs}ms)`);

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
  },
  { concurrency: 5 }
);
