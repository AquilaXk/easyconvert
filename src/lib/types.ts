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
  background?: boolean;
  dpi?: boolean;
  imageDpi?: boolean;
  jpegQuality?: boolean;
  layout?: boolean;
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
  /** `#rgb` or `#rrggbb`: fills flattened transparency and `fit: 'contain'` bars. Defaults to white for targets without alpha. */
  background?: string;
  dpi?: number;
  /** pdf -> txt: keep physical layout so table rows stay on one line (default: reading order). */
  layout?: boolean;
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
  /** WHATWG encoding label of delimited-text input; detected from BOM, NUL pattern and content when omitted. */
  encoding?: string;
  /** Prefix CSV/TSV output with a UTF-8 BOM; defaults to true for CSV and false for TSV. */
  bom?: boolean;
  /** Neutralize CSV/TSV cells that a spreadsheet would evaluate as formulas; defaults to true. */
  escapeFormulas?: boolean;
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
  /** Longest output in seconds (an output-side limit): more than 0 and at most the input's duration. */
  duration?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  useFfmpeg?: boolean;
  /** Place the moov box before the media data of mp4, mov and m4a output (default true there); true elsewhere is an error. */
  fastStart?: boolean;
  /**
   * Display aspect ratio as "W:H" (set without touching the pixels), or an object that also reshapes the picture:
   * `pad` adds black bars, `crop` removes picture, both to the ratio with even sizes.
   */
  aspectRatio?: string | AspectRatioOptions;
  disableHwaccel?: boolean;
  disableNativeEngine?: boolean;
  // Office & PDF export options
  pdfStandard?: 'pdfa' | 'pdfa-1b' | 'pdfa-2b' | 'pdfa-3b';
  pdfVersion?: string;
  libreOfficeFilter?: string;
  losslessImageCompression?: boolean;
  /** Office to PDF: downsample embedded images to this resolution (72-1200). Default: keep them. */
  imageDpi?: number;
  /** Office to PDF: re-encode embedded JPEGs at this quality (1-100). Default: keep the stream. */
  jpegQuality?: number;
  watermark?: PdfWatermarkOptions;
  protect?: PdfProtectOptions;
  pdfa?: PdfAOptions;
}

export interface AspectRatioOptions {
  /** "W:H", whole numbers, e.g. "4:3". */
  ratio: string;
  /** `dar` sets the display ratio only (default), `pad` adds bars, `crop` removes picture. */
  mode?: 'dar' | 'pad' | 'crop';
}

export interface VideoRateControlCrf {
  mode: 'crf';
  crf: number;
  /**
   * Caps the peak bitrate of the constant-quality encode (capped CRF): `-maxrate` with a `-bufsize` of twice
   * that. Left unset, quality alone decides the rate and no bitrate is invented.
   */
  maxBitrateK?: number;
}

