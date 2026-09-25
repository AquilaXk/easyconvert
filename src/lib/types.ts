export type FormatCategory =
  | 'image'
  | 'document'
  | 'data'
  | 'archive'
  | 'audio'
  | 'video'
  | 'ebook';

export interface FormatOptionsSchema {
  quality?: boolean;
  dimensions?: boolean;
  fit?: boolean;
  stripMetadata?: boolean;
  dpi?: boolean;
  orientation?: boolean;
  delimiter?: boolean;
  compressionLevel?: boolean;
}

export interface FormatDefinition {
  id: string;
  name: string;
  extension: string;
  mimeType: string;
  category: FormatCategory;
  description: string;
  targetFormats: string[];
  optionsSchema?: FormatOptionsSchema;
}

export interface ConversionOptions {
  quality?: number;
  width?: number;
  height?: number;
  fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
  stripMetadata?: boolean;
  orientation?: 'portrait' | 'landscape';
  dpi?: number;
  delimiter?: string;
  compressionLevel?: number;
}

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
  progress: number;
  resultUrl?: string;
  resultSize?: number;
  error?: string;
  options: ConversionOptions;
}

export interface ConversionResult {
  buffer: Buffer;
  mimeType: string;
  filename: string;
  size: number;
}
