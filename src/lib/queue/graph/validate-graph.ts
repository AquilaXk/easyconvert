import path from 'node:path';
import { FORMAT_REGISTRY, getFormatByExtension } from '@/lib/registry';
import type {
  JobGraph,
  GraphNode,
  NodeId,
  ValidateGraphOptions,
  GraphValidationErrorDetail,
  GraphValidationResult,
} from './types';

export class GraphValidationError extends Error {
  readonly errors: GraphValidationErrorDetail[];

  constructor(message: string, errors: GraphValidationErrorDetail[]) {
    super(message);
    this.name = 'GraphValidationError';
    this.errors = errors;
  }
}

const NODE_ID_REGEX = /^[a-z][a-z0-9_-]{0,63}$/;

const TIER_NODE_LIMITS: Record<string, number> = {
  free: 8,
  pro: 24,
  enterprise: 32,
};

const MAX_FAN_OUT = 16;
const MAX_DEPTH = 8;
const MAX_NODES_HARD_CEILING = 32;

function extractExtension(target: string | undefined): string | undefined {
  if (!target) return undefined;
  const clean = target.split('?')[0].split('#')[0];
  const ext = path.extname(clean).replace(/^\./, '').toLowerCase().trim();
  return ext || undefined;
}

export function getNodeInputs(node: GraphNode): NodeId[] {
  if ('input' in node && node.input) {
    if (Array.isArray(node.input)) {
      return node.input;
    }
    return [node.input];
  }
  return [];
}

/**
 * Traces a cycle path in a directed graph using DFS on remaining cyclic vertices.
 */
