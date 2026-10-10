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
  /** Resampling kernel of a resize; downscales of 2x or more also run in linear light. Defaults to lanczos3. */
  kernel?: 'lanczos3' | 'lanczos2' | 'mitchell' | 'cubic' | 'nearest' | 'mks2021';
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
  /** TIFF target: `deflate` (default, lossless), `lzw`, `none` or `jpeg` (lossy, only when asked for). */
  tiffCompression?: 'deflate' | 'lzw' | 'none' | 'jpeg';
  /**
   * HDR to SDR rendering of EXR and PQ/HLG tagged pictures and of HDR video: `bt2390` (default, ITU-R BT.2390 EETF),
   * `clip` (hard clip at SDR white) or `none` (keep HDR, for targets that can carry it).
   */
  toneMap?: 'none' | 'clip' | 'bt2390';
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
  /**
   * PDF editing (watermark, merge, unlock, page operations, optimize): the caller states that they may edit the document, which lifts the owner
   * restrictions of a PDF that has no open password or is opened with its user password. Only `true` counts.
   */
  confirmEditRights?: boolean;
  /** Merge: the open password of each input, by position (`null` for an input that has none). */
  passwords?: Array<string | null>;
  orientation?: 'portrait' | 'landscape';
  preserveTables?: boolean;
  /** BCP 47 language of the document content, written to the language metadata of targets that carry it (EPUB). */
  language?: string;
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
  /**
   * Find a page's orientation and script when it reads badly, and read it again turned (and in the
   * script's language when `ocrLanguage` is `auto`). Left out it is done when the detection data is
   * installed and skipped, with the skip recorded, when it is not; `true` demands it and answers 503
   * when the data is missing; `false` never looks.
   */
  ocrDetectOrientation?: boolean;
  /**
   * Also return the OCR engine's own hOCR or ALTO of each recognized PDF page in the result metadata
   * (`metadata.ocrEngineMarkup`). For verification and debugging; it needs the tesseract command line.
   */
  ocrEngineMarkup?: 'hocr' | 'alto';
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
  /** `pdf.split-pages` node: how the document is cut into parts. */
  split?: PdfSplitOptions;
  /** `pdf.rotate-pages` node: which pages turn, and by how much. */
  rotate?: PdfRotateOptions;
  /** `pdf.reorder-pages` node: the new page order. */
  reorder?: PdfReorderOptions;
  /** `optimize` node on a PDF: the compression profile. */
  optimize?: PdfOptimizeOptions;
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
  /** One entry per artifact an optimize node handled: whether its optimiser made it smaller, and both sizes. */
  optimizations?: Array<{ key: string; optimized: boolean; inputBytes: number; outputBytes: number }>;
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

/**
 * An archive the service understands but cannot or will not read as sent: it needs a password the request lacks or got
 * wrong, or it uses a method or work factor this engine does not decode. The input is intact, so the routes answer
 * HTTP 422 (through `status`) like the password errors of a PDF, not the 400 of a malformed input.
 */
export class ArchiveInputUnprocessableError extends ConversionFailedError {
  readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveInputUnprocessableError';
  }
}

/** The archive is encrypted and the request carried no password. */
export class ArchivePasswordRequiredError extends ArchiveInputUnprocessableError {
  constructor(message: string) {
    super(message);
    this.name = 'ArchivePasswordRequiredError';
  }
}

/** The request carried a password that does not decrypt the archive. */
export class InvalidArchivePasswordError extends ArchiveInputUnprocessableError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidArchivePasswordError';
  }
}

/**
 * An archive names a compression method, filter or key derivation this engine does not decode, or asks for more work
 * than it accepts. The archive is intact, so the routes answer HTTP 422; the bytes are never passed on undecoded.
 */
