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
  ocrMode?: boolean;
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
  // RAW & HDR pipeline options
  outputDepth?: boolean;
  gainMap?: boolean;
  demosaicMethod?: boolean;
  targetColorSpace?: boolean;
  highlightReconstruction?: boolean;
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
  // RAW & HDR pipeline options
  demosaicMethod?: 'amaze' | 'rcd' | 'ahd';
  kelvin?: number;
  tint?: number;
  highlightReconstruction?: boolean | 'clip' | 'blend' | 'reconstruct';
  targetColorSpace?: 'sRGB' | 'display-p3' | 'rec2020' | 'linear';
  outputDepth?: 8 | 16 | 32;
  gainMap?: boolean;
  // CAD & NURBS options
  uSamples?: number;
  vSamples?: number;
  allowOpenMesh?: boolean;
  smoothingAngleDeg?: number;
  outputUnit?: 'mm' | 'cm' | 'm' | 'in';
  // Document & PDF options
  page?: number;
  pages?: string;
  multiPageOutput?: 'zip' | 'first';
  pageCount?: number;
  password?: string;
  orientation?: 'portrait' | 'landscape';
  preserveTables?: boolean;
  ocrEnabled?: boolean;
  ocrLanguage?:
    | 'auto'
    | 'en'
    | 'eng'
    | 'ko'
    | 'kor'
    | 'de'
    | 'deu'
    | 'fr'
    | 'fra'
    | 'es'
    | 'spa'
    | 'ja'
    | 'jpn'
    | 'jpn_vert'
    | 'ja_vert'
    | 'zh'
    | 'chi_sim'
    | 'chi_sim_vert'
    | 'zh_vert'
    | 'zh_sim_vert'
    | 'chi_tra'
    | 'zh_tra'
    | 'chi_tra_vert'
    | 'zh_tra_vert'
    | string;
  ocrMode?: 'skip_text' | 'skip-text' | 'force' | 'redo';
  ocrDensityThreshold?: number;
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
  collisionPolicy?: ArchiveCollisionPolicy;
  entries?: string[];
  /**
   * Opt in to extracting archives that contain symbolic or hard links by leaving those entries out.
   * Without it such archives are rejected. Skipped names are reported in `ConversionResult.skippedLinks`.
   */
  skipLinks?: boolean;
  repair?: boolean;
  // Audio options
  audio?: AudioEncodingOptions;
  audioBitrate?: '64k' | '96k' | '128k' | '192k' | '256k' | '320k';
  audioChannels?: 'mono' | 'stereo' | '5.1' | '7.1';
  audioSampleRate?: 16000 | 22050 | 32000 | 44100 | 48000;
  audioVolume?: number; // 0 - 200 (percentage)
  // Video options
  video?: VideoEncodingOptions;
  trim?: MediaTrimOptions;
  subtitles?: SubtitleOptions;
  thumbnail?: ThumbnailOptions;
  packaging?: MediaPackagingOptions;
  videoResolution?: 'original' | '4k' | '1080p' | '720p' | '480p' | '360p';
  videoFps?: 24 | 30 | 60;
  videoCodec?: 'h264' | 'hevc' | 'vp9' | 'av1';
  videoBitrate?: number;
  duration?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
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
  watermark?: PdfWatermarkOptions;
  protect?: PdfProtectOptions;
  pdfa?: PdfAOptions;
}

export interface VideoRateControlCrf {
  mode: 'crf';
  crf: number;
}

export interface VideoRateControlVbr {
  mode: 'vbr';
  bitrateK: number;
  maxrateK?: number;
  bufsizeK?: number;
  twoPass?: boolean;
}

export interface VideoRateControlCbr {
  mode: 'cbr';
  bitrateK: number;
}

export type VideoRateControl = VideoRateControlCrf | VideoRateControlVbr | VideoRateControlCbr;

export interface VideoCropOptions {
  w: number;
  h: number;
  x: number;
  y: number;
}

export interface VideoScaleOptions {
  width?: number;
  height?: number;
  fit?: 'contain' | 'cover' | 'stretch';
}

