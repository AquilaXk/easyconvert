/**
 * OPFS Streaming Pipeline Controller (Level 3 - L3)
 *
 * Coordinates execution of large file (> 100MB ~ 2GB) conversions via OPFS:
 * - Session directory isolation under /easyconvert/sessions/${jobId}/.
 * - 4MB chunked streaming between disk handles.
 * - Peak JS heap usage bounded under 50MB (streaming directly from File/Blob references).
 * - Automated post-conversion cleanup.
 */

import { ConversionFailedError, ConversionOptions } from '../../types';
import {
  createSessionId,
  sweepOrphanedSessions,
  destroySessionImmediately,
  registerZeroRetentionLifecycleHooks,
} from '../opfs/storage-gc';
import { processOpfsStreaming } from '../workers/opfs-vfs.worker';
import { EdgeUnsupportedError, rehydrateWorkerError } from '../workers/worker-errors';

export interface OpfsPipelineResult {
  blob: Blob;
  url: string;
  size: number;
  sessionId: string;
  destroy: () => Promise<boolean>;
}

/** The converted bytes of a worker result; a result with no bytes is a failure, never the input file. */
function outputBlobOf(output: { blob?: Blob; buffer?: ArrayBuffer }): Blob {
  if (output.blob) return output.blob;
  if (output.buffer) return new Blob([output.buffer]);
  throw new ConversionFailedError('The streaming conversion finished without producing an output.');
}

/** An object URL for the converted bytes; a runtime that cannot make one cannot hand the result over. */
function resultUrlOf(blob: Blob): string {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new EdgeUnsupportedError('This runtime cannot hand out a result URL for the converted file.');
  }
  return URL.createObjectURL(blob);
}

// Active OPFS conversion session registry for zero-retention guarantee
const activePipelineSessions = new Set<string>();
if (typeof window !== 'undefined' || typeof self !== 'undefined') {
  registerZeroRetentionLifecycleHooks(activePipelineSessions);
}

/**
 * Executes high-volume large-file conversion via OPFS VFS streaming.
 * Passes File/Blob handles directly without loading full 1GB+ buffers into JS heap.
 */
export async function streamConvertWithOpfs(
  file: File | Blob,
  sourceFormat: string,
  targetFormat: string,
  options: ConversionOptions = {},
  onProgress?: (progress: number) => void
): Promise<OpfsPipelineResult> {
  const sessionId = createSessionId();
  const totalSize = file.size;
  activePipelineSessions.add(sessionId);

  onProgress?.(5);

  // Trigger opportunistic storage GC in background to keep disk clean
  sweepOrphanedSessions().catch(() => {});

  const createDestroyHandler = (sid: string) => async () => {
    activePipelineSessions.delete(sid);
    return destroySessionImmediately(sid);
  };

  // Browser environment with Worker support
  if (typeof window !== 'undefined' && typeof Worker !== 'undefined') {
    return new Promise<OpfsPipelineResult>((resolve, reject) => {
      let worker: Worker | null = null;
      let isSettled = false;

      try {
        worker = new Worker(
          new URL('../workers/opfs-vfs.worker.ts', import.meta.url),
          { type: 'module' }
        );
      } catch {
        // Fallback to in-process execution on worker instantiation fault
        processOpfsStreaming(
          {
            jobId: sessionId,
            sourceFormat,
            targetFormat,
            totalSize,
            options,
          },
          file,
          (progress) => onProgress?.(progress)
        )
          .then((res) => {
            const blob = outputBlobOf(res);
            const url = resultUrlOf(blob);
            resolve({
              blob,
              url,
              size: blob.size,
              sessionId,
              destroy: createDestroyHandler(sessionId),
            });
          })
          .catch((err) => {
            activePipelineSessions.delete(sessionId);
            destroySessionImmediately(sessionId).catch(() => {});
            reject(err);
          });
        return;
      }

      const cleanup = () => {
        if (worker) {
          worker.terminate();
          worker = null;
        }
      };

      worker.onmessage = (e: MessageEvent) => {
        const data = e.data;
        if (data?.jobId !== sessionId) return;

        if (data.type === 'PROGRESS') {
          onProgress?.(data.progress);
        } else if (data.type === 'COMPLETED') {
          if (isSettled) return;
          isSettled = true;
          cleanup();
          try {
            const blob = outputBlobOf(data);
            resolve({
              blob,
              url: resultUrlOf(blob),
              size: blob.size,
              sessionId,
              destroy: createDestroyHandler(sessionId),
            });
          } catch (err) {
            activePipelineSessions.delete(sessionId);
            destroySessionImmediately(sessionId).catch(() => {});
            reject(err);
          }
        } else if (data.type === 'ERROR') {
          if (isSettled) return;
          isSettled = true;
          cleanup();
          activePipelineSessions.delete(sessionId);
          destroySessionImmediately(sessionId).catch(() => {});
          // Rebuild the worker's typed error (DataEncodingError, DataParseError, ...) from its data.
          reject(rehydrateWorkerError(data.error ?? { name: 'Error', message: data.message || 'OPFS streaming conversion failed' }));
        }
      };

      worker.onerror = (err) => {
        if (isSettled) return;
        isSettled = true;
        cleanup();
        activePipelineSessions.delete(sessionId);
        destroySessionImmediately(sessionId).catch(() => {});
        reject(new Error(err.message || 'OPFS worker execution fault'));
      };

      // Pass File/Blob directly via structured clone (no main thread RAM memory copy)
      worker.postMessage({
        type: 'START_OPFS_STREAM',
        jobId: sessionId,
        sourceFormat,
        targetFormat,
        totalSize,
        options,
        file,
      });
    });
  }

  // Node.js or Test environment fallback
  try {
    const result = await processOpfsStreaming(
      {
        jobId: sessionId,
        sourceFormat,
        targetFormat,
        totalSize,
        options,
      },
      file,
      (progress) => onProgress?.(progress)
    );

    const blob = outputBlobOf(result);
    const url = resultUrlOf(blob);

    return {
      blob,
      url,
      size: blob.size,
      sessionId,
      destroy: createDestroyHandler(sessionId),
    };
  } catch (err) {
    activePipelineSessions.delete(sessionId);
    destroySessionImmediately(sessionId).catch(() => {});
    throw err;
  }
}
