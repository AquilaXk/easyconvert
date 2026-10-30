import type { WorkerEngineOptions, WorkerVfsPayload } from '@/worker/worker-types';

/** Schema keyword listing the keys an object of a request must not carry: the options only server code sets. */
export const SERVER_ONLY_KEYWORD = 'x-easyconvert-server-only';

/** Reason named in `invalidParams` for a key the request may not set. */
export const SERVER_ONLY_REASON = 'server_only_option';

/**
 * Option keys that only server code sets: where the worker reads its input or writes its output (the worker payload
 * fields), the worker's own limits and routing, and the switch that keeps a source away from FFmpeg. A request that
 * carries one is refused, never silently stripped.
 */
export const SERVER_ONLY_OPTION_KEYS = [
  'outputPath',
  'inputPath',
  'inputBuffer',
  'archiveParts',
  'zeroHeap',
  'maxBufferBytes',
  'throwOnUnavailable',
  'inProcessFallback',
  'pdfExportPageRange',
  'maxRenderedPages',
  'disableNativeEngine',
  'uncompressedWorkbook',
] as const satisfies readonly (keyof WorkerEngineOptions | keyof WorkerVfsPayload)[];