export class UnsupportedArchiveMethodError extends ArchiveInputUnprocessableError {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedArchiveMethodError';
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

/**
 * The OCR language of a request cannot be used. 400 (the default) when the code names no language of the table
 * or joins too many; 503 when the language is known but its data is not installed here, which another worker
 * may have.
 */
export class OcrLanguageUnavailableError extends OcrEngineUnavailableError {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'OcrLanguageUnavailableError';
    this.status = status;
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

/** CAD input whose geometry data is malformed (a knot vector that decreases, the wrong number of knots). Maps to HTTP 400. */
export class CadGeometryError extends ConversionFailedError {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'CadGeometryError';
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
const INVALID_CONVERSION_OUTPUT_STATUS = 500;

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

/**
 * An engine returned bytes that are not of the format the job asked for (container bytes for a text target). It is a
 * server fault: the job fails with 500 and the message names the formats, never the bytes.
 */
export class InvalidConversionOutputError extends ConversionFailedError {
  readonly status = INVALID_CONVERSION_OUTPUT_STATUS;

  constructor(source: string, target: string) {
    super(`The conversion of the .${source} file to .${target} produced bytes that are not a .${target} file.`);
    this.name = 'InvalidConversionOutputError';
  }
}

/** A stored artifact has a file extension the format registry does not know, so its MIME type cannot be named. */
export class UnknownArtifactFormatError extends ConversionFailedError {
  constructor(artifactName: string) {
    super(`Artifact "${artifactName}" has no format registered, so its MIME type is unknown`);
    this.name = 'UnknownArtifactFormatError';
  }
}

/** `engineName` of a SandboxUnavailableError: the per-child confinement, not one native tool. */
export const SANDBOX_ENGINE_NAME = 'sandbox';

/**
 * STRICT_SANDBOX is on and this host cannot create the namespace sandbox a native child must run in (an
 * unprivileged `unshare` that a seccomp profile or a kernel setting denies). The conversion is refused before
 * any process starts: it never runs unsandboxed and never falls back to another engine. It is an
 * `EngineUnavailableError`, so routes answer 503 and a queue worker retries the job, which another worker
 * with a working sandbox can serve. The message is fixed text: no tool, path or argument.
 */
export class SandboxUnavailableError extends EngineUnavailableError {
  constructor(reason: string) {
    super(SANDBOX_ENGINE_NAME, reason);
    this.name = 'SandboxUnavailableError';
  }
}

/**
 * The bounded queue of the CPU worker pool is full. The caller can retry once running tasks finish, so the routes
 * answer 503 with `Retry-After`; it is an `EngineUnavailableError`, so a worker that hits it retries the job.
 */
export class CpuPoolOverloadedError extends EngineUnavailableError {
  readonly status = 503;

  constructor(queued: number, limit: number) {
    super('cpu-pool', `${queued} tasks are already queued (limit ${limit})`);
    this.name = 'CpuPoolOverloadedError';
  }
}

/** A task on the CPU worker pool ran past its time limit and its thread was terminated. */
export class CpuTaskTimeoutError extends ConversionFailedError {
  readonly status = 422;

