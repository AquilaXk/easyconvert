/**
 * OPFS Large File Synchronous Streaming VFS Worker (Level 3 - L3)
 *
 * Implements:
 * 1. FileSystemSyncAccessHandle 4MB chunked synchronous streaming I/O.
 * 2. Session isolation under /easyconvert/sessions/${sessionId}/.
 * 3. Deterministic file lock release invariant (try ... finally { handle.close(); }).
 * 4. Memory-bounded processing for 100MB+ ~ 2GB files with peak memory strictly bounded (<50MB).
 */

import { ConversionFailedError } from '../../types';
import { type ChunkTransformerFn, forEachOutputPiece } from './chunk-transformer';
import { createDelimitedStreamTransformer, isStreamableDelimitedPair } from './delimited-stream';
import { resolveAudioStreamTransformer } from './opfs-audio';
import { createGunzipTarTransformer, createTarGzipTransformer } from './opfs-archive';
import { EdgeUnsupportedError, serializeWorkerError, type SerializedWorkerError } from './worker-errors';

export type { ChunkTransformerFn } from './chunk-transformer';

export const OPFS_CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB chunk window
const RGBA_PIXEL_BYTES = 4;

export interface OpfsConversionJob {
  jobId: string;
  sourceFormat: string;
  targetFormat: string;
  totalSize: number;
  options?: Record<string, any>;
}

export interface OpfsChunkProgress {
  type: 'PROGRESS';
  jobId: string;
  progress: number;
  bytesProcessed: number;
}

export interface OpfsJobCompleted {
  type: 'COMPLETED';
  jobId: string;
  outputSize: number;
  buffer?: ArrayBuffer;
  blob?: Blob;
}

export interface OpfsJobError {
  type: 'ERROR';
  jobId: string;
  message: string;
  /** The thrown error as data, so the main thread can rebuild its class. */
  error: SerializedWorkerError;
}

function isGrayscalePair(src: string, tgt: string): boolean {
  return (src === 'rgba' || src === 'raw') && (tgt === 'grayscale' || tgt === 'gray');
}

function isTarGzipPair(src: string, tgt: string): boolean {
  return src === 'tar' && (tgt === 'tar_gz' || tgt === 'gz');
}

function isGunzipTarPair(src: string, tgt: string): boolean {
  return (src === 'gz' || src === 'tar_gz') && tgt === 'tar';
}

function buildGrayscaleTransformer(): ChunkTransformerFn {
  let checked = false;
  return (chunk: Uint8Array, _offset: number, totalSize: number) => {
    if (!checked) {
      checked = true;
      // Windows are a multiple of the pixel size, so only the whole input can end inside a pixel.
      if (totalSize % RGBA_PIXEL_BYTES !== 0) {
        throw new EdgeUnsupportedError('The raw image is not a whole number of RGBA pixels; the server engine converts it.');
      }
    }
    const out = new Uint8Array(chunk.byteLength);
    const pixelCount = Math.floor(chunk.byteLength / RGBA_PIXEL_BYTES);
    for (let i = 0; i < pixelCount; i++) {
      const idx = i * RGBA_PIXEL_BYTES;
      const r = chunk[idx];
      const g = chunk[idx + 1];
      const b = chunk[idx + 2];
      const a = chunk[idx + 3];
      const gray = (77 * r + 150 * g + 29 * b) >> 8;
      out[idx] = gray;
      out[idx + 1] = gray;
      out[idx + 2] = gray;
      out[idx + 3] = a;
    }
    return out;
  };
}

/**
 * Resolves a chunk-level transformer for streaming format conversion. A pair with no transformer here is an
 * EdgeUnsupportedError (the server engine converts it): nothing is copied through, inverted or relabelled.
 */
