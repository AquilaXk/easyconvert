import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { cleanupDirectoryTree } from '../lib/conversions/archive-extraction-safety';
import { MAX_DOCUMENT_INFLATE_BYTES } from '../lib/conversions/bounded-inflate';
import { getFormatByExtension } from '../lib/registry';
import { PayloadTooLargeForMemoryError, getMaxInMemoryBytes } from '../lib/storage/errors';
import { readPersistedOutput } from './persisted-output';
import { PayloadLimitError, type ConversionResult } from '../lib/types';
import type { WorkerConversionResult, WorkerEngineOptions, WorkerVfsPayload } from './worker-types';

/**
 * The files a worker conversion reads and writes: its job directory, the input on disk, and the output handed to its
 * destination. Every native route shares them; they know nothing of the engines that use them.
 */

/**
 * Scoped sandbox directory runner with automated cleanup and error encapsulation.
 */
export async function withSandboxDir<T>(
  prefix: string,
  operation: (tempDir: string) => Promise<T>
): Promise<T> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return await operation(tempDir);
  } finally {
    cleanupDirectoryTree(tempDir);
  }
}

/**
 * The most bytes of drawn PDF that an image target reads into memory for the PDF tools, which take a buffer: half the
 * inflate budget of a document, since the parts of the source (XPS) are held at the same time. A PDF target hands the file on
 * by its path and is bound by the output limit of the program only.
 */
export const MAX_DRAWN_PDF_BYTES_FOR_IMAGES = MAX_DOCUMENT_INFLATE_BYTES / 2;

/** The refusal for a PDF that `program` drew from a `src` file and that is larger than the `limit` bytes that can be taken further. */
export function drawnPdfTooLargeError(program: string, src: string, size: number, limit: number): PayloadLimitError {
  return new PayloadLimitError(`${program} drew ${size} bytes of PDF from the .${src} file, more than the ${limit} bytes that can be taken further.`);
}

/** The PDF a program drew, read whole for an image target; a file above MAX_DRAWN_PDF_BYTES_FOR_IMAGES is refused before it is read. */
export function readDrawnPdfForImages(pdfPath: string, program: string, src: string): Buffer {
  const size = fs.statSync(pdfPath).size;
  if (size > MAX_DRAWN_PDF_BYTES_FOR_IMAGES) throw drawnPdfTooLargeError(program, src, size, MAX_DRAWN_PDF_BYTES_FOR_IMAGES);
  return fs.readFileSync(pdfPath);
}

/** Reads the whole input into memory, within the in-memory payload limit. */
export function readRawInputBuffer(input: Buffer | WorkerVfsPayload): Buffer {
  if (Buffer.isBuffer(input)) return input;
  if (input.inputBuffer) return input.inputBuffer;
  if (input.inputPath && fs.existsSync(input.inputPath)) {
    const size = fs.statSync(input.inputPath).size;
    if (size > getMaxInMemoryBytes()) {
      throw new PayloadTooLargeForMemoryError(
        `Payload size (${size} bytes) exceeds in-memory buffer limit of ${getMaxInMemoryBytes()} bytes. Native worker required.`,
        { size, limit: getMaxInMemoryBytes() }
      );
    }
    return fs.readFileSync(input.inputPath);
  }
  throw new Error('Worker conversion received invalid input payload: neither inputPath nor inputBuffer provided');
}

/**
 * Resolves disk input path and ownership from Buffer or WorkerVfsPayload.
 */
export function resolveInputContext(
  input: Buffer | WorkerVfsPayload,
  ext: string,
  tempDir: string
): { inputPath: string; isTemporary: boolean } {
  if (Buffer.isBuffer(input)) {
    const p = path.join(tempDir, `input.${ext}`);
    fs.writeFileSync(p, input);
    return { inputPath: p, isTemporary: true };
  }
  if (typeof input === 'object' && input !== null) {
    if (input.inputPath && fs.existsSync(input.inputPath)) {
      return { inputPath: input.inputPath, isTemporary: false };
    }
    if (input.inputBuffer) {
      const p = path.join(tempDir, `input.${ext}`);
      fs.writeFileSync(p, input.inputBuffer);
      return { inputPath: p, isTemporary: true };
    }
  }
  throw new Error('Worker conversion received invalid input payload: neither inputPath nor inputBuffer provided');
}

