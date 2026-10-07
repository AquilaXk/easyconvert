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
import { processWebCodecsConversion, type WebCodecsConversionRequest } from '../workers/webcodecs.worker';
import { EdgeUnsupportedError, rehydrateWorkerError } from '../workers/worker-errors';

export interface WebCodecsPipelineResult {
  blob: Blob;
  url: string;
  size: number;
  mimeType: string;
}

const KBPS = 1000;
const MONO_CHANNELS = 1;
const STEREO_CHANNELS = 2;
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

/**
 * Channel count a request names. Only mono and stereo are channel counts the edge can state; a request that
 * names nothing leaves the count to the source audio, and any other layout is not expressible here.
 */
function requestedAudioChannels(channels: ConversionOptions['audioChannels']): number | undefined {
  if (channels === undefined) return undefined;
  if (channels === 'mono') return MONO_CHANNELS;
  if (channels === 'stereo') return STEREO_CHANNELS;
  throw new EdgeUnsupportedError(`The edge worker cannot write ${channels} audio.`);
}

function toWorkerOptions(options: ConversionOptions): WebCodecsConversionRequest['options'] {
  return {
    width: options.width,
    height: options.height,
    videoBitrate: options.videoBitrate,
    audioBitrate: options.audioBitrate ? Number.parseInt(options.audioBitrate, 10) * KBPS : undefined,
    audioSampleRate: options.audioSampleRate,
    audioChannels: requestedAudioChannels(options.audioChannels),
    codec: options.videoCodec,
  };
}

function toPipelineResult(buffer: ArrayBuffer, mimeType: string): WebCodecsPipelineResult {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new EdgeUnsupportedError('This runtime cannot hand out a result URL for the converted media.');
  }
  const blob = new Blob([buffer], { type: mimeType });
  return { blob, url: URL.createObjectURL(blob), size: blob.size, mimeType };
}

/**
 * Executes a hardware-accelerated media conversion using WebCodecs worker.
 */
export async function convertWithWebCodecs(
  file: File | Blob,
  sourceFormat: string,
  targetFormat: string,
  options: ConversionOptions = {},
  onProgress?: (progress: number) => void
): Promise<WebCodecsPipelineResult> {
  const jobId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? `webcodecs-${crypto.randomUUID()}`
      : `webcodecs-${Date.now()}`;
  const arrayBuffer = await file.arrayBuffer();
  const workerOptions = toWorkerOptions(options);

  onProgress?.(5);

  // If in browser environment with Worker support
  if (typeof window !== 'undefined' && typeof Worker !== 'undefined') {
    return new Promise<WebCodecsPipelineResult>((resolve, reject) => {
      let worker: Worker | null = null;
      let isSettled = false;

      try {
        // Instantiate Web Worker using Next.js / Webpack worker standard URL
        worker = new Worker(
          new URL('../workers/webcodecs.worker.ts', import.meta.url),
          { type: 'module' }
        );
      } catch {
        // If worker instantiation fails (e.g., test environment), fallback to in-process execution
        processWebCodecsConversion(
          { jobId, sourceFormat, targetFormat, fileBuffer: arrayBuffer, options: workerOptions },
          onProgress
        )
          .then((res) => resolve(toPipelineResult(res.buffer, res.mimeType)))
          .catch(reject);
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

      // Transfer sliced copy to worker to preserve arrayBuffer on main thread for cascade fallback
      const transferBuffer = arrayBuffer.slice(0);
      worker.postMessage(
        {
          type: 'START_CONVERSION',
          jobId,
          sourceFormat,
          targetFormat,
          fileBuffer: transferBuffer,
          options: workerOptions,
        },
        [transferBuffer]
      );
    });
  }

  // Node.js or Test environment fallback
  const result = await processWebCodecsConversion(
    { jobId, sourceFormat, targetFormat, fileBuffer: arrayBuffer.slice(0), options: workerOptions },
    onProgress
  );
  return toPipelineResult(result.buffer, result.mimeType);
}
