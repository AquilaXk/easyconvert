import path from 'node:path';
import { FORMAT_REGISTRY, getFormatByExtension } from '@/lib/registry';
import type { ConversionOptions, PipelineTask } from '@/lib/types';
import {
  GRAPH_OPERATION_SET,
  IMPORT_OPERATIONS,
  EXPORT_OPERATIONS,
  TARGET_FORMAT_REQUIRED_OPERATIONS,
  RESTRICTED_OUTPUT_FORMATS,
  MERGE_FORMATS,
  FIXED_OUTPUT_FORMATS,
  canonicalGraphOperation,
  requestedTargetFormat,
  type GraphOperation,
} from './graph-operations';

export type GraphFailurePolicy = 'fail_job' | 'continue';

export interface TaskDependency {
  taskId: string;
  outputIndex?: number;
  asName?: string;
}

export interface TaskNode {
  id: string;
  /** Canonical operation after normalization (see graph-operations). */
  op?: string;
  /** Legacy field name for `op`; removed by normalization. */
  operation?: string;
  dependencies?: (string | TaskDependency)[];
  input?: string | string[];
  inputs?: string[];
  targetFormat?: string;
  options?: ConversionOptions & Record<string, any>;
  storageKey?: string;
  url?: string;
  headers?: Record<string, string>;
  method?: 'PUT' | 'POST';
  entries?: string[];
  [key: string]: any;
}

export interface JobGraph {
  nodes?: Record<string, TaskNode>;
  tasks?: Record<string, TaskNode> | TaskNode[];
  failurePolicy?: GraphFailurePolicy | 'fail_fast';
  [key: string]: any;
}

/** Graph shapes accepted for validation: raw API submissions and typed scheduler graphs. */
export type SubmittedJobGraph = JobGraph | { nodes: Record<string, object>; failurePolicy?: string };

export interface GraphValidationOptions {
  userTier?: 'free' | 'pro' | 'enterprise';
  sourceFormat?: string;
  sourceFilename?: string;
  maxNodes?: number;
  maxFanIn?: number;
  maxFanOut?: number;
  maxDepth?: number;
}

export interface GraphValidationErrorDetail {
  path: string;
  message: string;
  code: string;
}

export interface GraphValidationResult {
  valid: boolean;
  errors: GraphValidationErrorDetail[];
  topologicalOrder?: string[];
  depth?: number;
  inferredOutputFormats?: Record<string, string>;
  /** Nodes with canonical `op` names, as they must be stored and executed. Set when valid. */
  normalizedNodes?: Record<string, TaskNode>;
}

export class JobGraphValidationError extends Error {
  readonly errors: GraphValidationErrorDetail[];

  constructor(message: string, errors: GraphValidationErrorDetail[]) {
    super(message);
    this.name = 'JobGraphValidationError';
    this.errors = errors;
  }
}

// Backwards compatibility alias
export { JobGraphValidationError as GraphValidationError };

/** Canonical operations a graph node may use after normalization. */
export const SUPPORTED_GRAPH_OPERATIONS: ReadonlySet<string> = GRAPH_OPERATION_SET;

const NODE_ID_REGEX = /^[a-z][a-z0-9_-]{0,63}$/;
/** Inferred format of a node whose source format could not be determined at submission. */
const UNKNOWN_FORMAT = 'unknown';
/** Inferred format resolved only at run time (URL imports without an extension, extracted entries). */
const DYNAMIC_FORMAT = 'dynamic';

const TIER_NODE_LIMITS: Record<string, number> = {
  free: 8,
  pro: 24,
  enterprise: 32,
};

const DEFAULT_MAX_FAN_IN = 16;
const DEFAULT_MAX_FAN_OUT = 16;
const DEFAULT_MAX_DEPTH = 8;
const MAX_NODES_HARD_CEILING = 32;

