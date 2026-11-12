import type { ConversionOptions, MediaPackagingOptions } from '@/lib/types';
import type { S3Credentials, SftpCredentials } from '@/lib/storage/credentials-vault';

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

/** The credentials a customer-storage node submits inline: those of a saved credential, without `type`, which the operation gives. */
export type InlineS3Credentials = Omit<S3Credentials, 'type'>;
export type InlineSftpCredentials = Omit<SftpCredentials, 'type'>;

/**
 * Where a customer-storage node gets its credentials: `credentialRef` names a saved credential of the graph's owner, or
 * `credentials` carries them inline. Inline credentials are bearer secrets: submitted as plaintext, they are replaced by `sealed`
 * before the node is stored or queued, and opened only by the worker that runs the node.
 */
interface CustomerStorageAuth<Inline> {
  credentialRef?: string;
  credentials?: Inline;
  sealed?: string;
}

/** Brings in one object (`key`) or the objects under a key prefix (`prefix`, at most `maxObjects`) of the customer's S3-compatible bucket. */
export interface ImportS3Node extends CustomerStorageAuth<InlineS3Credentials> {
  op: 'import.s3';
  key?: string;
  prefix?: string;
  maxObjects?: number;
}

/** Brings in one file (`path`) or the files of a directory (`directory`, at most `maxObjects`) of the customer's SFTP server. */
export interface ImportSftpNode extends CustomerStorageAuth<InlineSftpCredentials> {
  op: 'import.sftp';
  path?: string;
  directory?: string;
  maxObjects?: number;
}

/** Writes each input as `prefix` followed by its file name into the customer's bucket. */
export interface ExportS3Node extends CustomerStorageAuth<InlineS3Credentials> {
  op: 'export.s3';
  input: NodeId | NodeId[];
  prefix?: string;
}

/** Writes each input into `directory` of the customer's SFTP server. */
export interface ExportSftpNode extends CustomerStorageAuth<InlineSftpCredentials> {
  op: 'export.sftp';
  input: NodeId | NodeId[];
  directory?: string;
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

/** Cuts PDFs into parts, returned as one ZIP per input (`options.split`). */
export interface PdfSplitPagesNode {
  op: 'pdf.split-pages';
  input: NodeId | NodeId[];
  options?: ConversionOptions;
}

/** Keeps the pages of `options.pages`, in the order listed. */
export interface PdfExtractPagesNode {
  op: 'pdf.extract-pages';
  input: NodeId | NodeId[];
  options?: ConversionOptions;
}

/** Removes the pages of `options.pages`. */
export interface PdfDeletePagesNode {
  op: 'pdf.delete-pages';
  input: NodeId | NodeId[];
  options?: ConversionOptions;
}

/** Puts the pages of `options.reorder.order` first, in that order; the others follow. */
export interface PdfReorderPagesNode {
  op: 'pdf.reorder-pages';
  input: NodeId | NodeId[];
  options?: ConversionOptions;
}

/** Turns pages clockwise (`options.rotate`). */
export interface PdfRotatePagesNode {
  op: 'pdf.rotate-pages';
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
  | ImportS3Node
  | ImportSftpNode
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
  | PdfSplitPagesNode
  | PdfExtractPagesNode
  | PdfDeletePagesNode
  | PdfReorderPagesNode
  | PdfRotatePagesNode
  | ArchiveCreateNode
  | ArchiveExtractNode
  | ExportUrlNode
  | ExportS3Node
  | ExportSftpNode
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
