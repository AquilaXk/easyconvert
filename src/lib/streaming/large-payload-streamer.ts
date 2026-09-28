/**
 * Large Payload Streaming & Endurance Soak Engine
 *
 * Implements bounded-buffer chunked streaming for processing massive payloads
 * (up to 2GB+) with constant O(1) heap consumption and zero file descriptor leaks.
 *
 * Standards Compliance:
 * - W3C Streams API / Node.js Stream 3
 * - Strict backpressure signaling via highWaterMark
 * - ISO/IEC 10118-3 SHA-256 streaming verification
 */

import { Readable, Transform, TransformCallback, Writable, pipeline } from 'node:stream';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { IStorageBackend } from '../storage';
import { assertNotSpoofedFile } from '../registry';

export interface LargePayloadStreamConfig {
  /** Size of individual transfer chunks in bytes. Default: 64KB (65,536 bytes) */
  chunkSizeBytes?: number;
  /** High water mark threshold for backpressure control. Default: 64KB */
  highWaterMark?: number;
  /** Maximum allowable peak JS heap delta in MB. Default: 50MB */
  maxHeapDeltaMb?: number;
  /** Optional AbortSignal to terminate stream processing early */
  signal?: AbortSignal;
}

export interface StreamProcessingResult {
  totalBytesProcessed: number;
  totalChunks: number;
  elapsedMs: number;
  throughputMbPerSec: number;
  sha256Digest: string;
  peakHeapUsedDeltaBytes: number;
}

export interface SoakIterationStats {
  iteration: number;
  bytesProcessed: number;
  elapsedMs: number;
  throughputMbPerSec: number;
  heapUsedMb: number;
  rssMb: number;
  openFds: number;
}

export interface SoakSessionReport {
  totalIterations: number;
  totalBytesProcessed: number;
  totalDurationMs: number;
  averageThroughputMbPerSec: number;
  initialHeapMb: number;
  finalHeapMb: number;
  peakHeapMb: number;
  initialFds: number;
  finalFds: number;
  isMemoryStable: boolean;
  history: SoakIterationStats[];
}

/**
 * Returns current count of open file descriptors on Unix-like environments.
 */
export function getOpenFileDescriptorCount(): number {
  try {
    if (fs.existsSync('/proc/self/fd')) {
      return fs.readdirSync('/proc/self/fd').length;
    }
    if (fs.existsSync('/dev/fd')) {
      return fs.readdirSync('/dev/fd').length;
    }
  } catch {
    // Platform does not support /proc/self/fd or /dev/fd enumeration
  }
  return 0;
}

/**
 * Creates a deterministic, backpressure-controlled synthetic Readable stream
 * of arbitrary total size (e.g. 2GB) that consumes O(1) heap memory.
 *
 * @param totalSizeBytes Total byte length of the synthetic stream to produce.
 * @param chunkSizeBytes Size of each generated buffer chunk. Default: 64KB.
 */
export function createDeterministicSyntheticStream(
  totalSizeBytes: number,
  chunkSizeBytes: number = 64 * 1024
): Readable {
  const safeChunkSize = Math.max(1, Math.floor(chunkSizeBytes || 64 * 1024));
  const safeTotalSize = Math.max(0, Math.floor(totalSizeBytes || 0));
  let bytesRemaining = safeTotalSize;
  let chunkSequence = 0;

  // Pre-allocate a single reusable template block bounded to max of min(totalSize, chunkSize) or 1 byte
  const templateSize = Math.max(
    1,
    Math.min(safeTotalSize > 0 ? safeTotalSize : safeChunkSize, safeChunkSize)
  );
  const templateBlock = Buffer.alloc(templateSize);
  for (let i = 0; i < templateSize; i++) {
    templateBlock[i] = (i + (i >> 8)) & 0xff;
  }

  return new Readable({
    highWaterMark: safeChunkSize,
    read() {
      if (bytesRemaining <= 0) {
        this.push(null);
        return;
      }

      const currentChunkSize = Math.min(bytesRemaining, safeChunkSize);
      bytesRemaining -= currentChunkSize;
      chunkSequence++;

      // Clone from reusable template, marking header with sequence index for uniqueness
      const chunk = Buffer.alloc(currentChunkSize);
      for (let offset = 0; offset < currentChunkSize; offset += templateSize) {
        const copyLen = Math.min(templateSize, currentChunkSize - offset);
        templateBlock.copy(chunk, offset, 0, copyLen);
      }

      if (currentChunkSize >= 8) {
        chunk.writeUInt32BE(chunkSequence, 0);
        chunk.writeUInt32BE(bytesRemaining & 0xffffffff, 4);
      }

      this.push(chunk);
    },
  });
}

