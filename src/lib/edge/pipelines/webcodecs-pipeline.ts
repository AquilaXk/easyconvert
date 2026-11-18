/**
 * WebCodecs Hardware Media Pipeline Controller (Level 1 - L1)
 *
 * Coordinates execution between the main application thread and the WebCodecs Worker:
 * - Direct zero-copy transfer of input ArrayBuffer.
 * - Telemetry streaming (progress 0% -> 100%).
 * - Fail-closed error propagation: the worker's typed errors keep their class across the boundary, so an
 *   EdgeUnsupportedError reaches the tier router, which runs the server tier.
 * - Deterministic cleanup of object URLs.
 */

import { ConversionOptions } from '../../types';
import { checkWebCodecsSupport, EDGE_VIDEO_TARGET_FORMATS } from '../tier-router';
import { processWebCodecsConversion } from '../workers/webcodecs.worker';
import { EdgeUnsupportedError, rehydrateWorkerError } from '../workers/worker-errors';
import { toWorkerOptions } from './webcodecs-options';

export interface WebCodecsPipelineResult {
  blob: Blob;
  url: string;
  size: number;
  mimeType: string;
}

const AUDIO_TARGET_FORMATS: ReadonlySet<string> = new Set(['m4a', 'aac', 'opus']);

/**
 * Checks whether current client runtime has WebCodecs hardware media support.
 */
export async function isWebCodecsEligible(targetFormat: string): Promise<boolean> {
  const caps = await checkWebCodecsSupport();
  const tgt = targetFormat.toLowerCase();

  if (EDGE_VIDEO_TARGET_FORMATS.has(tgt)) return caps.video;
  if (AUDIO_TARGET_FORMATS.has(tgt)) return caps.audio;
  return caps.video || caps.audio;
}

function toPipelineResult(buffer: ArrayBuffer, mimeType: string): WebCodecsPipelineResult {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new EdgeUnsupportedError('This runtime cannot hand out a result URL for the converted media.');
  }
  const blob = new Blob([buffer], { type: mimeType });
  return { blob, url: URL.createObjectURL(blob), size: blob.size, mimeType };
}

function abortErrorOf(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException(typeof reason === 'string' && reason ? reason : 'WebCodecs conversion aborted', 'AbortError');
}

/**
 * Executes a hardware-accelerated media conversion using WebCodecs worker.
 */
export async function convertWithWebCodecs(
  file: File | Blob,
  sourceFormat: string,
  targetFormat: string,
  options: ConversionOptions = {},
  onProgress?: (progress: number) => void,
  signal?: AbortSignal
): Promise<WebCodecsPipelineResult> {
  if (signal?.aborted) throw abortErrorOf(signal);
  const jobId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? `webcodecs-${crypto.randomUUID()}`
      : `webcodecs-${Date.now()}`;
  const workerOptions = toWorkerOptions(options);

  onProgress?.(5);

  // If in browser environment with Worker support
  if (typeof window !== 'undefined' && typeof Worker !== 'undefined') {
    return new Promise<WebCodecsPipelineResult>((resolve, reject) => {
      let worker: Worker | null = null;
      let isSettled = false;

      const onAbort = () => {
        if (isSettled) return;
        isSettled = true;
        cleanup();
        reject(signal ? abortErrorOf(signal) : new DOMException('WebCodecs conversion aborted', 'AbortError'));
      };

      const cleanup = () => {
        if (signal) signal.removeEventListener('abort', onAbort);
        if (worker) {
          worker.terminate();
          worker = null;
        }
      };

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      try {
        // Instantiate Web Worker using Next.js / Webpack worker standard URL
        worker = new Worker(
          new URL('../workers/webcodecs.worker.ts', import.meta.url),
          { type: 'module' }
        );
      } catch {
        if (signal) signal.removeEventListener('abort', onAbort);
        // If worker instantiation fails (e.g., test environment), fallback to in-process execution
        file
          .arrayBuffer()
          .then((arrayBuffer) =>
            processWebCodecsConversion(
              { jobId, sourceFormat, targetFormat, fileBuffer: arrayBuffer, options: workerOptions },
              onProgress
            )
          )
          .then((res) => {
            if (signal?.aborted) {
              reject(abortErrorOf(signal));
              return;
            }
            resolve(toPipelineResult(res.buffer, res.mimeType));
          })
          .catch(reject);
        return;
      }

      worker.onmessage = (e: MessageEvent) => {
        const data = e.data;
        if (data?.jobId !== jobId) return;

        if (data.type === 'PROGRESS') {
          onProgress?.(data.progress);
        } else if (data.type === 'COMPLETED') {
          if (isSettled) return;
          isSettled = true;
          cleanup();
          try {
            resolve(toPipelineResult(data.buffer, data.mimeType));
          } catch (err) {
            reject(err);
          }
        } else if (data.type === 'ERROR') {
          if (isSettled) return;
          isSettled = true;
          cleanup();
          // The typed error crosses the boundary as data; rebuild its class so the router can act on it.
          reject(rehydrateWorkerError(data.error ?? { message: data.message || 'WebCodecs conversion pipeline error' }));
        }
      };

      worker.onerror = (err) => {
        if (isSettled) return;
        isSettled = true;
        cleanup();
        reject(new Error(err.message || 'WebCodecs worker runtime error'));
      };

      // Pass File/Blob handle directly via structured clone so the UI thread allocates zero extra ArrayBuffer copies
      worker.postMessage({
        type: 'START_CONVERSION',
        jobId,
        sourceFormat,
        targetFormat,
        file,
        options: workerOptions,
      });
    });
  }

  // Node.js or Test environment fallback
  const arrayBuffer = await file.arrayBuffer();
  if (signal?.aborted) throw abortErrorOf(signal);
  const result = await processWebCodecsConversion(
    { jobId, sourceFormat, targetFormat, fileBuffer: arrayBuffer, options: workerOptions },
    onProgress
  );
  if (signal?.aborted) throw abortErrorOf(signal);
  return toPipelineResult(result.buffer, result.mimeType);
}