export interface VideoEncodingOptions {
  codec?: 'h264' | 'hevc' | 'vp9' | 'av1' | 'prores';
  profile?: string;
  level?: string;
  rateControl?: VideoRateControl;
  preset?: string;
  fps?: number;
  crop?: VideoCropOptions;
  rotate?: 0 | 90 | 180 | 270;
  deinterlace?: boolean;
  scale?: VideoScaleOptions;
}

export interface MediaTrimOptions {
  start?: string;
  end?: string;
}

export type AudioCodec = 'aac' | 'mp3' | 'opus' | 'flac' | 'vorbis' | 'pcm_s16le';

export interface AudioEncodingOptions {
  codec?: AudioCodec;
  bitrateK?: number;
  channels?: 1 | 2 | 6 | 8;
  sampleRate?: number;
  volume?: number;
  downmix?: 'itu-r-bs775';
  track?: number | 'all';
}

export type SubtitleMode = 'burn' | 'soft' | 'extract';
export type SubtitleFormat = 'srt' | 'vtt' | 'ass';

export interface SubtitleOptions {
  mode: SubtitleMode;
  input?: string;
  streamIndex?: number;
  format?: SubtitleFormat;
}

export interface ThumbnailOptions {
  at?: string[];
  format?: 'jpg' | 'png';
  width?: number;
  accurate?: boolean;
}

export interface MediaLadderRung {
  height: number;
  bitrateK: number;
  fps?: number;
  audioBitrateK?: number;
}

export type MediaPackagingFormat = 'hls' | 'dash';

export interface MediaPackagingOptions {
  format: MediaPackagingFormat;
  segmentSeconds?: number;
  ladder?: MediaLadderRung[];
  masterPlaylistName?: string;
  audioCodec?: 'aac' | 'opus';
  videoCodec?: 'h264' | 'hevc' | 'vp9' | 'av1';
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
  /** Link entries left out of an extraction because `skipLinks` was set. */
  skippedLinks?: string[];
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

import type { TaskNode, JobGraph, TaskDependency, GraphFailurePolicy } from './jobs/graph';
import type { GraphNode, NodeId } from './queue/graph/types';
export type { TaskNode, JobGraph, TaskDependency, GraphFailurePolicy, GraphNode, NodeId };

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
  graphNode?: GraphNode | TaskNode;
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

export class SvgSanitizationError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'SvgSanitizationError';
  }
}

export class CadTopologyError extends ConversionFailedError {
  constructor(message = 'CAD mesh failed topology or watertightness validation') {
    super(message);
    this.name = 'CadTopologyError';
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

/** An `export.url` node could not deliver an artifact to the destination URL. */
export class GraphExportError extends ConversionFailedError {
  constructor(message: string, readonly destinationStatus?: number) {
    super(message);
    this.name = 'GraphExportError';
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

export class UnsupportedRawCompressionError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedRawCompressionError';
  }
}

/** Sensor data of a camera RAW file is malformed: impossible dimensions or a truncated sample buffer. */
export class InvalidRawSensorError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRawSensorError';
  }
}

/** The native RAW decoder rejected the file: corrupt, truncated or an unsupported camera format. */
export class RawDecodeError extends ConversionFailedError {
  /** Whether the decoder does not recognize the file as RAW at all (as opposed to failing mid-decode). */
  readonly unrecognized: boolean;
  constructor(message: string, unrecognized = false) {
    super(message);
    this.name = 'RawDecodeError';
    this.unrecognized = unrecognized;
  }
}

/** The in-process engine cannot decode this camera RAW sensor data; only the native RAW engine can. */
export class RawEngineRequiredError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'RawEngineRequiredError';
  }
}

export class InvalidMediaOptionError extends UnsupportedOptionError {
  readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMediaOptionError';
  }
}

export type ArchiveCollisionPolicy = 'rename' | 'error' | 'overwrite';