/**
 * Stream transform calculating SHA-256 digest and byte telemetry without buffering full stream.
 */
export class StreamingHashAndMetricsTransform extends Transform {
  private readonly hash: crypto.Hash;
  private bytesCount: number = 0;
  private chunkCount: number = 0;
  private finalizedDigest: string = '';

  constructor(highWaterMark?: number) {
    super({ highWaterMark: highWaterMark ?? 64 * 1024 });
    this.hash = crypto.createHash('sha256');
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytesCount += chunk.length;
    this.chunkCount++;
    this.hash.update(chunk);
    // Forward chunk downstream to enable pipeline chaining
    callback(null, chunk);
  }

  override _flush(callback: TransformCallback): void {
    this.finalizedDigest = this.hash.digest('hex');
    callback();
  }

  getMetrics(): { totalBytes: number; totalChunks: number; digest: string } {
    return {
      totalBytes: this.bytesCount,
      totalChunks: this.chunkCount,
      digest: this.finalizedDigest,
    };
  }
}

/**
 * Streams a large payload through the metrics pipeline, tracking heap delta,
 * throughput, and SHA-256 checksum without accumulating buffers in memory.
 */
export async function streamProcessLargePayload(
  inputStream: Readable,
  config: LargePayloadStreamConfig = {}
): Promise<StreamProcessingResult> {
  const initialHeap = process.memoryUsage().heapUsed;
  let peakHeap = initialHeap;
  const startTime = Date.now();

  const metricsTransform = new StreamingHashAndMetricsTransform(config.highWaterMark);

  let totalBytes = 0;
  let totalChunks = 0;

  await new Promise<void>((resolve, reject) => {
    let isSettled = false;

    const cleanup = () => {
      isSettled = true;
    };

    const sink = new Writable({
      highWaterMark: config.highWaterMark ?? 64 * 1024,
      write(chunk: Buffer, _encoding, callback) {
        totalBytes += chunk.length;
        totalChunks++;

        const currentHeap = process.memoryUsage().heapUsed;
        if (currentHeap > peakHeap) {
          peakHeap = currentHeap;
        }
        callback();
      },
    });

    pipeline(inputStream, metricsTransform, sink, (err) => {
      if (isSettled) return;
      cleanup();

      if (err) {
        if (config.signal?.aborted && (err.name === 'AbortError' || err.message?.includes('abort'))) {
          resolve();
          return;
        }
        // Strict Fail-Closed error propagation
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      resolve();
    });
  });

  const elapsedMs = Math.max(1, Date.now() - startTime);
  const throughputMbPerSec = (totalBytes / (1024 * 1024)) / (elapsedMs / 1000);
  const metrics = metricsTransform.getMetrics();
  const peakHeapUsedDeltaBytes = Math.max(0, peakHeap - initialHeap);

  return {
    totalBytesProcessed: totalBytes,
    totalChunks,
    elapsedMs,
    throughputMbPerSec,
    sha256Digest: metrics.digest,
    peakHeapUsedDeltaBytes,
  };
}

/**
 * Controller executing long-running endurance soak sessions with telemetry and leak detection.
 */
export class EnduranceSoakController {
  private abortController: AbortController | null = null;
  private isRunning: boolean = false;

  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.isRunning = false;
  }

  get active(): boolean {
    return this.isRunning;
  }

  /**
   * Executes continuous streaming conversion cycles for a specified duration or iteration count.
   */
  async runSoakSession(options: {
    durationMs?: number;
    maxIterations?: number;
    bytesPerIteration?: number;
    chunkSizeBytes?: number;
    warmupIterations?: number;
    onProgress?: (stats: SoakIterationStats) => void;
  }): Promise<SoakSessionReport> {
    this.abortController = new AbortController();
    this.isRunning = true;

    const {
      durationMs = 60_000,
      maxIterations = 100,
      bytesPerIteration = 10 * 1024 * 1024, // 10MB per iteration default
      chunkSizeBytes = 64 * 1024,
      warmupIterations = 3,
      onProgress,
    } = options;

    if (typeof global.gc === 'function') {
      global.gc();
    }

    const initialFds = getOpenFileDescriptorCount();
    const initialHeapMb = process.memoryUsage().heapUsed / (1024 * 1024);
    let peakHeapMb = initialHeapMb;
    let postWarmupHeapMb = initialHeapMb;

    const history: SoakIterationStats[] = [];
    const sessionStartTime = Date.now();
    let iteration = 0;
    let totalBytes = 0;

    try {
      while (
        this.isRunning &&
        !this.abortController.signal.aborted &&
        iteration < maxIterations &&
        Date.now() - sessionStartTime < durationMs
      ) {
        iteration++;
        const iterStream = createDeterministicSyntheticStream(bytesPerIteration, chunkSizeBytes);
        const result = await streamProcessLargePayload(iterStream, {
          chunkSizeBytes,
          signal: this.abortController.signal,
        });

        totalBytes += result.totalBytesProcessed;

        const currentMem = process.memoryUsage();
        const currentHeapMb = currentMem.heapUsed / (1024 * 1024);
        const currentRssMb = currentMem.rss / (1024 * 1024);
        const currentFds = getOpenFileDescriptorCount();

        if (currentHeapMb > peakHeapMb) {
          peakHeapMb = currentHeapMb;
        }

        if (iteration === warmupIterations) {
          if (typeof global.gc === 'function') {
            global.gc();
          }
          postWarmupHeapMb = process.memoryUsage().heapUsed / (1024 * 1024);
        }

        const stats: SoakIterationStats = {
          iteration,
          bytesProcessed: result.totalBytesProcessed,
          elapsedMs: result.elapsedMs,
          throughputMbPerSec: result.throughputMbPerSec,
          heapUsedMb: currentHeapMb,
          rssMb: currentRssMb,
          openFds: currentFds,
        };

        history.push(stats);
        onProgress?.(stats);
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    } finally {
      this.isRunning = false;
    }

    if (typeof global.gc === 'function') {
      global.gc();
    }

    const finalMem = process.memoryUsage();
    const finalHeapMb = finalMem.heapUsed / (1024 * 1024);
    const finalFds = getOpenFileDescriptorCount();
    const totalDurationMs = Math.max(1, Date.now() - sessionStartTime);
    const averageThroughputMbPerSec = (totalBytes / (1024 * 1024)) / (totalDurationMs / 1000);

    // Memory is considered stable if heap growth post-warmup is bounded under 35MB
    const heapGrowthPostWarmupMb = Math.max(0, finalHeapMb - postWarmupHeapMb);
    const fdDelta = Math.abs(finalFds - initialFds);
    const isMemoryStable = heapGrowthPostWarmupMb < 35 && fdDelta <= 3;

    return {
      totalIterations: iteration,
      totalBytesProcessed: totalBytes,
      totalDurationMs,
      averageThroughputMbPerSec,
      initialHeapMb,
      finalHeapMb,
      peakHeapMb,
      initialFds,
      finalFds,
      isMemoryStable,
      history,
    };
  }
}

export interface StreamToStorageOptions {
  filename: string;
  mimeType: string;
  expectedTotalSize: number;
  sourceExtension: string;
  storage: IStorageBackend;
  partSizeBytes?: number; // default 5MB (5 * 1024 * 1024)
  signal?: AbortSignal;
}

export interface StreamToStorageResult {
  storageKey: string;
  uploadId: string;
  totalBytes: number;
  totalParts: number;
  sha256Digest: string;
  elapsedMs: number;
  peakHeapDeltaBytes: number;
}

/**
 * Universal async chunk generator supporting both Node.js Readable streams and W3C ReadableStream.
 */
async function* getStreamChunkGenerator(
  stream: Readable | ReadableStream<Uint8Array> | Buffer | Uint8Array | any
): AsyncGenerator<Buffer> {
  if (Buffer.isBuffer(stream)) {
    yield stream;
    return;
  }
  if (stream instanceof Uint8Array) {
    yield Buffer.from(stream);
    return;
  }
  if (typeof stream[Symbol.asyncIterator] === 'function') {
    for await (const chunk of stream) {
      yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    }
  } else if (typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          yield Buffer.isBuffer(value) ? value : Buffer.from(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
  } else {
    throw new Error('Unsupported stream: stream object must provide async iterator or getReader() method.');
  }
}

/**
 * Pipes an incoming ReadableStream/Readable directly to storage multipart upload
 * with bounded O(1) heap memory consumption (<= 50MB) and early MIME magic sniffing.
 */
export async function pipeStreamToStorageMultipart(
  stream: Readable | ReadableStream<Uint8Array> | Buffer | Uint8Array | any,
  options: StreamToStorageOptions
): Promise<StreamToStorageResult> {
  const {
    filename,
    mimeType,
    expectedTotalSize,
    sourceExtension,
    storage,
    partSizeBytes = 5 * 1024 * 1024, // 5MB standard multipart part size
    signal,
  } = options;

  const startTime = Date.now();
  const initialHeap = process.memoryUsage().heapUsed;
  let peakHeap = initialHeap;

  const generator = getStreamChunkGenerator(stream);

  // 1. Accumulate initial chunks (up to 64KB) for early MIME magic sniffing
  const SNIFF_HEADER_BYTES = 64 * 1024;
  const initialChunks: Buffer[] = [];
  let initialBytes = 0;

  let firstResult = await generator.next();
  if (firstResult.done || !firstResult.value || firstResult.value.length === 0) {
    throw new Error('File payload is empty (0 bytes).');
  }

  while (!firstResult.done && firstResult.value && firstResult.value.length > 0) {
    initialChunks.push(firstResult.value);
    initialBytes += firstResult.value.length;
    if (initialBytes >= SNIFF_HEADER_BYTES) {
      break;
    }
    firstResult = await generator.next();
  }

  const initialBuffer = Buffer.concat(initialChunks);
  // Fail-closed verification against spoofed file extensions using initial-chunk MIME magic sniffing
  assertNotSpoofedFile(initialBuffer, sourceExtension, filename);

  // 2. Initiate multipart session in storage
  const init = storage.initiateMultipartUpload(filename, mimeType, expectedTotalSize);
  const uploadId = init.uploadId;

  const hasher = crypto.createHash('sha256');
  hasher.update(initialBuffer);

  let totalBytes = initialBuffer.length;
  let partNumber = 1;
  let currentPartChunks: Buffer[] = [initialBuffer];
  let currentPartBytes = initialBuffer.length;

  try {
    for await (const chunk of generator) {
      if (signal?.aborted) {
        throw new Error('Streaming upload aborted by client signal.');
      }

      hasher.update(chunk);
      totalBytes += chunk.length;
      currentPartChunks.push(chunk);
      currentPartBytes += chunk.length;

      const curHeap = process.memoryUsage().heapUsed;
      if (curHeap > peakHeap) {
        peakHeap = curHeap;
      }

      // When accumulated chunks reach or exceed partSizeBytes (5MB), upload part
      if (currentPartBytes >= partSizeBytes) {
        const partBuffer = currentPartChunks.length === 1
          ? currentPartChunks[0]
          : Buffer.concat(currentPartChunks);
        storage.uploadPart(uploadId, partNumber++, partBuffer);

        // Clear references immediately to keep heap consumption bounded to O(1)
        currentPartChunks = [];
        currentPartBytes = 0;
      }
    }

    // Upload remaining trailing chunk if any, or if no parts were uploaded yet
    if (currentPartBytes > 0 || partNumber === 1) {
      const finalPartBuffer = currentPartChunks.length === 1
        ? currentPartChunks[0]
        : Buffer.concat(currentPartChunks);
      storage.uploadPart(uploadId, partNumber++, finalPartBuffer);
      currentPartChunks = [];
      currentPartBytes = 0;
    }

    const completed = storage.completeMultipartUpload(uploadId);
    const elapsedMs = Math.max(1, Date.now() - startTime);
    const sha256Digest = hasher.digest('hex');
    const peakHeapDeltaBytes = Math.max(0, peakHeap - initialHeap);

    return {
      storageKey: completed.key,
      uploadId,
      totalBytes,
      totalParts: partNumber - 1,
      sha256Digest,
      elapsedMs,
      peakHeapDeltaBytes,
    };
  } catch (err) {
    try {
      storage.abortMultipartUpload(uploadId);
    } catch {}
    throw err;
  }
}