export interface VideoRateControlVbr {
  mode: 'vbr';
  bitrateK: number;
  maxrateK?: number;
  bufsizeK?: number;
  /** Run the encode in two passes (h264, hevc, vp9): the second reaches the target bitrate more exactly. */
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

/** Named EBU R128 / ITU-R BS.1770-4 loudness targets. */
export type LoudnessPreset = 'ebu-r128' | 'streaming' | 'podcast';

export interface LoudnessOptions {
  /** Starting values: `ebu-r128` (-23 LUFS, the default), `streaming` (-14 LUFS) or `podcast` (-16 LUFS). */
  preset?: LoudnessPreset;
  /** Integrated loudness target in LUFS (-70 to -5). */
  integrated?: number;
  /** Maximum true peak in dBTP (-9 to 0). */
  truePeak?: number;
  /** Loudness range target in LU (1 to 50). */
  lra?: number;
}

export type AudioResampler = 'soxr' | 'swr';
export type AudioDither = 'none' | 'rectangular' | 'triangular' | 'triangular_hp';

export interface AudioEncodingOptions {
  codec?: AudioCodec;
  /** Opt-in two-pass loudness normalisation (a measuring pass, then a linear gain). */
  loudness?: LoudnessOptions;
  /** Resampler for rate changes: soxr when the ffmpeg build has it (the default), otherwise swr. */
  resampler?: AudioResampler;
  /** Dither for the reduction to 16-bit PCM; defaults to triangular_hp. */
  dither?: AudioDither;
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

/** HLS segment container: MPEG-2 transport stream, or fragmented MP4 (CMAF). MPEG-DASH always uses fmp4. */
export type MediaPackagingSegmentType = 'ts' | 'fmp4';

export interface MediaPackagingOptions {
  format: MediaPackagingFormat;
  segmentSeconds?: number;
  segmentType?: MediaPackagingSegmentType;
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

/** What a stream a conversion left out was. `chapters` is the chapter list, which has no stream index. */
export type DroppedStreamKind = 'video' | 'subtitle' | 'attachment' | 'data' | 'attached_picture' | 'chapters';

/**
 * Why a stream was left out:
 * - `container_unsupported`: the target container cannot carry it (subtitles in avi, attachments outside mkv).
 * - `stream_type_unsupported`: no conversion to a video container carries this kind of stream (data, cover art).
 * - `additional_video_track`: a video container output holds one video track; only the first was kept.
 */
export type DroppedStreamReason = 'container_unsupported' | 'stream_type_unsupported' | 'additional_video_track';

/** A stream of the input that the output does not contain. The conversion itself succeeded. */
export interface DroppedStream {
  /** Absolute stream index in the input; absent for the chapter list. */
  index?: number;
  kind: DroppedStreamKind;
  codec?: string;
  language?: string;
  title?: string;
  reason: DroppedStreamReason;
}

export interface ConversionResult {
  buffer: Buffer;
  mimeType: string;
  filename: string;
  size: number;
  ocrExtractedText?: string;
  /** The request asked for OCR, but every page already had text (skip_text), so the input was returned unchanged. */
  ocrSkipped?: boolean;
  ocrConfidence?: number | null;
  isEmbeddedPreview?: boolean;
  parts?: { filename: string; buffer: Buffer }[];
  /** Frames (animated GIF/WebP/APNG) or pages (multi-page TIFF/HEIF) the source image holds; set only when more than one. */
  sourceFrameCount?: number;
  /** 1-based frame or page a still output was taken from: frame 1 by default, or the requested `page`. */
  frameUsed?: number;
  /** Link entries left out of an extraction because `skipLinks` was set. */
  skippedLinks?: string[];
  /**
   * Engine and post-processing facts about the result, such as the PDF/A verdict. A media conversion lists the
   * input streams the output lacks as `droppedStreams` (see DroppedStream).
   */
  metadata?: Record<string, unknown>;
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
  sourceFrameCount?: number;
  frameUsed?: number;
  /** Engine that produced the output (for example `native-ffmpeg` or `internal-fallback`). */
  engineUsed?: string;
  /** Public, redacted reason a fallback happened; absent when the first-choice engine ran. */
  fallbackReason?: string;
  /** Input streams the output lacks because the target cannot carry them; absent when nothing was left out. */
  droppedStreams?: DroppedStream[];
}

export class ConversionFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversionFailedError';
  }
}

/**
 * Marker base of every failure that means "this worker lacks the tool" (an engine, binary or codec) rather than
 * "this input is bad". A worker pool can be mixed, so a queued job that fails with one is retried on another
 * worker. Every error class named like a missing tool must extend it; a test scans the source tree for that.
 */
export class EngineMissingError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'EngineMissingError';
  }
}

export class FileExtensionSpoofError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'FileExtensionSpoofError';
  }
}

export class OcrEngineUnavailableError extends EngineMissingError {
  constructor(message: string) {
    super(message);
    this.name = 'OcrEngineUnavailableError';
  }
}

