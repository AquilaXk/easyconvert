import type { ConversionOptions, MediaPackagingOptions } from '@/lib/types';

export type NodeId = string;

export type FailurePolicy = 'fail_fast' | 'continue';

export interface ImportUploadNode {
  op: 'import.upload';
  storageKey: string;
}

/**
 * `url` and `headers` are bearer secrets. Submitted as plaintext, they are replaced by `sealed`
 * before the node is stored or queued, and opened only by the worker that runs the node.
 */
export interface ImportUrlNode {
  op: 'import.url';
  url?: string;
  headers?: Record<string, string>;
  sealed?: string;
}

export interface ConvertNode {
  op: 'convert';
  input: NodeId;
  targetFormat: string;
  options?: ConversionOptions;
}

export interface OcrNode {
  op: 'ocr';
  input: NodeId;
  options?: ConversionOptions & {
    language?: string;
    ocrMode?: 'skip-text' | 'skip_text' | 'force' | 'redo';
    ocrFormat?: 'pdf';
  };
}

export interface OptimizeNode {
  op: 'optimize';
  input: NodeId;
  options?: ConversionOptions;
}

export interface ArchiveCreateNode {
  op: 'archive.create';
  input: NodeId[];
  targetFormat: 'zip' | '7z' | 'tar' | 'tar.gz';
  options?: ConversionOptions & {
    compressionLevel?: number;
    password?: string;
  };
}

export interface ArchiveExtractNode {
  op: 'archive.extract';
  input: NodeId;
  entries?: string[];
}

export interface ExportUrlNode {
  op: 'export.url';
  input: NodeId | NodeId[];
  /** Plaintext only on submission; see ImportUrlNode. */
  url?: string;
  method?: 'PUT' | 'POST';
  headers?: Record<string, string>;
  sealed?: string;
}

export interface WatermarkNode {
  op: 'watermark';
  input: NodeId | NodeId[];
  options?: ConversionOptions;
}

export interface PdfWatermarkNode {
  op: 'pdf.watermark';
  input: NodeId | NodeId[];
  options?: ConversionOptions;
}

export interface PdfProtectNode {
  op: 'pdf.protect';
  input: NodeId | NodeId[];
  options?: ConversionOptions;
}

/** Removes the encryption and owner restrictions of PDFs (`options.password`, `options.confirmEditRights`). */
export interface PdfUnlockNode {
  op: 'pdf.unlock';
  input: NodeId | NodeId[];
  options?: ConversionOptions;
}

export interface ThumbnailNode {
  op: 'thumbnail';
  input: NodeId;
  targetFormat?: 'jpg' | 'png';
  options?: ConversionOptions & { thumbnail?: { width?: number; height?: number; format?: 'jpg' | 'png' } };
}

/** Adaptive-bitrate packaging (HLS or MPEG-DASH) of a video; the output is one ZIP with the manifest and segments. */
export interface MediaPackageNode {
  op: 'media.package';
  input: NodeId;
  targetFormat?: 'zip';
  options?: ConversionOptions & { packaging?: MediaPackagingOptions };
}

export interface MergeNode {
  op: 'merge';
  input: NodeId[];
  targetFormat: 'pdf' | 'txt';
  /** `passwords` (open password of each input, in order) and `confirmEditRights` for encrypted PDF inputs. */
  options?: ConversionOptions;
}

export interface MetadataNode {
  op: 'metadata';
  input: NodeId;
}

export interface ExportInternalNode {
  op: 'export.internal';
  input: NodeId | NodeId[];
}

export type GraphNode =
  | ImportUploadNode
  | ImportUrlNode
  | ConvertNode
  | OcrNode
  | OptimizeNode
  | ThumbnailNode
  | MediaPackageNode
  | MergeNode
  | MetadataNode
  | WatermarkNode
  | PdfWatermarkNode
  | PdfProtectNode
  | PdfUnlockNode
  | ArchiveCreateNode
  | ArchiveExtractNode
  | ExportUrlNode
  | ExportInternalNode;

export interface JobGraph {
  nodes: Record<NodeId, GraphNode>;
  failurePolicy?: FailurePolicy;
}

export interface ValidateGraphOptions {
  userTier?: 'free' | 'pro' | 'enterprise';
  sourceFormat?: string;
  sourceFilename?: string;
  maxNodes?: number;
}

export interface GraphValidationErrorDetail {
  path: string;
  message: string;
  code: string;
}

export interface GraphValidationResult {
  valid: boolean;
  errors: GraphValidationErrorDetail[];
  topologicalOrder?: NodeId[];
  depth?: number;
  inferredOutputFormats?: Record<NodeId, string>;
}