export function resolveChunkTransformer(
  sourceFormat?: string,
  targetFormat?: string,
  options?: Record<string, any>
): ChunkTransformerFn {
  const src = (sourceFormat || '').toLowerCase();
  const tgt = (targetFormat || '').toLowerCase();

  const audio = resolveAudioStreamTransformer(src, tgt, options);
  if (audio) return audio;
  if (isStreamableDelimitedPair(src, tgt)) return createDelimitedStreamTransformer(src, tgt, options);
  if (isGrayscalePair(src, tgt)) return buildGrayscaleTransformer();
  if (isTarGzipPair(src, tgt)) return createTarGzipTransformer();
  if (isGunzipTarPair(src, tgt)) return createGunzipTarTransformer();

  throw new EdgeUnsupportedError(`Unsupported streaming transformation: ${sourceFormat} to ${targetFormat}`);
}

/**
 * Calculates number of 4MB chunks required for a given file size.
 */
export function calculateChunkCount(totalBytes: number, chunkSize: number = OPFS_CHUNK_SIZE): number {
  if (totalBytes <= 0) return 0;
  return Math.ceil(totalBytes / chunkSize);
}

/**
 * Windows a transformer is called with: one per chunk, and one empty window for an empty input so that a
 * transformer sees the end of the stream and can refuse input that is too short to be the format it claims.
 */
function transformWindowCount(totalBytes: number, chunkSize: number): number {
  return Math.max(1, calculateChunkCount(totalBytes, chunkSize));
}

function progressPercent(bytesProcessed: number, totalBytes: number): number {
  if (totalBytes <= 0) return 99;
  return Math.min(99, Math.round((bytesProcessed / totalBytes) * 95));
}

/**
 * Streaming Chunk Transformer.
 * Processes 4MB data blocks with fixed memory footprint.
 */
export class OpfsStreamTransformer {
  private readonly chunkSize: number;
  private peakAllocatedBytes: number = 0;

  constructor(chunkSize: number = OPFS_CHUNK_SIZE) {
    this.chunkSize = chunkSize;
  }

  public get peakMemoryUsage(): number {
    return this.peakAllocatedBytes;
  }

  /**
   * Transforms input chunks to output with bounded 4MB memory window.
   */
  public async transformChunked(
    totalSize: number,
    readChunkFn: (offset: number, size: number) => Promise<Uint8Array>,
    writeChunkFn: (offset: number, data: Uint8Array) => Promise<void>,
    onProgress?: (progress: number, bytesProcessed: number) => void,
    chunkTransformer?: ChunkTransformerFn
  ): Promise<number> {
    const chunkCount = transformWindowCount(totalSize, this.chunkSize);
    let bytesProcessed = 0;
    let outputOffset = 0;
    this.peakAllocatedBytes = this.chunkSize;

    for (let i = 0; i < chunkCount; i++) {
      const offset = i * this.chunkSize;
      const currentChunkSize = Math.min(this.chunkSize, totalSize - offset);

      // 1. Read bounded chunk from VFS disk handle
      const chunkData = await readChunkFn(offset, currentChunkSize);

      // 2. Perform streaming transformation and 3. write each bounded output piece to the destination
      const result = chunkTransformer ? chunkTransformer(chunkData, offset, totalSize) : chunkData;
      await forEachOutputPiece(result, async (piece) => {
        this.peakAllocatedBytes = Math.max(this.peakAllocatedBytes, piece.byteLength);
        await writeChunkFn(outputOffset, piece);
        outputOffset += piece.byteLength;
      });

      bytesProcessed += currentChunkSize;
      onProgress?.(progressPercent(bytesProcessed, totalSize), bytesProcessed);
    }

    onProgress?.(100, bytesProcessed);
    return outputOffset;
  }
}

/**
 * Synchronously streams data through OPFS FileSystemSyncAccessHandle with session isolation.
 */
