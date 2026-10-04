/**
 * Single source of truth for job graph node operations: the canonical names the node executor
 * runs, the legacy spellings accepted at the API and rewritten to them, and per-operation rules.
 */

export const GRAPH_OPERATIONS = [
  'import.upload',
  'import.url',
  'convert',
  'ocr',
  'optimize',
  'thumbnail',
  'watermark',
  'pdf.watermark',
  'pdf.protect',
  'merge',
  'metadata',
  'archive.create',
  'archive.extract',
  'export.url',
  'export.internal',
] as const;

export type GraphOperation = (typeof GRAPH_OPERATIONS)[number];

export const GRAPH_OPERATION_SET: ReadonlySet<string> = new Set(GRAPH_OPERATIONS);

/**
 * Legacy spellings normalized for internal callers (the legacy-task adapter and typed scheduler
 * graphs); nodes are stored and executed under the canonical name. The public API schema
 * requires the canonical `op`, so these spellings are rejected there.
 */
export const LEGACY_GRAPH_OPERATION_ALIASES: Readonly<Record<string, GraphOperation>> = {
  import: 'import.upload',
  archive: 'archive.create',
  'archive/create': 'archive.create',
  'archive/extract': 'archive.extract',
  'media.thumbnail': 'thumbnail',
};

export const IMPORT_OPERATIONS: ReadonlySet<GraphOperation> = new Set<GraphOperation>(['import.upload', 'import.url']);
export const EXPORT_OPERATIONS: ReadonlySet<GraphOperation> = new Set<GraphOperation>(['export.url', 'export.internal']);

/** Operations whose output format must be named by the caller; none of them has a default. */
export const TARGET_FORMAT_REQUIRED_OPERATIONS: ReadonlySet<GraphOperation> = new Set<GraphOperation>([
  'convert',
  'thumbnail',
  'merge',
  'archive.create',
]);

/** Formats a thumbnail node can produce. */
export const THUMBNAIL_FORMATS: ReadonlySet<string> = new Set(['jpg', 'png']);

/** Formats a merge node can produce; every input must already be in that format. */
export const MERGE_FORMATS: ReadonlySet<string> = new Set(['pdf', 'txt']);

/** Archive formats an archive.create node can produce. */
export const ARCHIVE_CREATE_FORMATS: ReadonlySet<string> = new Set(['zip', 'tar', 'tar.gz', '7z']);

/** Allowed output formats for operations limited to a fixed set. */
export const RESTRICTED_OUTPUT_FORMATS: Readonly<Partial<Record<GraphOperation, ReadonlySet<string>>>> = {
  thumbnail: THUMBNAIL_FORMATS,
  merge: MERGE_FORMATS,
  'archive.create': ARCHIVE_CREATE_FORMATS,
};

/** Output format of operations that always produce the same format. */
export const FIXED_OUTPUT_FORMATS: Readonly<Partial<Record<GraphOperation, string>>> = {
  ocr: 'pdf',
  metadata: 'json',
};

/** Returns the canonical operation for a canonical or legacy name, or undefined when unknown. */
export function canonicalGraphOperation(raw: unknown): GraphOperation | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  if (GRAPH_OPERATION_SET.has(raw)) {
    return raw as GraphOperation;
  }
  return LEGACY_GRAPH_OPERATION_ALIASES[raw];
}

/** The requested output format of a node, from `targetFormat` or the thumbnail option. */
export function requestedTargetFormat(node: { targetFormat?: unknown; options?: any }): string | undefined {
  const raw = node.targetFormat ?? node.options?.thumbnail?.format;
  if (typeof raw !== 'string') {
    return undefined;
  }
  const clean = raw.toLowerCase().trim().replace(/^\./, '');
  return clean || undefined;
}
