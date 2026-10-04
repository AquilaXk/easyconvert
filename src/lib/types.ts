import { PIPELINE_OPERATIONS } from './api/contracts/enums';

export type FormatCategory =
  | 'image'
  | 'document'
  | 'data'
  | 'spreadsheet'
  | 'presentation'
  | 'archive'
  | 'audio'
  | 'video'
  | 'ebook'
  | 'font'
  | 'cad'
  | 'vector';

export interface FormatOptionsSchema {
  quality?: boolean;
  dimensions?: boolean;
  fit?: boolean;
  stripMetadata?: boolean;
  dpi?: boolean;
  orientation?: boolean;
  delimiter?: boolean;
  hasHeaders?: boolean;
  sheetIndex?: boolean;
  compressionLevel?: boolean;
  archiveCoder?: boolean;
  splitVolumeBytes?: boolean;
  zstdDict?: boolean;
  solid?: boolean;
  // Media options
  audioBitrate?: boolean;
  audioChannels?: boolean;
  audioSampleRate?: boolean;
  audioVolume?: boolean;
  videoResolution?: boolean;
  videoFps?: boolean;
  videoCodec?: boolean;
  duration?: boolean;
  // Document & Office options
  pages?: boolean;
  password?: boolean;
  preserveTables?: boolean;
  ocrEnabled?: boolean;
  ocrLanguage?: boolean;
  margin?: boolean;
  // Color quantization options
  colorDepth?: boolean;
  colors?: boolean;
  palette?: boolean;
  dither?: boolean;
  // CAD / NURBS options
  uSamples?: boolean;
  vSamples?: boolean;
  allowEmbeddedPreview?: boolean;
}

export type ResourceClass = 'light' | 'cpu' | 'memory' | 'gpu';

export interface FormatDefinition {
  id: string;
  name: string;
  extension: string;
  mimeType: string;
  category: FormatCategory;
  description: string;
  targetFormats: string[];
  optionsSchema?: FormatOptionsSchema;
  available?: boolean;
  resourceClass?: ResourceClass;
}

export interface ConversionOptions {
  // Image options
  quality?: number;
  width?: number;
  height?: number;
  fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
  stripMetadata?: boolean;
  dpi?: number;
  colorDepth?: number;
  colors?: number;
  palette?: boolean;
  dither?: boolean;
  quantizer?: string;
  ditherMethod?: string;
  useWebGpu?: boolean;
  gpuAcceleration?: boolean;
  falseColorSuppression?: boolean | number;
  allowEmbeddedPreview?: boolean;
  // CAD & NURBS options
  uSamples?: number;
  vSamples?: number;
  // Document & PDF options
  page?: number;
  pages?: string;
  multiPageOutput?: 'zip' | 'first';
  pageCount?: number;
  password?: string;
  orientation?: 'portrait' | 'landscape';
  preserveTables?: boolean;
  ocrEnabled?: boolean;
  ocrLanguage?: 'auto' | 'en' | 'ko';
  clientEdgeMode?: boolean;
  margin?: 'normal' | 'narrow' | 'wide';
  validateMagicBytes?: boolean;
  // Data & Spreadsheet options
  delimiter?: string;
  hasHeaders?: boolean;
  sheetMode?: 'merged' | 'split' | 'index';
  sheetIndex?: number;
  range?: 'used' | 'printArea';
  lineEnding?: 'lf' | 'crlf';
  recalculate?: boolean;
  // Archive options
  compressionLevel?: number;
  archiveCoder?: 'lzma' | 'lzma2' | 'deflate' | 'copy';
  splitVolumeBytes?: number;
  zstdDict?: boolean | 'data' | 'office';
  archiveParts?: { filename: string; buffer: Buffer }[];
  useNative7z?: boolean;
  solid?: boolean;
  // Audio options
  audioBitrate?: '64k' | '96k' | '128k' | '192k' | '256k' | '320k';
  audioChannels?: 'mono' | 'stereo' | '5.1';
  audioSampleRate?: 16000 | 22050 | 32000 | 44100 | 48000;
  audioVolume?: number; // 0 - 200 (percentage)
  // Video options
  videoResolution?: 'original' | '4k' | '1080p' | '720p' | '480p' | '360p';
  videoFps?: 24 | 30 | 60;
  videoCodec?: 'h264' | 'hevc' | 'vp9' | 'av1';
  videoBitrate?: number;
  duration?: number;
  useFfmpeg?: boolean;
  fastStart?: boolean;
  disableHwaccel?: boolean;
  disableNativeEngine?: boolean;
  allowPureLossyBitstream?: boolean;
  // Office & PDF export options
  pdfStandard?: 'pdfa' | 'pdfa-1b' | 'pdfa-2b' | 'pdfa-3b';
  pdfVersion?: string;
  libreOfficeFilter?: string;
  losslessImageCompression?: boolean;
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
  edgeProcessed?: boolean;
  edgeTier?: string;
}