  constructor(kind: string, limitMs: number) {
    super(`The ${kind} task exceeded its ${limitMs} ms time limit`);
    this.name = 'CpuTaskTimeoutError';
  }
}

/** HTTP status of a job that ran past its deadline: the server's wall-clock limit, not a fault in the request. */
export const JOB_TIMEOUT_STATUS = 504;

/**
 * A conversion job ran past its wall-clock deadline (`jobDeadlineMs`) and was stopped. The attempt's signal fires
 * with this error as its reason, sandboxed child processes are killed and the worker slot is freed. It is a typed
 * `ConversionFailedError`, so the queue does not retry it (another attempt would run into the same deadline) and
 * the job records `failedCode` "JobTimeoutError" and `failedStatus` 504; the synchronous routes answer 504 with the
 * problem type `https://api.easyconvert.io/problems/job-timeout`.
 */
export class JobTimeoutError extends ConversionFailedError {
  readonly status = JOB_TIMEOUT_STATUS;
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Job timed out after ${timeoutMs}ms`);
    this.name = 'JobTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The client of a synchronous conversion closed the connection before the answer was ready. The conversion is
 * aborted with this error as the signal's reason and no answer is delivered. The quota unit is refunded like for any
 * failed conversion (only successful conversions are charged); the request still counts toward the rate limit.
 */
export class RequestAbortedError extends Error {
  constructor() {
    super('The client closed the connection before the conversion finished');
    this.name = 'RequestAbortedError';
  }
}

/** A task on the CPU worker pool was cancelled by its caller. */
export class CpuTaskAbortedError extends ConversionFailedError {
  constructor(kind: string) {
    super(`The ${kind} task was cancelled`);
    this.name = 'CpuTaskAbortedError';
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

/**
 * A PDF is encrypted and the request carried no password, or a password that does not open it. Maps to HTTP 422 and,
 * like every typed conversion failure, is never retried by the queue.
 */
export class PdfPasswordRequiredError extends EncryptedOfficeDocumentError {
  constructor(message: string) {
    super(message);
    this.name = 'PdfPasswordRequiredError';
  }
}

/**
 * The `passwords` of a merge node do not line up with its inputs (a different number of entries, or an artifact that
 * no input produced). Maps to HTTP 422, like the other errors about the passwords of a PDF.
 */
export class PdfPasswordListError extends EncryptedOfficeDocumentError {
  constructor(message: string) {
    super(message);
    this.name = 'PdfPasswordListError';
  }
}

/**
 * A PDF's permissions forbid the requested edit and the request did not carry the owner password that lifts them.
 * Maps to HTTP 422.
 */
export class PdfPermissionDeniedError extends EncryptedOfficeDocumentError {
  constructor(message: string) {
    super(message);
    this.name = 'PdfPermissionDeniedError';
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

/**
 * Text of a script that needs shaping contains a character no installed font covers. The font set is part of the
 * request's environment and not a missing engine, so it answers HTTP 400 (through `status`) rather than 503.
 */
export class FontCoverageError extends ConversionFailedError {
  readonly status = 400;
  /** The first uncovered code point. */
  readonly codePoint: number;
  constructor(message: string, codePoint: number) {
    super(message);
    this.name = 'FontCoverageError';
    this.codePoint = codePoint;
  }
}

/** Text to shape is longer than the shaping limits allow (one paragraph, or all glyphs of one document). HTTP 413. */
export class ShapingLimitError extends PayloadLimitError {
  constructor(message: string) {
    super(message);
    this.name = 'ShapingLimitError';
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

/**
 * How `pdf.split-pages` cuts a document; the parts come back as one ZIP. At most one of `ranges` and `everyNPages` is
 * given; with neither, every page is a file of its own.
 */
export interface PdfSplitOptions {
  /** One part per comma-separated range, in the order written: `1-3,4-6,7-`. */
  ranges?: string;
  /** One part per this many pages (the last part holds the remainder). */
  everyNPages?: number;
}

export type PdfRotationDegrees = 90 | 180 | 270;

export interface PdfRotation {
  /** Clockwise, added to the rotation the page already has. */
  rotation: PdfRotationDegrees;
  /** Pages to turn (`1-3,5`, `2-`); every page when omitted. */
  pages?: string;
}

/** Either one `rotation` for `pages` (every page when omitted), or `rotations` with one entry per group of pages. */
export interface PdfRotateOptions {
  rotation?: PdfRotationDegrees;
  pages?: string;
  rotations?: PdfRotation[];
}

export interface PdfReorderOptions {
  /** The pages to put first, in the new order (`3,1,2` or `4-6,1-3`); a full order lists every page once. Pages not listed follow in their original order. */
  order: string;
}

/** `web` 150 dpi and balanced JPEG, `print` 300 dpi, `archive` lossless, `max` 72 dpi and strong JPEG. */
export type PdfOptimizeProfile = 'web' | 'print' | 'archive' | 'max';

export interface PdfOptimizeOptions {
  profile?: PdfOptimizeProfile;
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

/**
 * A text watermark the request cannot get: a font family that is not installed or has no glyph for the text, a
 * text over the length cap, or a line break. The request is wrong, so it is a client error (400), not a missing
 * engine (503) and not a post-processing failure of a good document (422).
 */
export class WatermarkFontError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'WatermarkFontError';
  }
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

