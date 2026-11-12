/**
 * Single source of truth for job graph node operations: the canonical names the node executor
 * runs, the legacy spellings accepted at the API and rewritten to them, and per-operation rules.
 */

export const GRAPH_OPERATIONS = [
  'import.upload',
  'import.url',
  'import.s3',
  'import.sftp',
  'convert',
  'ocr',
  'optimize',
  'thumbnail',
  'media.package',
  'watermark',
  'pdf.watermark',
  'pdf.protect',
  'pdf.unlock',
  'pdf.split-pages',
  'pdf.extract-pages',
  'pdf.delete-pages',
  'pdf.reorder-pages',
  'pdf.rotate-pages',
  'merge',
  'metadata',
  'metadata.write',
  'capture.website',
  'archive.create',
  'archive.extract',
  'export.url',
  'export.s3',
  'export.sftp',
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

export const IMPORT_OPERATIONS: ReadonlySet<GraphOperation> = new Set<GraphOperation>(['import.upload', 'import.url', 'import.s3', 'import.sftp']);
/** Operations that make files from nothing the graph holds: an import brings a file in, a website capture draws a page. They take no input. */
export const SOURCE_OPERATIONS: ReadonlySet<GraphOperation> = new Set<GraphOperation>([...IMPORT_OPERATIONS, 'capture.website']);
export const EXPORT_OPERATIONS: ReadonlySet<GraphOperation> = new Set<GraphOperation>(['export.url', 'export.s3', 'export.sftp', 'export.internal']);

/** Imports that read from the customer's own store, named by a saved credential or by credentials sealed with the node. */
export const STORAGE_IMPORT_OPERATIONS: ReadonlySet<string> = new Set(['import.s3', 'import.sftp']);
/** Exports that write to the customer's own store. */
export const STORAGE_EXPORT_OPERATIONS: ReadonlySet<string> = new Set(['export.s3', 'export.sftp']);

export function isGraphOperation(value: string): value is GraphOperation {
  return GRAPH_OPERATION_SET.has(value);
}

/**
 * How a node of each operation is charged (docs/policy-decisions.md, entry 15). An operation that runs once for each input
 * and makes one output of it charges `per-output`, as a batch charges each file; an optimize node charges only the outputs
 * it made smaller (`per-gained-output`). An operation that does one job over all its inputs (a merge, the metadata of its
 * first input, an archive made or unpacked) charges `once`. `free` never charges, since the node only moves files in or
 * out. A node that produced nothing charges nothing.
 */
type ChargeRule = 'per-output' | 'per-gained-output' | 'once' | 'free';

const CHARGE_RULES: Readonly<Record<GraphOperation, ChargeRule>> = {
  'import.upload': 'free',
  'import.url': 'free',
  'import.s3': 'free',
  'import.sftp': 'free',
  convert: 'per-output',
  ocr: 'per-output',
  optimize: 'per-gained-output',
  thumbnail: 'per-output',
  'media.package': 'per-output',
  watermark: 'per-output',
  'pdf.watermark': 'per-output',
  'pdf.protect': 'per-output',
  'pdf.unlock': 'per-output',
  'pdf.split-pages': 'per-output',
  'pdf.extract-pages': 'per-output',
  'pdf.delete-pages': 'per-output',
  'pdf.reorder-pages': 'per-output',
  'pdf.rotate-pages': 'per-output',
  merge: 'once',
  metadata: 'once',
  'metadata.write': 'per-output',
  'capture.website': 'once',
  'archive.create': 'once',
  'archive.extract': 'once',
  'export.url': 'free',
  'export.s3': 'free',
  'export.sftp': 'free',
  'export.internal': 'free',
};

function chargeRuleOf(op: string | undefined): ChargeRule {
  if (op === undefined || !isGraphOperation(op)) {
    throw new TypeError(`Graph operation "${op}" has no charge rule.`);
  }
  return CHARGE_RULES[op];
}

/** What a node produced when it ended: its outputs, and for an optimize node whether each artifact was made smaller. */
export interface GraphNodeProduct {
  outputs: number;
  optimizations: ReadonlyArray<{ optimized: boolean }>;
}

/** The units a node of `op` charges once it completed with `product`. */
export function graphNodeCharge(op: string | undefined, product: GraphNodeProduct): number {
  switch (chargeRuleOf(op)) {
    case 'per-output':
      return product.outputs;
    case 'per-gained-output':
      return product.optimizations.filter((o) => o.optimized).length;
    case 'once':
      return product.outputs > 0 ? 1 : 0;
    case 'free':
      return 0;
  }
}

/** The inputs a node names. */
function declaredInputCount(input: string | string[] | undefined): number {
  if (input === undefined) return 0;
  return Array.isArray(input) ? input.length : 1;
}

/**
 * The units a node of `op` that names `input` reserves when its graph is submitted, by the rule it is charged by: a node
 * charged per output one for each input it declares (the most it charges when each input holds one file), a `once` node
 * one, a `free` node none.
 */
export function graphNodeReservedUnits(node: { op?: string; input?: string | string[] }): number {
  const rule = chargeRuleOf(node.op);
  if (rule === 'per-output' || rule === 'per-gained-output') return declaredInputCount(node.input);
  return rule === 'once' ? 1 : 0;
}

/**
 * Whether a node of `op` is charged for each output, so that an input holding several files (an unpacked archive) makes
 * it charge more than it reserved.
 */
export function isChargedPerOutput(op: string | undefined): boolean {
  const rule = chargeRuleOf(op);
  return rule === 'per-output' || rule === 'per-gained-output';
}

/**
 * The units a graph of `nodes` reserves when it is submitted (`graphNodeReservedUnits`). A node whose inputs hold more
 * files than it declares adds the rest to the reservation when it starts.
 */
export function graphReservationUnits(nodes: Readonly<Record<string, { op?: string; input?: string | string[] }>>): number {
  let units = 0;
  for (const node of Object.values(nodes)) units += graphNodeReservedUnits(node);
  return units;
}

/** Operations whose output format must be named by the caller; none of them has a default. */
export const TARGET_FORMAT_REQUIRED_OPERATIONS: ReadonlySet<GraphOperation> = new Set<GraphOperation>([
  'convert',
  'thumbnail',
  'merge',
  'archive.create',
  'capture.website',
]);

/** Formats a thumbnail node can produce. */
export const THUMBNAIL_FORMATS: ReadonlySet<string> = new Set(['jpg', 'png', 'webp']);

/** Formats a capture.website node can produce. */
export const CAPTURE_FORMATS_LIST: readonly string[] = ['pdf', 'png', 'jpg'];

/** Formats a metadata.write node can write into without changing more than the metadata of the file. */
export const METADATA_WRITE_FORMATS: readonly string[] = ['jpg', 'jpeg', 'png', 'pdf'];

/** Fewest distinct inputs a merge node needs; with one input there is nothing to merge. */
export const MIN_MERGE_INPUTS = 2;

/** Formats a merge node can produce; every input must already be in that format. */
export const MERGE_FORMATS: ReadonlySet<string> = new Set(['pdf', 'txt']);

/** Archive formats an archive.create node can produce. */
export const ARCHIVE_CREATE_FORMATS: ReadonlySet<string> = new Set(['zip', 'tar', 'tar.gz', '7z']);

/** Output of a media.package node: the playlist or manifest and every segment, in one ZIP. */
export const MEDIA_PACKAGE_OUTPUT_FORMAT = 'zip';

/** Output of a pdf.split-pages node: the parts, one PDF each, in one ZIP. */
export const PDF_SPLIT_OUTPUT_FORMAT = 'zip';

/** Allowed output formats for operations limited to a fixed set. */
export const RESTRICTED_OUTPUT_FORMATS: Readonly<Partial<Record<GraphOperation, ReadonlySet<string>>>> = {
  thumbnail: THUMBNAIL_FORMATS,
  'capture.website': new Set(CAPTURE_FORMATS_LIST),
  merge: MERGE_FORMATS,
  'archive.create': ARCHIVE_CREATE_FORMATS,
  'media.package': new Set([MEDIA_PACKAGE_OUTPUT_FORMAT]),
};

/** Output format of operations that always produce the same format. */
export const FIXED_OUTPUT_FORMATS: Readonly<Partial<Record<GraphOperation, string>>> = {
  ocr: 'pdf',
  metadata: 'json',
  'media.package': MEDIA_PACKAGE_OUTPUT_FORMAT,
  'pdf.split-pages': PDF_SPLIT_OUTPUT_FORMAT,
};

/** Returns the canonical operation for a canonical or legacy name, or undefined when unknown. */
export function canonicalGraphOperation(raw: unknown): GraphOperation | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  if (isGraphOperation(raw)) {
    return raw;
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