export interface ConversionResult {
  buffer: Buffer;
  mimeType: string;
  filename: string;
  size: number;
  ocrExtractedText?: string;
  ocrConfidence?: number | null;
  isEmbeddedPreview?: boolean;
  parts?: { filename: string; buffer: Buffer }[];
}

// S3 Chunked Upload Types
export interface MultipartUploadInit {
  uploadId: string;
  key: string;
  partSize: number;
  totalParts: number;
  expiresAt: number;
}

export interface UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface MultipartUploadComplete {
  location: string;
  key: string;
  size: number;
  etag: string;
}

// BullMQ / Distributed Job Queue Types
export type JobStatus =
  | 'waiting'
  | 'active'
  | 'completed'
  | 'failed'
  | 'delayed'
  | 'cancelled';

export type JobState = JobStatus;

export interface PipelineTask {
  name: string;
  operation: (typeof PIPELINE_OPERATIONS)[number];
  targetFormat?: string;
  options?: ConversionOptions;
  credentialRef?: string;
  remotePath?: string;
  url?: string;
}

import type { JobGraph, GraphNode, NodeId } from './queue/graph/types';
export type { JobGraph, GraphNode, NodeId };

export interface ConversionJobData {
  jobId: string;
  originalFilename: string;
  sourceFormat: string;
  targetFormat: string;
  fileSize: number;
  storageKey?: string;
  inputBufferBase64?: string;
  options: ConversionOptions;
  webhookUrl?: string;
  webhookSecret?: string;
  userId?: string;
  reservationId?: string;
  tasks?: PipelineTask[];
  graph?: JobGraph;
  graphId?: string;
  graphNodeId?: NodeId;
  graphNode?: GraphNode;
  inputArtifacts?: string[];
  resourceClass?: ResourceClass;
}

export interface ConversionJobResult {
  jobId: string;
  status: 'completed' | 'failed';
  resultKey: string;
  downloadUrl: string;
  filename: string;
  mimeType: string;
  size: number;
  durationMs: number;
  ocrExtracted?: boolean;
}

export class ConversionFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversionFailedError';
  }
}

export class FileExtensionSpoofError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'FileExtensionSpoofError';
  }
}

export class OcrEngineUnavailableError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'OcrEngineUnavailableError';
  }
}

export class UnsupportedTargetError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedTargetError';
  }
}

export class ArchiveEncryptionUnavailableError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveEncryptionUnavailableError';
  }
}

export class UnsupportedOptionError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedOptionError';
  }
}

export class OcrLanguageUnavailableError extends OcrEngineUnavailableError {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'OcrLanguageUnavailableError';
  }
}

export class CadGeometryUnavailableError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'CadGeometryUnavailableError';
  }
}

export class EngineUnavailableError extends ConversionFailedError {
  public readonly engineName: string;
  public readonly reason: string;

  constructor(engineName: string, reason?: string) {
    const msg = reason ? `Engine '${engineName}' is unavailable: ${reason}` : `Engine '${engineName}' is unavailable`;
    super(msg);
    this.name = 'EngineUnavailableError';
    this.engineName = engineName;
    this.reason = reason || msg;
  }
}

export class InvalidPageRangeError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPageRangeError';
  }
}

export class ComplexScriptRequiresNativeEngineError extends ConversionFailedError {
  constructor(
    message = 'Rendering complex scripts (CTL/RTL) requires the native LibreOffice engine'
  ) {
    super(message);
    this.name = 'ComplexScriptRequiresNativeEngineError';
  }
}

export class InvalidSheetIndexError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSheetIndexError';
  }
}