function extractExtension(target: string | undefined): string | undefined {
  if (!target) return undefined;
  const clean = target.split('?')[0].split('#')[0];
  const ext = path.extname(clean).replace(/^\./, '').toLowerCase().trim();
  return ext || undefined;
}

/**
 * Normalizes any variation of JobGraph (nodes record, tasks record, or tasks array)
 * into a canonical Record<string, TaskNode>.
 */
/**
 * Rewrites a raw node to its canonical form: `op` holds the canonical operation and the legacy
 * `operation` field is dropped. Unknown names are kept as written so validation can report them;
 * a node without any operation keeps `op` undefined.
 */
function normalizeNodeEntry(id: string, raw: any): TaskNode {
  const { operation, ...rest } = raw;
  const named = raw.op ?? operation;
  return { ...rest, id, op: canonicalGraphOperation(named) ?? named };
}

/** Raw node objects keyed by id, from either `nodes`/`tasks` maps or a `tasks` array. */
function rawGraphNodeEntries(graph: JobGraph): Array<[string, any]> {
  if (!graph || typeof graph !== 'object') return [];
  const rawMap = graph.nodes || (!Array.isArray(graph.tasks) ? graph.tasks : undefined);
  if (rawMap && typeof rawMap === 'object') {
    return Object.entries(rawMap).filter(([, node]) => node && typeof node === 'object');
  }
  if (Array.isArray(graph.tasks)) {
    return graph.tasks
      .map((task, i): [string, any] => [task?.id || `task_${i + 1}`, task])
      .filter(([, task]) => task && typeof task === 'object');
  }
  return [];
}

export function normalizeGraphNodes(graph: JobGraph): Record<string, TaskNode> {
  const result: Record<string, TaskNode> = {};
  for (const [id, rawNode] of rawGraphNodeEntries(graph)) {
    result[id] = normalizeNodeEntry(id, rawNode);
  }
  return result;
}

/**
 * Extracts normalized dependency IDs for a given TaskNode.
 */
export function getTaskDependencies(node: TaskNode): string[] {
  const deps: string[] = [];

  if (Array.isArray(node.dependencies)) {
    for (const d of node.dependencies) {
      if (typeof d === 'string') {
        deps.push(d);
      } else if (d && typeof d === 'object' && typeof d.taskId === 'string') {
        deps.push(d.taskId);
      }
    }
  }

  if (Array.isArray(node.inputs)) {
    for (const inp of node.inputs) {
      if (typeof inp === 'string' && !deps.includes(inp)) {
        deps.push(inp);
      }
    }
  }

  if (node.input) {
    if (Array.isArray(node.input)) {
      for (const inp of node.input) {
        if (typeof inp === 'string' && !deps.includes(inp)) {
          deps.push(inp);
        }
      }
    } else if (typeof node.input === 'string' && !deps.includes(node.input)) {
      deps.push(node.input);
    }
  }

  return deps;
}

/**
 * Traces a cycle path in a directed graph using DFS on cyclic candidate vertices.
 */
function findCyclePath(
  adjacency: Map<string, string[]>,
  candidateNodes: Set<string>
): string[] | null {
  const visited = new Set<string>();
  const recStack: string[] = [];

  function dfs(current: string): string[] | null {
    visited.add(current);
    recStack.push(current);

    const neighbors = adjacency.get(current) || [];
    for (const next of neighbors) {
      if (!candidateNodes.has(next)) continue;

      const cycleIndex = recStack.indexOf(next);
      if (cycleIndex !== -1) {
        return [...recStack.slice(cycleIndex), next];
      }

      if (!visited.has(next)) {
        const found = dfs(next);
        if (found) return found;
      }
    }

    recStack.pop();
    return null;
  }

  for (const node of candidateNodes) {
    if (!visited.has(node)) {
      const cycle = dfs(node);
      if (cycle) return cycle;
    }
  }

  return null;
}

