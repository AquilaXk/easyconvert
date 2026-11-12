import path from 'node:path';
import type { GraphExecutionState, GraphNodeState, NodeExecutionStatus } from '@/lib/queue/graph/scheduler-types';
import { redactText } from '@/lib/security/redact';
import { STORAGE_EXPORT_OPERATIONS } from './graph-operations';
import { exportDestination, exportedFileNames } from './storage-export-names';
import { publicOperationName } from './named-tasks';

/** What a task is doing, as the job reports it by name. */
export type TaskStatus = 'waiting' | 'active' | 'completed' | 'failed' | 'cancelled';

/** The `error.code` of a task that failed on its own without a more specific cause. */
export const TASK_FAILED_CODE = 'task_failed';
/** The `error.code` of a task that did not run because a task it reads failed. */
export const DEPENDENCY_FAILED_CODE = 'dependency_failed';

/** Most files one task lists in its result; `fileCount` is the number it made. */
export const MAX_TASK_RESULT_FILES = 100;

export interface TaskReport {
  operation: string;
  status: TaskStatus;
  /** The names of the tasks it reads. */
  input?: string[];
  startedAt?: number;
  finishedAt?: number;
  /** The files an export task keeps for download (`downloadUrl`), or wrote to the customer's store (`destination`). */
  result?: { files: Array<{ filename: string; downloadUrl?: string; destination?: string }>; fileCount: number };
  error?: { code: string; message: string; task?: string };
}

const STATUS_OF_NODE: Readonly<Record<NodeExecutionStatus, TaskStatus>> = {
  pending: 'waiting',
  waiting: 'waiting',
  active: 'active',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  skipped: 'cancelled',
};

/** The names a node reads, from its `input`. */
function inputNames(node: GraphExecutionState['graph']['nodes'][string]): string[] {
  const input = 'input' in node ? node.input : undefined;
  if (input === undefined) return [];
  return Array.isArray(input) ? input : [input];
}

/** The files an export task kept: its outputs under `results/<graphId>/`, which a caller may download. */
function keptFiles(state: GraphExecutionState, node: GraphNodeState): TaskReport['result'] {
  const keys = node.outputs.filter((key) => key.startsWith(`results/${state.graphId}/`));
  return {
    files: keys.slice(0, MAX_TASK_RESULT_FILES).map((key) => ({ filename: path.posix.basename(key), downloadUrl: `/api/storage/file/${encodeURIComponent(key)}` })),
    fileCount: keys.length,
  };
}

/** The files an `export/s3` or `export/sftp` task wrote: each input under the name and place the node gave it. */
function writtenFiles(node: GraphNodeState, graphNode: GraphExecutionState['graph']['nodes'][string]): TaskReport['result'] {
  const destination = (graphNode as { prefix?: string; directory?: string }).prefix ?? (graphNode as { directory?: string }).directory;
  const names = exportedFileNames(node.outputs.map((key) => path.posix.basename(key)));
  return {
    files: names.slice(0, MAX_TASK_RESULT_FILES).map((name) => ({ filename: name, destination: exportDestination(graphNode.op, destination, name) })),
    fileCount: names.length,
  };
}

/**
 * The tasks of a job that was submitted as named tasks, by name: what each is doing, the files an export task kept (with their
 * download URLs), and for a task that did not complete why. A task that did not run because a task it reads failed (directly or
 * through the tasks between) is `failed` with the code `dependency_failed` and the name of that task in `error.task`; a task
 * the failure merely stopped, that reads none that failed, is `cancelled`.
 */
export function namedTaskReports(state: GraphExecutionState): Record<string, TaskReport> {
  const failedUpstream = new Map<string, string | undefined>();
  /** The nearest failed task that `name` reads, directly or through tasks that did not complete; undefined when there is none. */
  const failedInputOf = (name: string): string | undefined => {
    if (failedUpstream.has(name)) return failedUpstream.get(name);
    failedUpstream.set(name, undefined);
    let found: string | undefined;
    for (const input of inputNames(state.graph.nodes[name])) {
      const status = state.nodes[input]?.status;
      if (status === 'failed') found ??= input;
      else if (status !== 'completed') found ??= failedInputOf(input);
    }
    failedUpstream.set(name, found);
    return found;
  };

  const reports: Record<string, TaskReport> = {};
  for (const [name, graphNode] of Object.entries(state.graph.nodes)) {
    const node = state.nodes[name];
    const inputs = inputNames(graphNode);
    const report: TaskReport = { operation: publicOperationName(graphNode.op), status: STATUS_OF_NODE[node.status] };
    if (inputs.length > 0) report.input = inputs;
    if (node.startedAt !== undefined) report.startedAt = node.startedAt;
    if (node.finishedAt !== undefined) report.finishedAt = node.finishedAt;
    if (node.status === 'completed' && graphNode.op === 'export.internal') report.result = keptFiles(state, node);
    if (node.status === 'completed' && STORAGE_EXPORT_OPERATIONS.has(graphNode.op)) report.result = writtenFiles(node, graphNode);
    if (node.status === 'failed') {
      report.error = { code: node.errorCode ?? TASK_FAILED_CODE, message: redactText(node.error ?? '') };
    } else if (node.status !== 'completed') {
      const failed = failedInputOf(name);
      if (failed) {
        report.status = 'failed';
        report.error = { code: DEPENDENCY_FAILED_CODE, message: `Task "${failed}" failed, so this task did not run.`, task: failed };
      }
    }
    reports[name] = report;
  }
  return reports;
}

/** The name of the task that failed the job, if one did. */
export function failedTaskName(state: GraphExecutionState): string | undefined {
  return Object.values(state.nodes).find((node) => node.status === 'failed')?.id;
}

/** The fields of a named-task job the job API, the list and the webhooks add to what any graph job answers. */
export function namedJobFields(state: GraphExecutionState): { tasks: Record<string, TaskReport>; failedTask?: string } {
  const failedTask = failedTaskName(state);
  return { tasks: namedTaskReports(state), ...(failedTask ? { failedTask } : {}) };
}
