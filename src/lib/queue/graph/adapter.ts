import type { PipelineTask } from '@/lib/types';
import type { JobGraph, GraphNode, NodeId } from './types';

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
          targetFormat: task.targetFormat || 'pdf',
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
          targetFormat: (task.targetFormat as any) || 'zip',
          options: task.options,
        };
        lastWasExport = false;
        break;
      }
      case 'export/url': {
        nodes[nodeId] = {
          op: 'export.url',
          input: currentInput,
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
          op: 'export.url',
          input: currentInput,
          url: task.url || 'https://storage.easyconvert.app/export',
          method: 'PUT',
        };
        lastWasExport = true;
        break;
      }
      default: {
        nodes[nodeId] = {
          op: 'convert',
          input: currentInput,
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