/**
 * Validates a DAG JobGraph using Kahn's topological sort algorithm,
 * enforcing cycle detection, dangling reference rejection, fan-in/fan-out caps,
 * depth limits, and format transition compatibility.
 */
export function validateJobGraph(
  submitted: SubmittedJobGraph,
  options: GraphValidationOptions = {}
): GraphValidationResult {
  const errors: GraphValidationErrorDetail[] = [];
  const graph = submitted as JobGraph;

  if (!graph || typeof graph !== 'object') {
    return {
      valid: false,
      errors: [
        {
          path: 'graph',
          message: 'JobGraph must be a valid object.',
          code: 'GRAPH_INVALID_STRUCTURE',
        },
      ],
    };
  }

  const nodes = normalizeGraphNodes(graph);
  const nodeEntries = Object.entries(nodes);

  for (const [nodeId, raw] of rawGraphNodeEntries(graph)) {
    if (raw.op !== undefined && raw.operation !== undefined) {
      const fromOp = canonicalGraphOperation(raw.op) ?? raw.op;
      const fromOperation = canonicalGraphOperation(raw.operation) ?? raw.operation;
      if (fromOp !== fromOperation) {
        errors.push({
          path: `nodes.${nodeId}`,
          message: `Node "${nodeId}" names two operations: op "${raw.op}" and operation "${raw.operation}".`,
          code: 'CONFLICTING_OPERATION',
        });
      }
    }
  }
  const totalNodes = nodeEntries.length;

  // 1. Empty graph check
  if (totalNodes === 0) {
    errors.push({
      path: 'nodes',
      message: 'JobGraph must contain at least two nodes (at least 1 import and 1 export).',
      code: 'GRAPH_EMPTY',
    });
    return { valid: false, errors };
  }

  // 2. Node count caps
  const userTier = options.userTier || 'pro';
  const tierLimit = options.maxNodes ?? (TIER_NODE_LIMITS[userTier] || MAX_NODES_HARD_CEILING);

  if (totalNodes > tierLimit) {
    errors.push({
      path: 'nodes',
      message: `Graph node count (${totalNodes}) exceeds the allowed limit of ${tierLimit} for tier "${userTier}".`,
      code: 'GRAPH_NODE_LIMIT_EXCEEDED',
    });
  }

  // 3. Node ID grammar validation
  for (const [nodeId] of nodeEntries) {
    if (!NODE_ID_REGEX.test(nodeId)) {
      errors.push({
        path: `nodes.${nodeId}`,
        message: `Invalid nodeId "${nodeId}". Must match ^[a-z][a-z0-9_-]{0,63}$.`,
        code: 'INVALID_NODE_ID',
      });
    }
  }

  // 4. Categorize import and export nodes
  let importCount = 0;
  let exportCount = 0;
  const adjacency = new Map<string, string[]>(); // u -> [v] (u is dependency of v)
  const incoming = new Map<string, string[]>();  // v -> [u] (v depends on u)

  for (const [nodeId, node] of nodeEntries) {
    adjacency.set(nodeId, []);
    incoming.set(nodeId, []);

    const op = node.op ?? '';
    if (!op) {
      errors.push({
        path: `nodes.${nodeId}.op`,
        message: `Node "${nodeId}" does not name an operation.`,
        code: 'MISSING_OPERATION',
      });
    } else if (!SUPPORTED_GRAPH_OPERATIONS.has(op)) {
      errors.push({
        path: `nodes.${nodeId}`,
        message: `Unsupported task operation "${op}" in node "${nodeId}".`,
        code: 'UNSUPPORTED_OPERATION',
      });
    }

    if (IMPORT_OPERATIONS.has(op as GraphOperation)) {
      importCount++;
      const deps = getTaskDependencies(node);
      if (deps.length > 0) {
        errors.push({
          path: `nodes.${nodeId}.input`,
          message: `Import node "${nodeId}" cannot specify an input dependency.`,
          code: 'IMPORT_NODE_HAS_INPUT',
        });
      }
    } else if (EXPORT_OPERATIONS.has(op as GraphOperation)) {
      exportCount++;
    }
  }

  if (importCount === 0) {
    errors.push({
      path: 'nodes',
      message: 'Graph must contain at least one import node (import.upload or import.url).',
      code: 'MISSING_IMPORT_NODE',
    });
  }

  if (exportCount === 0) {
    errors.push({
      path: 'nodes',
      message: 'Graph must contain at least one export node (export.url or export.internal).',
      code: 'MISSING_EXPORT_NODE',
    });
  }

  // 5. Validate dependency references, self-cycles, and build graphs
  const maxFanIn = options.maxFanIn ?? DEFAULT_MAX_FAN_IN;
  const maxFanOut = options.maxFanOut ?? DEFAULT_MAX_FAN_OUT;

  for (const [nodeId, node] of nodeEntries) {
    const deps = getTaskDependencies(node);
    const op = node.op ?? '';
    const isImport = IMPORT_OPERATIONS.has(op as GraphOperation);

    if (!isImport && deps.length === 0) {
      errors.push({
        path: `nodes.${nodeId}.input`,
        message: `Node "${nodeId}" of operation "${op}" requires at least one input node.`,
        code: 'MISSING_NODE_INPUT',
      });
    }

    // Fan-in check
    if (deps.length > maxFanIn) {
      errors.push({
        path: `nodes.${nodeId}`,
        message: `Single task fan-in exceeds limit of ${maxFanIn} (task "${nodeId}" has ${deps.length} incoming dependencies).`,
        code: 'FAN_IN_LIMIT_EXCEEDED',
      });
    }

    for (const depId of deps) {
      if (!nodes[depId]) {
        errors.push({
          path: `nodes.${nodeId}.input`,
          message: `Node "${nodeId}" references non-existent input node "${depId}".`,
          code: 'NON_EXISTENT_INPUT',
        });
        continue;
      }

      if (depId === nodeId) {
        errors.push({
          path: `nodes.${nodeId}.input`,
          message: `Cycle detected: ${nodeId} -> ${nodeId}`,
          code: 'SELF_CYCLE_DETECTED',
        });
        continue;
      }

      const depNode = nodes[depId];
      if (EXPORT_OPERATIONS.has(depNode.op as GraphOperation)) {
        errors.push({
          path: `nodes.${nodeId}.input`,
          message: `Node "${nodeId}" cannot use terminal export node "${depId}" as an input.`,
          code: 'EXPORT_USED_AS_INPUT',
        });
      }

      adjacency.get(depId)?.push(nodeId);
      incoming.get(nodeId)?.push(depId);
    }
  }

  // Fan-out verification: max outgoing connections per node
  for (const [nodeId, outgoingList] of adjacency.entries()) {
    if (outgoingList.length > maxFanOut) {
      errors.push({
        path: `nodes.${nodeId}`,
        message: `Single node fan-out exceeds limit of ${maxFanOut} (node "${nodeId}" has ${outgoingList.length} outgoing connections).`,
        code: 'FAN_OUT_LIMIT_EXCEEDED',
      });
    }
  }

  // If there are dangling references or self-loops, abort topological sort to avoid noise
  if (errors.some((e) => e.code === 'NON_EXISTENT_INPUT' || e.code === 'SELF_CYCLE_DETECTED')) {
    return { valid: false, errors };
  }

  // 6. Kahn's Topological Sort & Cycle Detection
  const inDegree = new Map<string, number>();
  for (const [nodeId] of nodeEntries) {
    inDegree.set(nodeId, incoming.get(nodeId)?.length || 0);
  }

  const queue: string[] = [];
  for (const [nodeId, deg] of inDegree.entries()) {
    if (deg === 0) {
      queue.push(nodeId);
    }
  }

  const topologicalOrder: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    topologicalOrder.push(current);

    const neighbors = adjacency.get(current) || [];
    for (const next of neighbors) {
      const remaining = (inDegree.get(next) || 0) - 1;
      inDegree.set(next, remaining);
      if (remaining === 0) {
        queue.push(next);
      }
    }
  }

  if (topologicalOrder.length < totalNodes) {
    // Cycle detected: isolate vertices with inDegree > 0
    const cyclicCandidates = new Set<string>();
    for (const [nodeId, deg] of inDegree.entries()) {
      if (deg > 0) {
        cyclicCandidates.add(nodeId);
      }
    }

    const cyclePath = findCyclePath(adjacency, cyclicCandidates);
    const cycleStr = cyclePath ? cyclePath.join(' -> ') : Array.from(cyclicCandidates).join(', ');

    errors.push({
      path: 'nodes',
      message: `Cycle detected in job graph: ${cycleStr}`,
      code: 'CYCLE_DETECTED',
    });

    return { valid: false, errors };
  }

  // 7. Graph Depth Calculation
  const maxAllowedDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const nodeDepths = new Map<string, number>();
  let computedMaxDepth = 1;

  for (const nodeId of topologicalOrder) {
    const inputs = incoming.get(nodeId) || [];
    if (inputs.length === 0) {
      nodeDepths.set(nodeId, 1);
    } else {
      const maxInputDepth = Math.max(...inputs.map((inp) => nodeDepths.get(inp) || 1));
      const currentDepth = maxInputDepth + 1;
      nodeDepths.set(nodeId, currentDepth);
      if (currentDepth > computedMaxDepth) {
        computedMaxDepth = currentDepth;
      }
    }
  }

  if (computedMaxDepth > maxAllowedDepth) {
    errors.push({
      path: 'nodes',
      message: `Graph depth exceeds limit of ${maxAllowedDepth} (found depth ${computedMaxDepth}).`,
      code: 'DEPTH_LIMIT_EXCEEDED',
    });
  }

  // 8. Output format inference & Format transition compatibility check. No format is assumed:
  // operations that need one must name it, and a source whose format cannot be determined at
  // submission is either rejected (uploads) or left to the runtime check (URL and extract output).
  const inferredFormats: Record<string, string> = {};
  const firstInputFormat = (node: TaskNode): string => {
    const inputId = getTaskDependencies(node)[0];
    return (inputId && inferredFormats[inputId]) || UNKNOWN_FORMAT;
  };

  for (const nodeId of topologicalOrder) {
    const node = nodes[nodeId];
    const op = node.op as GraphOperation;
    const target = requestedTargetFormat(node);

    if (TARGET_FORMAT_REQUIRED_OPERATIONS.has(op) && !target) {
      errors.push({
        path: `nodes.${nodeId}.targetFormat`,
        message: `Operation "${op}" in node "${nodeId}" requires a targetFormat.`,
        code: 'MISSING_TARGET_FORMAT',
      });
    }
    const allowedTargets = RESTRICTED_OUTPUT_FORMATS[op];
    if (target && allowedTargets && !allowedTargets.has(target)) {
      errors.push({
        path: `nodes.${nodeId}.targetFormat`,
        message: `Operation "${op}" in node "${nodeId}" cannot produce "${target}"; supported: ${[...allowedTargets].join(', ')}.`,
        code: 'UNSUPPORTED_OUTPUT_FORMAT',
      });
    }
    if (op === 'merge' && target && MERGE_FORMATS.has(target)) {
      for (const inputId of getTaskDependencies(node)) {
        const inputFormat = inferredFormats[inputId];
        if (inputFormat && inputFormat !== DYNAMIC_FORMAT && inputFormat !== target) {
          errors.push({
            path: `nodes.${nodeId}.input`,
            message: `Merge node "${nodeId}" produces "${target}" but input "${inputId}" is "${inputFormat}".`,
            code: 'INCOMPATIBLE_MERGE_INPUT',
          });
        }
      }
    }

    switch (op) {
      case 'import.upload': {
        inferredFormats[nodeId] =
          extractExtension(options.sourceFilename) ||
          extractExtension(node.storageKey) ||
          options.sourceFormat?.toLowerCase() ||
          UNKNOWN_FORMAT;
        break;
      }
      case 'import.url': {
        inferredFormats[nodeId] = extractExtension(node.url) || DYNAMIC_FORMAT;
        break;
      }
      case 'archive.extract': {
        inferredFormats[nodeId] = DYNAMIC_FORMAT;
        break;
      }
      case 'convert': {
        inferredFormats[nodeId] = target ?? UNKNOWN_FORMAT;
        if (target) {
          checkConversion(nodeId, getTaskDependencies(node)[0], firstInputFormat(node), target, errors);
        }
        break;
      }
      case 'ocr': {
        const fixed = FIXED_OUTPUT_FORMATS.ocr as string;
        const requested = node.options?.ocrFormat;
        if (requested !== undefined && requested !== fixed) {
          errors.push({
            path: `nodes.${nodeId}.options.ocrFormat`,
            message: `OCR node "${nodeId}" produces "${fixed}"; ocrFormat "${requested}" is not supported.`,
            code: 'UNSUPPORTED_OUTPUT_FORMAT',
          });
        }
        inferredFormats[nodeId] = fixed;
        break;
      }
      case 'metadata': {
        inferredFormats[nodeId] = FIXED_OUTPUT_FORMATS.metadata as string;
        break;
      }
      case 'thumbnail':
      case 'merge':
      case 'archive.create': {
        inferredFormats[nodeId] = target ?? UNKNOWN_FORMAT;
        break;
      }
      default: {
        // Pass-through operations (optimize, watermark, protect, export) keep their input format.
        inferredFormats[nodeId] = firstInputFormat(node);
        break;
      }
    }
  }

  const valid = errors.length === 0;
  return {
    valid,
    errors,
    topologicalOrder: valid ? topologicalOrder : undefined,
    depth: computedMaxDepth,
    inferredOutputFormats: inferredFormats,
    normalizedNodes: valid ? nodes : undefined,
  };
}

