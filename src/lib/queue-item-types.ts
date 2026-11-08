import type { ConversionFailure } from './conversion-failure';
import type { ConversionOptions } from './types';

/** The files a visitor queues in the browser converter: their state and result, kept apart from the conversion types the server uses. */
export type QueueItemStatus =
  | 'ready'
  | 'uploading'
  | 'converting'
  | 'completed'
  | 'error';

export interface ConversionQueueItem {
  id: string;
  file: File;
  name: string;
  size: number;
  sourceFormat: string;
  targetFormat: string;
  status: QueueItemStatus;
  /** Percent done as a stage measured it; absent while the running stage has no measure (one request to the server). */
  progress?: number;
  resultUrl?: string;
  resultSize?: number;
  error?: ConversionFailure;
  options: ConversionOptions;
  edgeProcessed?: boolean;
  edgeTier?: string;
  unchanged?: boolean; // the result is the input itself: compressing did not make it smaller
}
