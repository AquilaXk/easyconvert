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

export function isGraphOperation(value: string): value is GraphOperation {
  return GRAPH_OPERATION_SET.has(value);
}

/**
 * How a node of each operation is charged (docs/policy-decisions.md, entry 15): `per-output` charges one unit for each
 * output, as a batch charges each file; `once` charges one unit; `free` never charges, since the node only moves files in
 * or out. A node that produced nothing charges nothing.
 */
type ChargeRule = 'per-output' | 'once' | 'free';

const CHARGE_RULES: Readonly<Record<GraphOperation, ChargeRule>> = {
  'import.upload': 'free',
  'import.url': 'free',
  convert: 'per-output',
  ocr: 'per-output',
  optimize: 'once',
  thumbnail: 'once',
  'media.package': 'once',
  watermark: 'once',
  'pdf.watermark': 'once',
  'pdf.protect': 'once',
  'pdf.unlock': 'once',
  'pdf.split-pages': 'once',
  'pdf.extract-pages': 'once',
  'pdf.delete-pages': 'once',
  'pdf.reorder-pages': 'once',
  'pdf.rotate-pages': 'once',
  merge: 'once',
  metadata: 'once',
  'archive.create': 'once',
  'archive.extract': 'once',
  'export.url': 'free',
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

/** The units a node of `op` charges once it completed with `product`; an optimize node that made nothing smaller is free. */
export function graphNodeCharge(op: string | undefined, product: GraphNodeProduct): number {
  const rule = chargeRuleOf(op);
  const gainedNothing = product.optimizations.length > 0 && product.optimizations.every((o) => !o.optimized);
  if (rule === 'free' || product.outputs === 0 || gainedNothing) return 0;
  return rule === 'per-output' ? product.outputs : 1;
}

/** The inputs a node names; a `per-output` node produces one output for each input it reads. */
function declaredInputCount(input: string | string[] | undefined): number {
  if (input === undefined) return 0;
  return Array.isArray(input) ? input.length : 1;
}

/**
 * The units a graph of `nodes` reserves when it is submitted, by the rule it is charged by: a `per-output` node one for
 * each input it declares, a `once` node one, a `free` node none. An input that holds several files (an extracted archive)
 * is charged by what was produced when the graph settles.
 */
export function graphReservationUnits(nodes: Readonly<Record<string, { op?: string; input?: string | string[] }>>): number {
  let units = 0;
  for (const node of Object.values(nodes)) {
    const rule = chargeRuleOf(node.op);
    if (rule === 'per-output') units += declaredInputCount(node.input);
    else if (rule === 'once') units += 1;
  }
  return units;
}

/** Operations whose output format must be named by the caller; none of them has a default. */
export const TARGET_FORMAT_REQUIRED_OPERATIONS: ReadonlySet<GraphOperation> = new Set<GraphOperation>([
  'convert',
  'thumbnail',
  'merge',
  'archive.create',
]);

/** Formats a thumbnail node can produce. */
export const THUMBNAIL_FORMATS: ReadonlySet<string> = new Set(['jpg', 'png']);

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