/** Records why a convert node cannot run on its input format, if it cannot. */
function checkConversion(
  nodeId: string,
  inputId: string | undefined,
  sourceFmt: string,
  target: string,
  errors: GraphValidationErrorDetail[]
): void {
  const targetDef = FORMAT_REGISTRY[target] || getFormatByExtension(target);
  if (!targetDef) {
    errors.push({
      path: `nodes.${nodeId}`,
      message: `Unknown or unsupported target format "${target}" in convert node "${nodeId}".`,
      code: 'UNKNOWN_TARGET_FORMAT',
    });
  }
  if (sourceFmt === DYNAMIC_FORMAT) {
    return;
  }
  if (sourceFmt === UNKNOWN_FORMAT) {
    errors.push({
      path: `nodes.${nodeId}`,
      message: `Cannot determine the source format of node "${inputId}" for convert node "${nodeId}"; provide a filename extension or sourceFormat.`,
      code: 'SOURCE_FORMAT_UNKNOWN',
    });
    return;
  }
  const sourceDef = FORMAT_REGISTRY[sourceFmt] || getFormatByExtension(sourceFmt);
  if (!sourceDef) {
    errors.push({
      path: `nodes.${nodeId}`,
      message: `Unknown source format "${sourceFmt}" from node "${inputId}" for convert node "${nodeId}".`,
      code: 'UNKNOWN_SOURCE_FORMAT',
    });
    return;
  }
  const isSupported =
    sourceDef.targetFormats.includes(target) ||
    sourceDef.targetFormats.includes(target.toUpperCase()) ||
    sourceDef.id === target;
  if (!isSupported) {
    errors.push({
      path: `nodes.${nodeId}`,
      message: `Incompatible conversion from "${sourceFmt}" to "${target}" between node "${inputId}" and node "${nodeId}".`,
      code: 'INCOMPATIBLE_FORMAT_CONVERSION',
    });
  }
}

