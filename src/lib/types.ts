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
  aspectRatio?: boolean;
  // Document & Office options
  pages?: boolean;
  password?: boolean;
  preserveLayout?: boolean;
  preserveFonts?: boolean;
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
  // CAD & NURBS options
  uSamples?: number;
  vSamples?: number;
  // Document & PDF options
  pages?: string;
  pageCount?: number;
  password?: string;
  orientation?: 'portrait' | 'landscape';
  preserveLayout?: boolean;
  preserveFonts?: boolean;
  preserveTables?: boolean;
  ocrEnabled?: boolean;
  ocrLanguage?: 'auto' | 'en' | 'ko' | 'de' | 'fr' | 'es' | 'ja' | 'zh';
  clientEdgeMode?: boolean;
  margin?: 'normal' | 'narrow' | 'wide';
  validateMagicBytes?: boolean;
  // Data & Spreadsheet options
  delimiter?: string;
  hasHeaders?: boolean;
  sheetIndex?: number;
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
  videoCodec?: 'h264' | 'hevc' | 'vp9' | 'av1' | 'prores';
  videoBitrate?: number;
  duration?: number;
  aspectRatio?: 'original' | '16:9' | '4:3' | '1:1' | '9:16';
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
  ocrConfidence?: number;
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
  | 'delayed';

export type JobState = JobStatus;

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