export async function streamWithSyncAccessHandle(
  job: OpfsConversionJob,
  file: Blob | File,
  onProgress?: (progress: number, bytesProcessed: number) => void
): Promise<{ blob: Blob; outputSize: number }> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
    throw new Error('OPFS is not supported in this runtime environment');
  }

  const jobId = job.jobId;
  const transformer = resolveChunkTransformer(job.sourceFormat, job.targetFormat, job.options);

  const root = await navigator.storage.getDirectory();
  const easyconvertDir = await root.getDirectoryHandle('easyconvert', { create: true });
  const sessionsDir = await easyconvertDir.getDirectoryHandle('sessions', { create: true });
  const sessionDir = await sessionsDir.getDirectoryHandle(jobId, { create: true });

  const inputHandle = await sessionDir.getFileHandle('input.bin', { create: true });
  const outputHandle = await sessionDir.getFileHandle('output.bin', { create: true });

  let inputAccess: any = null;
  let outputAccess: any = null;

  try {
    inputAccess = await (inputHandle as any).createSyncAccessHandle();
    outputAccess = await (outputHandle as any).createSyncAccessHandle();

    const totalBytes = file.size;
    const chunkCount = calculateChunkCount(totalBytes, OPFS_CHUNK_SIZE);
    let bytesProcessed = 0;
    let outputOffset = 0;

    // 1. Stream input file into OPFS via bounded 4MB chunks
    for (let i = 0; i < chunkCount; i++) {
      const start = i * OPFS_CHUNK_SIZE;
      const end = Math.min(start + OPFS_CHUNK_SIZE, totalBytes);
      const sliceBlob = file.slice(start, end);
      const sliceBuf = await sliceBlob.arrayBuffer();
      inputAccess.write(new Uint8Array(sliceBuf), { at: start });
    }
    inputAccess.flush();

    // 2. Stream chunked transformation between disk handles
    const windowCount = transformWindowCount(totalBytes, OPFS_CHUNK_SIZE);
    for (let i = 0; i < windowCount; i++) {
      const start = i * OPFS_CHUNK_SIZE;
      const currentSize = Math.min(OPFS_CHUNK_SIZE, totalBytes - start);
      const readBuf = new Uint8Array(currentSize);
      inputAccess.read(readBuf, { at: start });

      await forEachOutputPiece(transformer(readBuf, start, totalBytes), (piece) => {
        outputAccess.write(piece, { at: outputOffset });
        outputOffset += piece.byteLength;
      });

      bytesProcessed += currentSize;
      onProgress?.(progressPercent(bytesProcessed, totalBytes), bytesProcessed);
    }

    if (typeof outputAccess.truncate === 'function') {
      outputAccess.truncate(outputOffset);
    }
    outputAccess.flush();
    onProgress?.(100, bytesProcessed);
  } finally {
    // Deterministic release of OS file locks
    if (inputAccess) {
      try {
        inputAccess.close();
      } catch {}
    }
    if (outputAccess) {
      try {
        outputAccess.close();
      } catch {}
    }
  }

  // Retrieve File directly backed by OPFS disk block (zero JS heap memory copy)
  const outputFile = await outputHandle.getFile();

  // Remove temporary input file to immediately reclaim disk space
  try {
    await sessionDir.removeEntry('input.bin');
  } catch {}

  return {
    blob: outputFile,
    outputSize: outputFile.size,
  };
}

/**
 * Fallback streaming chunk transformer without sync access handles.
 */