// Backwards-compatible alias for existing callers
export const validateGraph = validateJobGraph;

/**
 * Asserts that a JobGraph is strictly valid, throwing JobGraphValidationError on failure.
 */
export function assertValidJobGraph(
  graph: SubmittedJobGraph,
  options: GraphValidationOptions = {}
): asserts graph is JobGraph {
  const result = validateJobGraph(graph, options);
  if (!result.valid) {
    const summary = result.errors.map((e) => `[${e.code}] ${e.message}`).join('; ');
    throw new JobGraphValidationError(`JobGraph validation failed: ${summary}`, result.errors);
  }
}

export const assertValidGraph = assertValidJobGraph;

export interface LinearSourceOptions {
  storageKey?: string;
  url?: string;
  sourceFormat?: string;
  filename?: string;
}

/**
 * Transforms a linear legacy tasks array into a formal DAG JobGraph.
 * Guarantees that Kahn's topological sort reproduces the exact original sequential order.
 */
/** Storage-provider exports: the graph executor has no node for them, so pipelines reject them. */
const LEGACY_PROVIDER_EXPORTS: ReadonlySet<string> = new Set([
  'export/s3',
  'export/gcs',
  'export/azure',
  'export/sftp',
  'export/webdav',
]);

/** Legacy operations whose output format must be given explicitly. */
const LEGACY_TARGET_REQUIRED: ReadonlySet<string> = new Set([
  'convert',
  'archive',
  'archive/create',
  'archive.create',
  'thumbnail',
  'media.thumbnail',
  'merge',
]);

