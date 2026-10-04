import type { ConversionOptions } from '@/lib/types';

export type NodeId = string;

export type FailurePolicy = 'fail_fast' | 'continue';

export interface ImportUploadNode {
  op: 'import.upload';
  storageKey: string;
}

export interface ImportUrlNode {
  op: 'import.url';
  url: string;
  headers?: Record<string, string>;
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
    ocrFormat?: 'pdf' | 'txt' | 'hocr' | 'alto' | 'tsv';
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
  targetFormat: 'zip' | '7z' | 'tar' | 'tar.gz' | 'tar.zst';
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
  url: string;
  method?: 'PUT' | 'POST';
  headers?: Record<string, string>;
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
  | WatermarkNode
  | PdfWatermarkNode
  | PdfProtectNode
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
