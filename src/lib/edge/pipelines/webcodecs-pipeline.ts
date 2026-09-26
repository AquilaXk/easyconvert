/**
 * WebCodecs Hardware Media Pipeline Controller (Level 1 - L1)
 *
 * Coordinates execution between the main application thread and the WebCodecs Worker:
 * - Direct zero-copy transfer of input ArrayBuffer.
 * - Telemetry streaming (progress 0% -> 100%).
 * - Fail-closed error propagation.
 * - Deterministic cleanup of object URLs.
 */

import { ConversionOptions } from '../../types';
import { checkWebCodecsSupport } from '../tier-router';
import { processWebCodecsConversion } from '../workers/webcodecs.worker';

export interface WebCodecsPipelineResult {
  blob: Blob;
  url: string;
  size: number;
  mimeType: string;
}

/**
 * Checks whether current client runtime has WebCodecs hardware media support.
 */
export async function isWebCodecsEligible(targetFormat: string): Promise<boolean> {
  const caps = await checkWebCodecsSupport();
  const tgt = targetFormat.toLowerCase();
  const isVideo = ['mp4', 'webm', 'mov'].includes(tgt);
  const isAudio = ['m4a', 'aac', 'opus'].includes(tgt);

  if (isVideo) return caps.video;
  if (isAudio) return caps.audio;
  return caps.video || caps.audio;
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
  const jobId = `webcodecs-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  const arrayBuffer = await file.arrayBuffer();

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
          {
            jobId,
            sourceFormat,
            targetFormat,
            fileBuffer: arrayBuffer,
            options: {
              width: options.width,
              height: options.height,
              videoBitrate: options.videoBitrate,
              audioBitrate: options.audioBitrate ? parseInt(options.audioBitrate, 10) * 1000 : undefined,
              audioSampleRate: options.audioSampleRate,
              audioChannels: options.audioChannels === 'mono' ? 1 : 2,
              codec: options.videoCodec,
            },
          },
          onProgress
        )
          .then((res) => {
            const blob = new Blob([res.buffer], { type: res.mimeType });
            const url = URL.createObjectURL(blob);
            resolve({ blob, url, size: blob.size, mimeType: res.mimeType });
          })
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
        if (!data || data.jobId !== jobId) return;

        if (data.type === 'PROGRESS') {
          onProgress?.(data.progress);
        } else if (data.type === 'COMPLETED') {
          if (isSettled) return;
          isSettled = true;
          const blob = new Blob([data.buffer], { type: data.mimeType });
          const url = URL.createObjectURL(blob);
          cleanup();
          resolve({ blob, url, size: blob.size, mimeType: data.mimeType });
        } else if (data.type === 'ERROR') {
          if (isSettled) return;
          isSettled = true;
          cleanup();
          reject(new Error(data.message || 'WebCodecs conversion pipeline error'));
        }
      };

      worker.onerror = (err) => {
        if (isSettled) return;
        isSettled = true;
        cleanup();
        reject(new Error(err.message || 'WebCodecs worker runtime error'));
      };

      // Transfer fileBuffer to worker to avoid memory duplication
      worker.postMessage(
        {
          type: 'START_CONVERSION',
          jobId,
          sourceFormat,
          targetFormat,
          fileBuffer: arrayBuffer,
          options: {
            width: options.width,
            height: options.height,
            videoBitrate: options.videoBitrate,
            audioBitrate: options.audioBitrate ? parseInt(options.audioBitrate, 10) * 1000 : undefined,
            audioSampleRate: options.audioSampleRate,
            audioChannels: options.audioChannels === 'mono' ? 1 : 2,
            codec: options.videoCodec,
          },
        },
        [arrayBuffer]
      );
    });
  }

  // Node.js or Test environment fallback
  const result = await processWebCodecsConversion(
    {
      jobId,
      sourceFormat,
      targetFormat,
      fileBuffer: arrayBuffer,
      options: {
        width: options.width,
        height: options.height,
        videoBitrate: options.videoBitrate,
        audioBitrate: options.audioBitrate ? parseInt(options.audioBitrate, 10) * 1000 : undefined,
        audioSampleRate: options.audioSampleRate,
        audioChannels: options.audioChannels === 'mono' ? 1 : 2,
        codec: options.videoCodec,
      },
    },
    onProgress
  );

  const blob = new Blob([result.buffer], { type: result.mimeType });
  const url = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
    ? URL.createObjectURL(blob)
    : `blob:mock-edge-url-${Date.now()}`;

  return {
    blob,
    url,
    size: blob.size,
    mimeType: result.mimeType,
  };
}
