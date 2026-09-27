/**
 * OPFS Streaming Pipeline Controller (Level 3 - L3)
 *
 * Coordinates execution of large file (> 100MB ~ 2GB) conversions via OPFS:
 * - Session directory isolation under /easyconvert/sessions/${jobId}/.
 * - 4MB chunked streaming between disk handles.
 * - Peak JS heap usage bounded under 50MB (streaming directly from File/Blob references).
 * - Automated post-conversion cleanup.
 */

import { ConversionOptions } from '../../types';
import {
  createSessionId,
  sweepOrphanedSessions,
  destroySessionImmediately,
  registerZeroRetentionLifecycleHooks,
} from '../opfs/storage-gc';
import { processOpfsStreaming } from '../workers/opfs-vfs.worker';

export interface OpfsPipelineResult {
  blob: Blob;
  url: string;
  size: number;
  sessionId: string;
  destroy: () => Promise<boolean>;
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
            const blob = res.blob || (res.buffer ? new Blob([res.buffer]) : file);
            const url = URL.createObjectURL(blob);
            resolve({
              blob,
              url,
              size: res.outputSize || blob.size,
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
          const blob = data.blob || (data.buffer ? new Blob([data.buffer]) : file);
          const url = URL.createObjectURL(blob);
          cleanup();
          resolve({
            blob,
            url,
            size: data.outputSize || blob.size,
            sessionId,
            destroy: createDestroyHandler(sessionId),
          });
        } else if (data.type === 'ERROR') {
          if (isSettled) return;
          isSettled = true;
          cleanup();
          activePipelineSessions.delete(sessionId);
          destroySessionImmediately(sessionId).catch(() => {});
          reject(new Error(data.message || 'OPFS streaming conversion failed'));
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

    const blob = result.blob || (result.buffer ? new Blob([result.buffer]) : file);
    const url =
      typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
        ? URL.createObjectURL(blob)
        : `blob:mock-opfs-url-${Date.now()}`;

    return {
      blob,
      url,
      size: result.outputSize || blob.size,
      sessionId,
      destroy: createDestroyHandler(sessionId),
    };
  } catch (err) {
    activePipelineSessions.delete(sessionId);
    destroySessionImmediately(sessionId).catch(() => {});
    throw err;
  }
}