/** An image handed to OCR preprocessing is malformed, inconsistent or beyond its limits. */
export class OcrPreprocessError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'OcrPreprocessError';
  }
}

export class UnsupportedTargetError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedTargetError';
  }
}

export class ArchiveEncryptionUnavailableError extends EngineMissingError {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveEncryptionUnavailableError';
  }
}

/** A password-protected archive came out of the archiver without encryption and was discarded. */
export class ArchiveNotEncryptedError extends ConversionFailedError {
  constructor(message = 'Archive was written without encryption.') {
    super(message);
    this.name = 'ArchiveNotEncryptedError';
  }
}

/** The archive is encrypted and the request carried no password. */
export class ArchivePasswordRequiredError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'ArchivePasswordRequiredError';
  }
}

/** The request carried a password that does not decrypt the archive. */
export class InvalidArchivePasswordError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidArchivePasswordError';
  }
}

export class UnsupportedOptionError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedOptionError';
  }
}

/** Input bytes that are not valid text in the detected or requested character encoding. */
export class DataEncodingError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'DataEncodingError';
  }
}

/** Where a structured-data parse error was found; all positions are 1-based. */
export interface DataErrorLocation {
  /** Physical line of the input text. */
  line?: number;
  column?: number;
  /** Record of a delimited table, counting the header record as row 1. */
  row?: number;
}

/** Structured-data input (CSV, JSON, NDJSON, YAML, TOML, XML) that does not parse. */
export class DataParseError extends ConversionFailedError {
  readonly line?: number;
  readonly column?: number;
  readonly row?: number;

  constructor(message: string, location: DataErrorLocation = {}) {
    super(message);
    this.name = 'DataParseError';
    this.line = location.line;
    this.column = location.column;
    this.row = location.row;
  }
}

/** Structured-data input that exceeds a safety cap: entity or alias expansion, expanded size, nesting depth. */
export class DataLimitExceededError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'DataLimitExceededError';
  }
}

/** A parsed value that the target data format cannot represent (TOML null, JSON infinity, XML control characters). */
export class DataRepresentationError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'DataRepresentationError';
  }
}

export class OcrLanguageUnavailableError extends OcrEngineUnavailableError {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'OcrLanguageUnavailableError';
  }
}

export class CadGeometryUnavailableError extends EngineMissingError {
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

export class EngineUnavailableError extends EngineMissingError {
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

/** HTTP status of a worker output that vanished: a server fault, not a verdict on the request. */
const WORKER_OUTPUT_MISSING_STATUS = 500;

/** What an API answers for a vanished output; the worker's file name stays in the server log. */
export const WORKER_OUTPUT_MISSING_DETAIL = 'The conversion output is no longer available';

/**
 * A conversion produced its output, but the persisted file is gone when the result is read (a swept scratch
 * directory, a deleted volume). It is a server fault: the job fails with 500, never with an empty artifact.
 * It is not an `EngineMissingError`, so the queue does not retry it on another worker; a retry would only
 * redo a conversion whose storage is failing. The message names the output, never its location on disk.
 */
export class WorkerOutputMissingError extends ConversionFailedError {
  readonly status = WORKER_OUTPUT_MISSING_STATUS;

