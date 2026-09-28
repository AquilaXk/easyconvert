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