function findCyclePath(
  adjacency: Map<NodeId, NodeId[]>,
  candidateNodes: Set<NodeId>
): NodeId[] | null {
  const visited = new Set<NodeId>();
  const recStack: NodeId[] = [];

  function dfs(current: NodeId): NodeId[] | null {
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

export function validateGraph(
  graph: JobGraph,
  options: ValidateGraphOptions = {}
): GraphValidationResult {
  const errors: GraphValidationErrorDetail[] = [];

  if (!graph || typeof graph !== 'object' || !graph.nodes || typeof graph.nodes !== 'object') {
    return {
      valid: false,
      errors: [
        {
          path: 'nodes',
          message: 'JobGraph must contain a valid "nodes" record object.',
          code: 'GRAPH_INVALID_STRUCTURE',
        },
      ],
    };
  }

  const nodeEntries = Object.entries(graph.nodes);
  const totalNodes = nodeEntries.length;

  // 1. Tier & node count limits
  const userTier = options.userTier || 'pro';
  const tierLimit = options.maxNodes ?? (TIER_NODE_LIMITS[userTier] || MAX_NODES_HARD_CEILING);

  if (totalNodes === 0) {
    errors.push({
      path: 'nodes',
      message: 'JobGraph must contain at least two nodes (at least 1 import and 1 export).',
      code: 'GRAPH_EMPTY',
    });
    return { valid: false, errors };
  }

  if (totalNodes > tierLimit) {
    errors.push({
      path: 'nodes',
      message: `Graph node count (${totalNodes}) exceeds the allowed limit of ${tierLimit} for tier "${userTier}".`,
      code: 'GRAPH_NODE_LIMIT_EXCEEDED',
    });
  }

  // 2. Validate NodeId naming format
  for (const [nodeId] of nodeEntries) {
    if (!NODE_ID_REGEX.test(nodeId)) {
      errors.push({
        path: `nodes.${nodeId}`,
        message: `Invalid nodeId "${nodeId}". Must match ^[a-z][a-z0-9_-]{0,63}$.`,
        code: 'INVALID_NODE_ID',
      });
    }
  }

  // 3. Categorize import and export nodes
  let importCount = 0;
  let exportCount = 0;
  const adjacency = new Map<NodeId, NodeId[]>(); // u -> v (u is input to v)
  const incoming = new Map<NodeId, NodeId[]>();  // v -> u (u is input to v)

  for (const [nodeId, node] of nodeEntries) {
    adjacency.set(nodeId, []);
    incoming.set(nodeId, []);

    if (node.op === 'import.upload' || node.op === 'import.url') {
      importCount++;
      if ('input' in node && (node as any).input) {
        errors.push({
          path: `nodes.${nodeId}.input`,
          message: `Import node "${nodeId}" cannot specify an input dependency.`,
          code: 'IMPORT_NODE_HAS_INPUT',
        });
      }
    } else if (node.op === 'export.url' || node.op === 'export.internal') {
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

  // 4. Validate input references and build adjacency graph
  for (const [nodeId, node] of nodeEntries) {
    const inputs = getNodeInputs(node);

    if (node.op !== 'import.upload' && node.op !== 'import.url' && inputs.length === 0) {
      errors.push({
        path: `nodes.${nodeId}.input`,
        message: `Node "${nodeId}" of operation "${node.op}" requires at least one input node.`,
        code: 'MISSING_NODE_INPUT',
      });
    }

    for (const inputNodeId of inputs) {
      if (!graph.nodes[inputNodeId]) {
        errors.push({
          path: `nodes.${nodeId}.input`,
          message: `Node "${nodeId}" references non-existent input node "${inputNodeId}".`,
          code: 'NON_EXISTENT_INPUT',
        });
        continue;
      }

      if (inputNodeId === nodeId) {
        errors.push({
          path: `nodes.${nodeId}.input`,
          message: `Cycle detected: ${nodeId} -> ${nodeId}`,
          code: 'SELF_CYCLE_DETECTED',
        });
        continue;
      }

      const inputNode = graph.nodes[inputNodeId];
      if (inputNode.op === 'export.url' || inputNode.op === 'export.internal') {
        errors.push({
          path: `nodes.${nodeId}.input`,
          message: `Node "${nodeId}" cannot use terminal export node "${inputNodeId}" as an input.`,
          code: 'EXPORT_USED_AS_INPUT',
        });
      }

      adjacency.get(inputNodeId)?.push(nodeId);
      incoming.get(nodeId)?.push(inputNodeId);
    }
  }

  // 5. Fan-out verification: max 16 outgoing connections per node
  for (const [nodeId, outgoingList] of adjacency.entries()) {
    if (outgoingList.length > MAX_FAN_OUT) {
      errors.push({
        path: `nodes.${nodeId}`,
        message: `Single node fan-out exceeds limit of ${MAX_FAN_OUT} (node "${nodeId}" has ${outgoingList.length} outgoing connections).`,
        code: 'FAN_OUT_LIMIT_EXCEEDED',
      });
    }
  }

  // If there are structural/reference errors, abort topological sort to avoid secondary noise
  if (errors.some((e) => e.code === 'NON_EXISTENT_INPUT' || e.code === 'SELF_CYCLE_DETECTED')) {
    return { valid: false, errors };
  }

  // 6. Kahn's Topological Sort & Cycle Detection
  const inDegree = new Map<NodeId, number>();
  for (const [nodeId] of nodeEntries) {
    inDegree.set(nodeId, incoming.get(nodeId)?.length || 0);
  }

  const queue: NodeId[] = [];
  for (const [nodeId, deg] of inDegree.entries()) {
    if (deg === 0) {
      queue.push(nodeId);
    }
  }

  const topologicalOrder: NodeId[] = [];

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
    const cyclicCandidates = new Set<NodeId>();
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
  const nodeDepths = new Map<NodeId, number>();
  let maxDepth = 1;

  for (const nodeId of topologicalOrder) {
    const inputs = incoming.get(nodeId) || [];
    if (inputs.length === 0) {
      nodeDepths.set(nodeId, 1);
    } else {
      const maxInputDepth = Math.max(...inputs.map((inp) => nodeDepths.get(inp) || 1));
      const currentDepth = maxInputDepth + 1;
      nodeDepths.set(nodeId, currentDepth);
      if (currentDepth > maxDepth) {
        maxDepth = currentDepth;
      }
    }
  }

  if (maxDepth > MAX_DEPTH) {
    errors.push({
      path: 'nodes',
      message: `Graph depth exceeds limit of ${MAX_DEPTH} (found depth ${maxDepth}).`,
      code: 'DEPTH_LIMIT_EXCEEDED',
    });
  }

  // 8. Output format inference & Format compatibility check
  const inferredFormats: Record<NodeId, string> = {};

  for (const nodeId of topologicalOrder) {
    const node = graph.nodes[nodeId];

    switch (node.op) {
      case 'import.upload': {
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
        const cleanTarget = node.targetFormat.toLowerCase().trim().replace(/^\./, '');
        inferredFormats[nodeId] = cleanTarget;

        const inputId = node.input;
        const sourceFmt = inferredFormats[inputId];

        if (sourceFmt && sourceFmt !== 'binary' && sourceFmt !== 'dynamic') {
          const sourceDef = FORMAT_REGISTRY[sourceFmt] || getFormatByExtension(sourceFmt);
          if (sourceDef) {
            const isSupported =
              sourceDef.targetFormats.includes(cleanTarget) ||
              sourceDef.targetFormats.includes(cleanTarget.toUpperCase());

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
      case 'ocr': {
        const ocrFormat = node.options?.ocrFormat || 'pdf';
        inferredFormats[nodeId] = ocrFormat;
        break;
      }
      case 'optimize': {
        const inputId = node.input;
        inferredFormats[nodeId] = inferredFormats[inputId] || 'binary';
        break;
      }
      case 'archive.create': {
        inferredFormats[nodeId] = node.targetFormat.toLowerCase().trim();
        break;
      }
      case 'archive.extract': {
        // Dynamic output format, resolved at runtime
        inferredFormats[nodeId] = 'dynamic';
        break;
      }
      case 'export.url':
      case 'export.internal': {
        const firstInput = Array.isArray(node.input) ? node.input[0] : node.input;
        inferredFormats[nodeId] = inferredFormats[firstInput] || 'binary';
        break;
      }
      default:
        inferredFormats[nodeId] = 'binary';
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    topologicalOrder,
    depth: maxDepth,
    inferredOutputFormats: inferredFormats,
  };
}

export function assertValidGraph(
  graph: JobGraph,
  options: ValidateGraphOptions = {}
): GraphValidationResult {
  const result = validateGraph(graph, options);
  if (!result.valid) {
    const mainMsg = result.errors[0]?.message || 'Graph validation failed.';
    throw new GraphValidationError(mainMsg, result.errors);
  }
  return result;
}