  constructor(outputName: string) {
    super(`The persisted conversion output "${outputName}" is no longer available`);
    this.name = 'WorkerOutputMissingError';
  }
}

/** A stored artifact has a file extension the format registry does not know, so its MIME type cannot be named. */
export class UnknownArtifactFormatError extends ConversionFailedError {
  constructor(artifactName: string) {
    super(`Artifact "${artifactName}" has no format registered, so its MIME type is unknown`);
    this.name = 'UnknownArtifactFormatError';
  }
}

/**
 * Redis is configured for the job queue but did not answer, so a job cannot be stored or read. Routes
 * answer it with 503 and `Retry-After`; the in-memory queue is never a stand-in once Redis is configured.
 * It is an `EngineUnavailableError`, so a worker that hits it retries the job instead of failing it.
 */
export class QueueUnavailableError extends EngineUnavailableError {
  constructor(queueName: string, reason?: string) {
    super(`queue:${queueName}`, reason ?? 'Redis is configured but not reachable');
    this.name = 'QueueUnavailableError';
  }
}

/**
 * A persisted graph scheduler record is missing a field or holds a value of the wrong type. The
 * record is never repaired or defaulted: the graph fails. A retry reads the same record, so it is
 * not retryable; the status is a server fault (500), not a verdict on the caller's input.
 */
export class GraphStateCorruptError extends ConversionFailedError {
  readonly status = 500;
  constructor(message: string) {
    super(message);
    this.name = 'GraphStateCorruptError';
  }
}

/** An `export.url` node could not deliver an artifact to the destination URL. */
export class GraphExportError extends ConversionFailedError {
  constructor(message: string, readonly destinationStatus?: number) {
    super(message);
    this.name = 'GraphExportError';
  }
}

/**
 * An input asks for more work or memory than the engine allows: a stream that would decode past a
 * size limit, or a document that would produce more text blocks or character mappings than the caps.
 * The routes answer it with HTTP 413 through `status`, ahead of the generic 400 for a ConversionFailedError.
 */
export class PayloadLimitError extends ConversionFailedError {
  readonly status = 413;
  constructor(message: string) {
    super(message);
    this.name = 'PayloadLimitError';
  }
}

/** A compressed stream would decode past a per-stream or per-document byte limit. */
export class DecompressionLimitError extends PayloadLimitError {
  constructor(message: string) {
    super(message);
    this.name = 'DecompressionLimitError';
  }
}

/**
 * A document is encrypted, password protected or DRM protected, so its text cannot be read. The request was
 * understood and the file is intact; it is the content that is unavailable, so the routes answer HTTP 422
 * (through `status`) instead of the generic 400 for a malformed input.
 */
export class EncryptedOfficeDocumentError extends ConversionFailedError {
  readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = 'EncryptedOfficeDocumentError';
  }
}

/** A compressed stream is malformed, truncated, or disagrees with the size its container declares. Maps to HTTP 400. */
export class CorruptStreamError extends ConversionFailedError {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'CorruptStreamError';
  }
}

export class InvalidPageRangeError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPageRangeError';
  }
}

export class ComplexScriptRequiresNativeEngineError extends EngineMissingError {
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
export class RawEngineRequiredError extends EngineMissingError {
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

/** The input has no video stream, so a video target or an adaptive-bitrate package has nothing to encode. */
export class NoVideoStreamError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'NoVideoStreamError';
  }
}

/** The input declares more streams than one conversion maps; the limit bounds probing and mapping work. */
export class TooManyMediaStreamsError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'TooManyMediaStreamsError';
  }
}

/** ffprobe output that cannot be parsed or lacks a required field; the input is not described reliably. */
export class MediaProbeError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'MediaProbeError';
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

export class ArchiveEntryCollisionError extends ConversionFailedError {
  readonly status = 422;
  readonly entryName: string;
  constructor(entryName: string, message?: string) {
    super(message || `Archive entry name collision detected for "${entryName}".`);
    this.name = 'ArchiveEntryCollisionError';
    this.entryName = entryName;
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

/**
 * veraPDF validated a PDF/A output and it failed. `failedRules` lists the rule IDs
 * (`<clause>-<test number>`, for example `6.2.11.4.1-1`) in the order veraPDF reports them.
 */
export class PdfAValidationError extends PdfPostprocessError {
  constructor(
    readonly profile: PdfAConformance,
    readonly failedRules: readonly string[]
  ) {
    const rules = failedRules.length > 0 ? ` Failed rules: ${failedRules.join(', ')}.` : '';
    super(`PDF/A validation failed: the output is not PDF/A compliant (${profile}).${rules}`);
    this.name = 'PdfAValidationError';
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