/** Operations `linearTasksToJobGraph` translates. */
export const LEGACY_TASK_OPERATIONS: ReadonlySet<string> = new Set([
  'convert',
  'ocr',
  'optimize',
  'thumbnail',
  'media.thumbnail',
  'archive',
  'archive/create',
  'archive.create',
  'merge',
  'metadata',
  'export/url',
]);

/**
 * Rejects legacy tasks that would otherwise need an invented value: a destination URL, a target
 * format, or a different operation. Throws JobGraphValidationError listing every problem.
 */
export function assertValidLegacyTasks(tasks: PipelineTask[], supported: ReadonlySet<string>): void {
  const errors: GraphValidationErrorDetail[] = [];
  tasks.forEach((task, i) => {
    const path = `tasks[${i}]`;
    const op = String(task?.operation ?? '');
    if (LEGACY_PROVIDER_EXPORTS.has(op)) {
      errors.push({
        path,
        code: 'BYOS_OPERATION_UNSUPPORTED',
        message: `Operation "${op}" cannot run in a pipeline; use export/url with a signed destination URL.`,
      });
    } else if (!supported.has(op)) {
      errors.push({ path, code: 'UNSUPPORTED_OPERATION', message: `Unsupported pipeline operation "${op}".` });
    } else if (op === 'export/url' && !task.url) {
      errors.push({ path: `${path}.url`, code: 'MISSING_EXPORT_URL', message: 'export/url requires a destination export URL.' });
    } else if (LEGACY_TARGET_REQUIRED.has(op) && !task.targetFormat) {
      errors.push({
        path: `${path}.targetFormat`,
        code: 'MISSING_TARGET_FORMAT',
        message: `Operation "${op}" requires a targetFormat.`,
      });
    }
  });
  if (errors.length > 0) {
    throw new JobGraphValidationError(`Invalid pipeline tasks: ${errors.map((e) => e.message).join(' ')}`, errors);
  }
}

