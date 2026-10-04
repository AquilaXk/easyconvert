import path from 'node:path';
import { FORMAT_REGISTRY, getFormatByExtension } from '@/lib/registry';
import type { ConversionOptions, PipelineTask } from '@/lib/types';

export type GraphFailurePolicy = 'fail_job' | 'continue';

export interface TaskDependency {
  taskId: string;
  outputIndex?: number;
  asName?: string;
}

export interface TaskNode {
  id: string;
  operation: string;
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

const NODE_ID_REGEX = /^[a-z][a-z0-9_-]{0,63}$/;

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
function normalizeNodeEntry(id: string, raw: any): TaskNode {
  const op = raw.operation || raw.op || 'convert';
  return { ...raw, id, operation: op, op };
}

export function normalizeGraphNodes(graph: JobGraph): Record<string, TaskNode> {
  const result: Record<string, TaskNode> = {};
  if (!graph || typeof graph !== 'object') return result;

  const rawMap = graph.nodes || (!Array.isArray(graph.tasks) ? graph.tasks : undefined);
  if (rawMap && typeof rawMap === 'object') {
    for (const [id, rawNode] of Object.entries(rawMap)) {
      if (rawNode && typeof rawNode === 'object') {
        result[id] = normalizeNodeEntry(id, rawNode);
      }
    }
    return result;
  }

  if (Array.isArray(graph.tasks)) {
    graph.tasks.forEach((task, i) => {
      if (task && typeof task === 'object') {
        const id = task.id || `task_${i + 1}`;
        result[id] = normalizeNodeEntry(id, task);
      }
    });
    return result;
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
  graph: JobGraph,
  options: GraphValidationOptions = {}
): GraphValidationResult {
  const errors: GraphValidationErrorDetail[] = [];

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

    const op = node.operation || node.op || '';
    if (op === 'import.upload' || op === 'import.url' || op === 'import') {
      importCount++;
      const deps = getTaskDependencies(node);
      if (deps.length > 0) {
        errors.push({
          path: `nodes.${nodeId}.input`,
          message: `Import node "${nodeId}" cannot specify an input dependency.`,
          code: 'IMPORT_NODE_HAS_INPUT',
        });
      }
    } else if (op === 'export.url' || op === 'export.internal' || op.startsWith('export')) {
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
    const op = node.operation || node.op || '';
    const isImport = op === 'import.upload' || op === 'import.url' || op === 'import';

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
      const depOp = depNode.operation || depNode.op || '';
      if (depOp === 'export.url' || depOp === 'export.internal') {
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

  // 8. Output format inference & Format transition compatibility check
  const inferredFormats: Record<string, string> = {};

  for (const nodeId of topologicalOrder) {
    const node = nodes[nodeId];
    const op = node.operation || node.op || '';

    switch (op) {
      case 'import.upload':
      case 'import': {
        const ext =
          extractExtension(options.sourceFilename) ||
          extractExtension(node.storageKey) ||
          options.sourceFormat?.toLowerCase();
        inferredFormats[nodeId] = ext || 'binary';
        break;
      }
      case 'import.url': {
        const ext = extractExtension(node.url);
        inferredFormats[nodeId] = ext || 'binary';
        break;
      }
      case 'convert': {
        const cleanTarget = (node.targetFormat || 'pdf').toLowerCase().trim().replace(/^\./, '');
        inferredFormats[nodeId] = cleanTarget;

        const deps = getTaskDependencies(node);
        const inputId = deps[0];
        const sourceFmt = inputId ? inferredFormats[inputId] : undefined;

        if (sourceFmt && sourceFmt !== 'binary' && sourceFmt !== 'dynamic') {
          const sourceDef = FORMAT_REGISTRY[sourceFmt] || getFormatByExtension(sourceFmt);
          if (sourceDef) {
            const isSupported =
              sourceDef.targetFormats.includes(cleanTarget) ||
              sourceDef.targetFormats.includes(cleanTarget.toUpperCase()) ||
              sourceDef.id === cleanTarget;

            if (!isSupported) {
              errors.push({
                path: `nodes.${nodeId}`,
                message: `Incompatible conversion from "${sourceFmt}" to "${cleanTarget}" between node "${inputId}" and node "${nodeId}".`,
                code: 'INCOMPATIBLE_FORMAT_CONVERSION',
              });
            }
          }
        }
        break;
      }
      case 'thumbnail': {
        const thumbFormat = (node.targetFormat || node.options?.thumbnail?.format || 'jpg').toLowerCase().replace(/^\./, '');
        inferredFormats[nodeId] = thumbFormat;
        break;
      }
      case 'ocr': {
        const ocrFormat = node.options?.ocrFormat || 'pdf';
        inferredFormats[nodeId] = ocrFormat;
        break;
      }
      case 'optimize': {
        const deps = getTaskDependencies(node);
        const inputId = deps[0];
        inferredFormats[nodeId] = (inputId && inferredFormats[inputId]) || 'binary';
        break;
      }
      case 'archive.create':
      case 'archive/create':
      case 'archive': {
        inferredFormats[nodeId] = (node.targetFormat || 'zip').toLowerCase().trim();
        break;
      }
      case 'archive.extract':
      case 'archive/extract': {
        inferredFormats[nodeId] = 'dynamic';
        break;
      }
      case 'merge': {
        inferredFormats[nodeId] = (node.targetFormat || 'pdf').toLowerCase().trim();
        break;
      }
      case 'metadata': {
        inferredFormats[nodeId] = 'json';
        break;
      }
      case 'export.url':
      case 'export.internal':
      default: {
        const deps = getTaskDependencies(node);
        const firstInput = deps[0];
        inferredFormats[nodeId] = (firstInput && inferredFormats[firstInput]) || 'binary';
        break;
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    topologicalOrder: errors.length === 0 ? topologicalOrder : undefined,
    depth: computedMaxDepth,
    inferredOutputFormats: inferredFormats,
  };
}

// Backwards-compatible alias for existing callers
export const validateGraph = validateJobGraph;

/**
 * Asserts that a JobGraph is strictly valid, throwing JobGraphValidationError on failure.
 */
export function assertValidJobGraph(
  graph: JobGraph,
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
export function linearTasksToJobGraph(
  source: LinearSourceOptions,
  tasks: PipelineTask[]
): JobGraph {
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
          targetFormat: task.targetFormat || 'jpg',
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
          targetFormat: task.targetFormat || 'zip',
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
          targetFormat: task.targetFormat || 'pdf',
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
          url: task.url || 'https://example.com',
          method: 'PUT',
        };
        lastWasExport = true;
        break;
      }
      case 'export/s3':
      case 'export/gcs':
      case 'export/azure':
      case 'export/sftp':
      case 'export/webdav': {
        nodes[nodeId] = {
          id: nodeId,
          operation: 'export.url',
          op: 'export.url',
          input: currentInput,
          dependencies: [currentInput],
          url: task.url || 'https://storage.easyconvert.app/export',
          method: 'PUT',
        };
        lastWasExport = true;
        break;
      }
      case 'convert':
      default: {
        nodes[nodeId] = {
          id: nodeId,
          operation: 'convert',
          op: 'convert',
          input: currentInput,
          dependencies: [currentInput],
          targetFormat: task.targetFormat || 'pdf',
          options: task.options,
        };
        lastWasExport = false;
        break;
      }
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