export interface ArchiveEntryMetadata {
  name: string;
  uncompressedSize: number;
  compressedSize?: number;
  isEncrypted: boolean;
  isDirectory: boolean;
  modifiedAt?: string;
  crc32?: string;
  /** Set for entries that are not plain files or directories. Links are reported, never resolved. */
  kind?: 'symlink' | 'hardlink' | 'special';
  /** The name is absolute, climbs out with `..`, or is otherwise invalid. `name` is kept verbatim. */
  unsafePath?: boolean;
  /** Another entry in the archive has the same path. */
  duplicate?: boolean;
}

export interface ArchiveInspectResponse {
  format: string;
  totalEntries: number;
  totalUncompressedBytes: number;
  totalCompressedBytes: number;
  isEncrypted: boolean;
  entries: ArchiveEntryMetadata[];
  /** False when extraction would refuse the archive: links, unsafe paths, special entries or duplicates. */
  extractable: boolean;
  /** One line per blocking category, with a count and the first offending entry; empty when extractable. */
  unextractableReasons: string[];
}

export class MissingVolumeError extends Error {
  readonly status = 422;
  constructor(missingVolume: string, message?: string) {
    super(message || `Missing archive volume part: "${missingVolume}".`);
    this.name = 'MissingVolumeError';
  }
}

export class ArchiveEntryCollisionError extends Error {
  readonly status = 422;
  constructor(entryName: string, message?: string) {
    super(message || `Archive entry name collision detected for "${entryName}".`);
    this.name = 'ArchiveEntryCollisionError';
  }
}

export class ArchiveEncryptedHeaderError extends Error {
  readonly status = 422;
  constructor(message?: string) {
    super(message || 'Archive header is encrypted and requires a password to inspect entries.');
    this.name = 'ArchiveEncryptedHeaderError';
  }
}

export type PdfWatermarkPosition =
  | 'tile'
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'center-left'
  | 'center'
  | 'center-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

export type PdfWatermarkLayer = 'over' | 'under';

export interface PdfWatermarkOptions {
  type?: 'text' | 'image';
  text?: string;
  fontSize?: number;
  fontColor?: string; // hex like '#ff0000' or rgb like 'rgb(1,0,0)'
  fontFamily?: string;
  image?: Buffer | string; // Buffer or Base64 string
  imageType?: 'png' | 'jpeg';
  opacity?: number; // 0.0 to 1.0 (default 0.3)
  rotation?: number; // degrees (default -45 for diagonal text or 0)
  position?: PdfWatermarkPosition; // default 'center'
  pages?: string; // page range string (WP-40 syntax), e.g. "1-3,5", default all pages
  layer?: PdfWatermarkLayer; // default 'over'
  scale?: number; // scale factor
}

export type PdfPrintPermission = 'none' | 'low' | 'full';
export type PdfModifyPermission = 'none' | 'assembly' | 'annotate' | 'form' | 'all';

export interface PdfProtectPermissions {
  print?: PdfPrintPermission;
  modify?: PdfModifyPermission;
  extract?: boolean;
  annotate?: boolean;
}

export interface PdfProtectOptions {
  userPassword?: string;
  ownerPassword?: string;
  keyLength?: 128 | 256;
  permissions?: PdfProtectPermissions;
}

export type PdfAConformance = 'pdfa-1b' | 'pdfa-2b' | 'pdfa-3b';

export interface PdfAOptions {
  conformance?: PdfAConformance;
  recalculate?: boolean;
}

export interface PdfAConversionResult {
  buffer: Buffer;
  pdfaValidated: boolean;
  conformanceLevel: string;
}

export class PdfPostprocessError extends Error {
  readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = 'PdfPostprocessError';
  }
}

export interface HocrExportOptions {
  documentTitle?: string;
  filename?: string;
  pretty?: boolean;
}

export interface AltoExportOptions {
  filename?: string;
  pretty?: boolean;
  measurementUnit?: string;
}

export interface OcrPageDecision {
  pageNumber: number;
  skipped: boolean;
  reason: 'has_text' | 'forced' | 'no_text';
  textDensity: number;
  wordCount: number;
}

export interface PdfPageAnalysis {
  pageNumber: number;
  width: number;
  height: number;
  charCount: number;
  wordCount: number;
  hasTextLayer: boolean;
  text: string;
}