/**
 * Persists an output file to target VFS destination outside ephemeral sandbox before cleanup.
 */
function resolveOutputPath(targetFormat: string, options?: WorkerEngineOptions, vfsPayload?: WorkerVfsPayload): string {
  const desiredOutput = vfsPayload?.outputPath || (options as { outputPath?: string } | undefined)?.outputPath;
  if (desiredOutput) return desiredOutput;
  const vfsDir = path.join(os.tmpdir(), 'easyconvert-vfs');
  if (!fs.existsSync(vfsDir)) {
    try {
      fs.mkdirSync(vfsDir, { recursive: true, mode: 0o700 });
    } catch {}
  }
  return path.join(vfsDir, `easyconvert-out-${crypto.randomUUID()}.${targetFormat}`);
}

/**
 * Where the in-process engine's output is written: the destination the request named, a file of the worker's own naming when the
 * heap must stay empty (`zeroHeap`), and otherwise nowhere, as the output stays in memory.
 */
export function inProcessOutputPath(targetFormat: string, options: WorkerEngineOptions, vfsPayload?: WorkerVfsPayload): string | undefined {
  const named = vfsPayload?.outputPath || (options as { outputPath?: string }).outputPath;
  return named || (options.zeroHeap ? resolveOutputPath(targetFormat, options, vfsPayload) : undefined);
}

/** Why a conversion left the native engines for the in-process one, and the engines it passed on the way. */
interface InProcessFallback {
  reason?: string;
  chain: readonly string[];
}

/** The in-process engine's result as the worker hands it out, written to `outputPath` when there is one. */
export function internalFallbackResult(
  internalRes: ConversionResult,
  outputPath: string | undefined,
  startTime: number,
  fallback: InProcessFallback
): WorkerConversionResult {
  if (outputPath) fs.writeFileSync(outputPath, internalRes.buffer);
  return {
    ...internalRes,
    ...(outputPath ? { filePath: outputPath } : {}),
    engineUsed: 'internal-fallback',
    executionTimeMs: Date.now() - startTime,
    metadata: { ...internalRes.metadata, ...(fallback.reason ? { fallbackReason: fallback.reason } : {}) },
    fallbackReason: fallback.reason,
    fallbackChain: fallback.chain.length > 0 ? [...fallback.chain] : undefined,
  };
}

export function preserveOutput(
  tempOutputPath: string,
  targetFormat: string,
  options?: WorkerEngineOptions,
  vfsPayload?: WorkerVfsPayload
): string {
  const finalPath = resolveOutputPath(targetFormat, options, vfsPayload);
  fs.copyFileSync(tempOutputPath, finalPath);
  return finalPath;
}

/**
 * Hands the finished output of a job to its destination and leaves nothing of it in the job directory. An output
 * nobody named a place for goes to a file of the worker's own naming, and the job directory is on the same volume as
 * that file in all but unusual setups, so the file is renamed into place and its bytes are not written a second time;
 * across volumes, or when the caller named the destination (which may be a link or a mount of its own), it is copied.
 */