export function linearTasksToJobGraph(
  source: LinearSourceOptions,
  tasks: PipelineTask[]
): JobGraph {
  assertValidLegacyTasks(tasks, LEGACY_TASK_OPERATIONS);
  const nodes: Record<string, TaskNode> = {};

  const importId = 'import_source';
  if (source.url) {
    nodes[importId] = {
      id: importId,
      operation: 'import.url',
      op: 'import.url',
      url: source.url,
    };
  } else {
    nodes[importId] = {
      id: importId,
      operation: 'import.upload',
      op: 'import.upload',
      storageKey: source.storageKey || (source.filename ? `inline:${source.filename}` : 'inline'),
    };
  }

  let currentInput = importId;
  let lastWasExport = false;

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const cleanOpName = task.operation.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
    const nodeId = `task_${i + 1}_${cleanOpName}`;

    switch (task.operation as any) {
      case 'ocr': {
        nodes[nodeId] = {
          id: nodeId,
          operation: 'ocr',
          op: 'ocr',
          input: currentInput,
          dependencies: [currentInput],
          options: task.options,
        };
        lastWasExport = false;
        break;
      }
      case 'optimize': {
        nodes[nodeId] = {
          id: nodeId,
          operation: 'optimize',
          op: 'optimize',
          input: currentInput,
          dependencies: [currentInput],
          options: task.options,
        };
        lastWasExport = false;
        break;
      }
      case 'thumbnail':
      case 'media.thumbnail': {
        nodes[nodeId] = {
          id: nodeId,
          operation: 'thumbnail',
          op: 'thumbnail',
          input: currentInput,
          dependencies: [currentInput],
          targetFormat: task.targetFormat as string,
          options: task.options,
        };
        lastWasExport = false;
        break;
      }
      case 'archive':
      case 'archive/create':
      case 'archive.create': {
        nodes[nodeId] = {
          id: nodeId,
          operation: 'archive/create',
          op: 'archive.create',
          input: [currentInput],
          dependencies: [currentInput],
          targetFormat: task.targetFormat as string,
          options: task.options,
        };
        lastWasExport = false;
        break;
      }
      case 'merge': {
        nodes[nodeId] = {
          id: nodeId,
          operation: 'merge',
          op: 'merge',
          input: [currentInput],
          dependencies: [currentInput],
          targetFormat: task.targetFormat as string,
          options: task.options,
        };
        lastWasExport = false;
        break;
      }
      case 'metadata': {
        nodes[nodeId] = {
          id: nodeId,
          operation: 'metadata',
          op: 'metadata',
          input: currentInput,
          dependencies: [currentInput],
          options: task.options,
        };
        lastWasExport = false;
        break;
      }
      case 'export/url': {
        nodes[nodeId] = {
          id: nodeId,
          operation: 'export.url',
          op: 'export.url',
          input: currentInput,
          dependencies: [currentInput],
          url: task.url as string,
          method: 'PUT',
        };
        lastWasExport = true;
        break;
      }
      case 'convert': {
        nodes[nodeId] = {
          id: nodeId,
          operation: 'convert',
          op: 'convert',
          input: currentInput,
          dependencies: [currentInput],
          targetFormat: task.targetFormat as string,
          options: task.options,
        };
        lastWasExport = false;
        break;
      }
      default:
        // Unreachable: assertValidLegacyTasks rejects every other operation.
        throw new JobGraphValidationError(`Unsupported pipeline operation "${task.operation}".`, []);
    }

    currentInput = nodeId;
  }

  // Ensure graph contains at least one export node
  if (!lastWasExport) {
    const terminalExportId = 'export_terminal';
    nodes[terminalExportId] = {
      id: terminalExportId,
      operation: 'export.internal',
      op: 'export.internal',
      input: currentInput,
      dependencies: [currentInput],
    };
  }

  return {
    nodes,
    failurePolicy: 'fail_job',
  };
}

export const linearTasksToGraph = linearTasksToJobGraph;
