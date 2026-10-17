import type { ConversionOptions, ConversionResult } from '../lib/types';

/** What a worker conversion takes and returns. Kept apart from the engines so the modules they call can name them. */

export interface WorkerVfsPayload {
  inputPath?: string;
  outputPath?: string;
  inputBuffer?: Buffer;
}


export interface WorkerEngineOptions extends ConversionOptions {
  timeoutMs?: number;
  maxBufferBytes?: number;
  page?: number;
  dpi?: number;
  zeroHeap?: boolean;
  signal?: AbortSignal;
  throwOnUnavailable?: boolean;
  /**
   * When false, a pair that no available native engine converted fails instead of falling back
   * to the in-process engine: the last EngineUnavailableError is rethrown, or an
   * UnsupportedTargetError when no native route handles the pair at all.
   */
  inProcessFallback?: boolean;
  /**
   * Pages of the printed document the office suite writes into the PDF of a chain (its range syntax, `1`). Set by the worker
   * for a spreadsheet that becomes the first page image; the request schema has no such field.
   */
  pdfExportPageRange?: string;
  /**
   * Most pages the worker renders to page images for this request; a larger selection is refused (413). Set by the worker for
   * the sources whose page count a request cannot predict; the request schema has no such field.
   */
  maxRenderedPages?: number;
}

export interface WorkerConversionResult extends ConversionResult {
  engineUsed: 'native-soffice' | 'native-soffice-pool' | 'native-ffmpeg' | 'native-7z' | 'native-poppler' | 'native-postscript' | 'native-svg' | 'native-raw' | 'in-process-raw' | 'internal-fallback';
  executionTimeMs: number;
  filePath?: string;
  metadata?: Record<string, unknown>;
  fallbackReason?: string;
  fallbackChain?: string[];
}