export function handOffOutput(
  tempOutputPath: string,
  targetFormat: string,
  options?: WorkerEngineOptions,
  vfsPayload?: WorkerVfsPayload
): string {
  const named = vfsPayload?.outputPath || (options as { outputPath?: string } | undefined)?.outputPath;
  if (named) return preserveOutput(tempOutputPath, targetFormat, options, vfsPayload);
  const finalPath = resolveOutputPath(targetFormat, options, vfsPayload);
  try {
    fs.renameSync(tempOutputPath, finalPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    fs.copyFileSync(tempOutputPath, finalPath);
  }
  return finalPath;
}

/**
 * Writes `pending` to the descriptor's position with `writev`, and again for what a call left, until none is left. One
 * call takes any number of buffers, since libuv splits the vector per system call (`IOV_MAX`). It can still return a
 * total below the sum: when a later chunk of the vector fails, libuv returns the bytes of the chunks that finished, and
 * the call that follows raises that failure.
 */
function writeVectored(fd: number, pending: readonly Uint8Array[]): void {
  let rest = pending;
  while (rest.length > 0) {
    const total = fs.writevSync(fd, rest);
    let written = total;
    let skipped = 0;
    while (skipped < rest.length && written >= rest[skipped].byteLength) written -= rest[skipped++].byteLength;
    const next = rest.slice(skipped);
    if (total === 0 && next.length > 0) throw new Error('The output file accepted no bytes of the write.');
    if (written > 0) next[0] = next[0].subarray(written);
    rest = next;
  }
}

/**
 * Writes an output that is already in memory as byte ranges straight to its destination, without a temporary copy, in one
 * `writev` for the whole list (a tar of 2,000 members is 6,001 ranges), and a short write continues where it stopped.
 */
export function writeOutputSegments(
  segments: readonly Uint8Array[],
  targetFormat: string,
  options?: WorkerEngineOptions,
  vfsPayload?: WorkerVfsPayload
): string {
  const finalPath = resolveOutputPath(targetFormat, options, vfsPayload);
  const fd = fs.openSync(finalPath, 'w');
  try {
    writeVectored(fd, segments);
  } finally {
    fs.closeSync(fd);
  }
  return finalPath;
}

/** The pages each rendered result holds, kept beside the result so that they never reach a client with it. */
const renderedPageNumbers = new WeakMap<WorkerConversionResult, readonly number[]>();

/** The result, recording which pages its files hold (one file, or the ZIP entries in page order). */
export function withPageNumbers(result: WorkerConversionResult, pageNumbers: readonly number[]): WorkerConversionResult {
  renderedPageNumbers.set(result, [...pageNumbers]);
  return result;
}

/** The pages a rendered result holds (see `withPageNumbers`), or none when they were not recorded. */
export function pageNumbersOf(result: WorkerConversionResult): readonly number[] {
  return renderedPageNumbers.get(result) ?? [];
}

/**
 * Creates lazy zero-heap WorkerConversionResult supporting 2GB+ payloads without heap overflow.
 */
export function createConversionResult(
  persistedFilePath: string,
  targetFormat: string,
  baseName: string,
  engineUsed: WorkerConversionResult['engineUsed'],
  executionTimeMs: number
): WorkerConversionResult {
  const stat = fs.statSync(persistedFilePath);
  let cachedBuffer: Buffer | null = null;
  return {
    filePath: persistedFilePath,
    mimeType: getMimeType(targetFormat),
    filename: `${baseName}.${targetFormat}`,
    size: stat.size,
    engineUsed,
    executionTimeMs,
    get buffer(): Buffer {
      cachedBuffer ??= readPersistedOutput(persistedFilePath, stat.size);
      return cachedBuffer;
    },
    set buffer(b: Buffer) {
      cachedBuffer = b;
    },
  };
}

export function getMimeType(format: string): string {
  const cleanFormat = format.toLowerCase().trim();
  const regDef = getFormatByExtension(cleanFormat);
  if (regDef?.mimeType) {
    return regDef.mimeType;
  }

  const map: Record<string, string> = {
    pdf: 'application/pdf',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    zip: 'application/zip',
    '7z': 'application/x-7z-compressed',
    tar: 'application/x-tar',
    gz: 'application/gzip',
    tgz: 'application/gzip',
    bz2: 'application/x-bzip2',
    tbz2: 'application/x-bzip-compressed-tar',
    xz: 'application/x-xz',
    txz: 'application/x-xz',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    tiff: 'image/tiff',
    ppm: 'image/x-portable-pixmap',
    svg: 'image/svg+xml',
    txt: 'text/plain',
  };
  return map[cleanFormat] || 'application/octet-stream';
}