async function streamWithChunkTransformer(
  job: OpfsConversionJob,
  input: Blob | File | ArrayBuffer,
  onProgress?: (progress: number, bytesProcessed: number) => void
): Promise<{ buffer?: ArrayBuffer; blob?: Blob; outputSize: number }> {
  const isBlob = typeof Blob !== 'undefined' && input instanceof Blob;
  const totalSize = isBlob ? (input as Blob).size : (input as ArrayBuffer).byteLength;
  const transformer = new OpfsStreamTransformer(OPFS_CHUNK_SIZE);
  const chunkTransformer = resolveChunkTransformer(job.sourceFormat, job.targetFormat, job.options);

  if (isBlob) {
    const blob = input as Blob;
    const outputChunks: Uint8Array[] = [];

    await transformer.transformChunked(
      totalSize,
      async (offset, size) => {
        const slice = blob.slice(offset, offset + size);
        const buf = await slice.arrayBuffer();
        return new Uint8Array(buf);
      },
      async (_offset, data) => {
        outputChunks.push(data);
      },
      onProgress,
      chunkTransformer
    );

    const outBlob = new Blob(outputChunks as any);
    return {
      blob: outBlob,
      outputSize: outBlob.size,
    };
  }

  // ArrayBuffer fallback
  const inputBytes = new Uint8Array(input as ArrayBuffer);
  const outputChunks: Uint8Array[] = [];

  await transformer.transformChunked(
    totalSize,
    async (offset, size) => inputBytes.subarray(offset, offset + size),
    async (_offset, data) => {
      outputChunks.push(data);
    },
    onProgress,
    chunkTransformer
  );

  const totalLen = outputChunks.reduce((acc, c) => acc + c.byteLength, 0);
  const outBuffer = new ArrayBuffer(totalLen);
  const outView = new Uint8Array(outBuffer);
  let off = 0;
  for (const chunk of outputChunks) {
    outView.set(chunk, off);
    off += chunk.byteLength;
  }

  return {
    buffer: outBuffer,
    blob: new Blob([outBuffer]),
    outputSize: outBuffer.byteLength,
  };
}

/**
 * Unified executor for OPFS streaming conversions.
 */
export async function processOpfsStreaming(
  job: OpfsConversionJob,
  input: Blob | File | ArrayBuffer,
  onProgress?: (progress: number, bytesProcessed: number) => void
): Promise<{ buffer?: ArrayBuffer; blob?: Blob; outputSize: number }> {
  const hasSyncAccess =
    typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function';

  if (hasSyncAccess && (typeof Blob !== 'undefined' && input instanceof Blob)) {
    try {
      const res = await streamWithSyncAccessHandle(job, input as Blob, onProgress);
      return res;
    } catch (error) {
      // A verdict on the data or the conversion is final; only a storage failure (no sync access handle off a
      // worker thread, a full disk) falls back to the in-memory chunk transformer.
      if (error instanceof ConversionFailedError) throw error;
    }
  }

  return streamWithChunkTransformer(job, input, onProgress);
}

type WorkerPost = (message: Record<string, unknown>, transfer?: Transferable[]) => void;

/**
 * Runs one START_OPFS_STREAM request and reports through `post`: progress, the result, or the
 * error serialised with its class name so the main thread can rethrow the same typed error.
 */
export async function runOpfsWorkerJob(data: Record<string, any>, post: WorkerPost): Promise<void> {
  if (!data || data.type !== 'START_OPFS_STREAM') return;
  try {
    const inputData = data.file || data.inputBuffer;
    const result = await processOpfsStreaming(
      {
        jobId: data.jobId,
        sourceFormat: data.sourceFormat,
        targetFormat: data.targetFormat,
        totalSize: data.totalSize,
        options: data.options,
      },
      inputData,
      (progress, bytesProcessed) => {
        post({ type: 'PROGRESS', jobId: data.jobId, progress, bytesProcessed });
      }
    );

    if (result.blob) {
      post({ type: 'COMPLETED', jobId: data.jobId, outputSize: result.outputSize, blob: result.blob });
    } else if (result.buffer) {
      post({ type: 'COMPLETED', jobId: data.jobId, outputSize: result.outputSize, buffer: result.buffer }, [result.buffer]);
    } else {
      throw new ConversionFailedError('The streaming conversion finished without producing an output.');
    }
  } catch (err) {
    const error = serializeWorkerError(err);
    post({ type: 'ERROR', jobId: data.jobId, message: error.message, error });
  }
}

// Attach worker message handler
if (typeof self !== 'undefined' && typeof (self as any).postMessage === 'function' && typeof window === 'undefined') {
  self.onmessage = async (e: MessageEvent) => {
    await runOpfsWorkerJob(e.data, (message, transfer) => (self as any).postMessage(message, transfer ?? []));
  };
}
