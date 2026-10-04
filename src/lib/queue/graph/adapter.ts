import type { PipelineTask } from '@/lib/types';
import { assertValidLegacyTasks, JobGraphValidationError } from '@/lib/jobs/graph';
import type { JobGraph, GraphNode, NodeId } from './types';

/** Operations `linearTasksToGraph` translates. */
const QUEUE_ADAPTER_OPERATIONS: ReadonlySet<string> = new Set(['convert', 'ocr', 'optimize', 'archive', 'export/url']);

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
export function linearTasksToGraph(
  source: LinearSourceOptions,
  tasks: PipelineTask[]
): JobGraph {
  assertValidLegacyTasks(tasks, QUEUE_ADAPTER_OPERATIONS);
  const nodes: Record<NodeId, GraphNode> = {};

  const importId: NodeId = 'import_source';
  if (source.url) {
    nodes[importId] = {
      op: 'import.url',
      url: source.url,
    };
  } else {
    nodes[importId] = {
      op: 'import.upload',
      storageKey: source.storageKey || (source.filename ? `inline:${source.filename}` : 'inline'),
    };
  }

  let currentInput: NodeId = importId;
  let lastWasExport = false;

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const cleanOpName = task.operation.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
    const nodeId: NodeId = `task_${i + 1}_${cleanOpName}`;

    switch (task.operation) {
      case 'convert': {
        nodes[nodeId] = {
          op: 'convert',
          input: currentInput,
          targetFormat: task.targetFormat as string,
          options: task.options,
        };
        lastWasExport = false;
        break;
      }
      case 'ocr': {
        nodes[nodeId] = {
          op: 'ocr',
          input: currentInput,
          options: task.options,
        };
        lastWasExport = false;
        break;
      }
      case 'optimize': {
        nodes[nodeId] = {
          op: 'optimize',
          input: currentInput,
          options: task.options,
        };
        lastWasExport = false;
        break;
      }
      case 'archive': {
        nodes[nodeId] = {
          op: 'archive.create',
          input: [currentInput],
          targetFormat: task.targetFormat as 'zip',
          options: task.options,
        };
        lastWasExport = false;
        break;
      }
      case 'export/url': {
        nodes[nodeId] = {
          op: 'export.url',
          input: currentInput,
          url: task.url as string,
          method: 'PUT',
        };
        lastWasExport = true;
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
    const terminalExportId: NodeId = 'export_terminal';
    nodes[terminalExportId] = {
      op: 'export.internal',
      input: currentInput,
    };
  }

  return {
    nodes,
    failurePolicy: 'fail_fast',
  };
}
