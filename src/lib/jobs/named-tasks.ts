import { PROBLEM_TYPE_BASE } from '@/lib/refusal-codes';
import type { ConversionOptions } from '@/lib/types';
import { GRAPH_OPERATIONS, type GraphOperation } from './graph-operations';
import { isValidNodeId, maxGraphNodesForTier, type GraphValidationErrorDetail, type JobGraph, type TaskNode } from './graph';

/**
 * Named tasks: one job made of tasks the caller names, each reading the tasks it names in `input`. The job runs on the graph
 * engine, so a task is a graph node whose id is its name, and the request is rewritten to the graph before anything else
 * reads it (`namedTasksToJobGraph`). The operation names are the graph's own, but an import, an archive and an export take the
 * slash spelling, so a name answers back as it was sent (`publicOperationName`).
 */

/** The spelling of the operations whose graph name has a dot, as a task names them. */
const SLASH_OPERATIONS = {
  'import/url': 'import.url',
  'import/upload': 'import.upload',
  'archive/create': 'archive.create',
  'archive/extract': 'archive.extract',
  'metadata/write': 'metadata.write',
  'capture/website': 'capture.website',
} as const satisfies Record<string, GraphOperation>;

/** The graph operations a task cannot name directly: its imports, archives and exports take the slash spelling. */
const SLASH_ONLY: ReadonlySet<string> = new Set<GraphOperation>(['import.url', 'import.upload', 'archive.create', 'archive.extract', 'metadata.write', 'capture.website', 'export.url', 'export.internal']);

/** Every `operation` a named task accepts. */
export const NAMED_TASK_OPERATIONS: readonly string[] = [
  ...Object.keys(SLASH_OPERATIONS),
  ...GRAPH_OPERATIONS.filter((op) => !SLASH_ONLY.has(op)),
  'export/url',
];

/** The task `operation` of a graph operation: the spelling the caller sent it under. */
export function publicOperationName(op: string): string {
  const slash = Object.entries(SLASH_OPERATIONS).find(([, graphOp]) => graphOp === op)?.[0];
  if (slash) return slash;
  return op === 'export.url' || op === 'export.internal' ? 'export/url' : op;
}

/** One task of the request, as the schema (`NamedTaskSchema`) states it. */
export interface NamedTask {
  operation: string;
  input?: string | string[];
  output_format?: string;
  options?: ConversionOptions;
  url?: string;
  headers?: Record<string, string>;
  method?: 'PUT' | 'POST';
  upload_id?: string;
  storage_key?: string;
  entries?: string[];
}

export type NamedTaskMap = Record<string, NamedTask>;

/** Whether the `tasks` of a request is the map of named tasks rather than the array of a pipeline. */
export function isNamedTaskMap(tasks: unknown): tasks is NamedTaskMap {
  return typeof tasks === 'object' && tasks !== null && !Array.isArray(tasks);
}

const TARGET_OPERATIONS: ReadonlySet<string> = new Set(['convert', 'thumbnail', 'merge', 'archive/create', 'capture/website']);
const INPUT_FIELDS = ['operation', 'input'] as const;
const URL_FIELDS = ['url', 'headers'] as const;

/** The fields each operation takes beside `operation`; a field of another operation is refused, so a misplaced one is not ignored. */
function allowedFields(operation: string): ReadonlySet<string> {
  switch (operation) {
    case 'import/url':
      return new Set(['operation', ...URL_FIELDS]);
    case 'capture/website':
      return new Set(['operation', 'url', 'options', 'output_format']);
    case 'import/upload':
      return new Set(['operation', 'upload_id', 'storage_key']);
    case 'export/url':
      return new Set([...INPUT_FIELDS, ...URL_FIELDS, 'method']);
    case 'archive/extract':
      return new Set([...INPUT_FIELDS, 'entries', 'options']);
    default:
      return new Set([...INPUT_FIELDS, 'options', ...(TARGET_OPERATIONS.has(operation) ? ['output_format'] : [])]);
  }
}

/** The graph node of a task, or the errors that say why the task is not one. */
function taskNode(name: string, task: NamedTask, uploadKeys: Readonly<Record<string, string>>, errors: GraphValidationErrorDetail[]): TaskNode {
  const at = `tasks.${name}`;
  const refuse = (code: string, field: string, message: string) => errors.push({ path: `${at}.${field}`, message, code });
  const taken = allowedFields(task.operation);
  for (const field of Object.keys(task)) {
    if (!taken.has(field)) refuse('INVALID_TASK_FIELD', field, `Task "${name}" of operation "${task.operation}" does not take "${field}".`);
  }

  const slash = (SLASH_OPERATIONS as Record<string, GraphOperation>)[task.operation];
  const node: TaskNode = { id: name, op: slash ?? task.operation };
  if (task.input !== undefined) node.input = task.input;
  if (task.output_format !== undefined) node.targetFormat = task.output_format;
  if (task.options !== undefined) node.options = task.options;
  if (task.entries !== undefined) node.entries = task.entries;

  if (task.operation === 'capture/website') {
    if (!task.url) refuse('MISSING_TASK_FIELD', 'url', `Task "${name}" captures a page and needs "url".`);
    node.url = task.url;
  } else if (task.operation === 'import/url') {
    if (!task.url) refuse('MISSING_TASK_FIELD', 'url', `Task "${name}" imports from a URL and needs "url".`);
    node.url = task.url;
    if (task.headers) node.headers = task.headers;
  } else if (task.operation === 'import/upload') {
    const key = task.storage_key ?? (task.upload_id === undefined ? undefined : uploadKeys[task.upload_id]);
    if (task.storage_key !== undefined && task.upload_id !== undefined) refuse('INVALID_TASK_FIELD', 'upload_id', `Task "${name}" names its upload by "upload_id" or by "storage_key", not both.`);
    else if (!key) refuse('MISSING_TASK_FIELD', 'upload_id', `Task "${name}" imports an upload and needs "upload_id" or "storage_key".`);
    node.storageKey = key;
  } else if (task.operation === 'export/url') {
    // With a destination the files are sent there; without one they are kept for the caller to download.
    node.op = task.url ? 'export.url' : 'export.internal';
    if (task.url) {
      node.url = task.url;
      node.method = task.method ?? 'PUT';
    } else if (task.method !== undefined || task.headers !== undefined) {
      refuse('INVALID_TASK_FIELD', task.method !== undefined ? 'method' : 'headers', `Task "${name}" has no "url" to send to, so "method" and "headers" do not apply; its files are kept for download.`);
    }
    if (task.url && task.headers) node.headers = task.headers;
  }
  return node;
}

/**
 * The refusals of the names of a request's tasks, before anything reads the tasks themselves: a count over what the plan allows
 * (alone, so a huge request is not walked), then a name used twice (`duplicates`, found in the request text by `duplicateKeys`)
 * and a name that is not a graph node id.
 */
export function namedTaskNameErrors(names: readonly string[], tier: string | undefined, duplicates: readonly string[] = []): GraphValidationErrorDetail[] {
  const limit = maxGraphNodesForTier(tier);
  if (names.length > limit) {
    return [{ path: 'tasks', code: 'GRAPH_NODE_LIMIT_EXCEEDED', message: `The job has ${names.length} tasks; the most a "${tier ?? 'pro'}" plan allows is ${limit}.` }];
  }
  return [
    ...duplicates.map((name) => ({ path: `tasks.${name}`, code: 'DUPLICATE_TASK_NAME', message: `Task name "${name}" is used by more than one task.` })),
    ...names
      .filter((name) => !isValidNodeId(name))
      .map((name) => ({ path: `tasks.${name}`, code: 'INVALID_NODE_ID', message: `Invalid task name "${name}". A name starts with a lowercase letter and holds lowercase letters, digits, "-" and "_", up to 64 characters.` })),
  ];
}

export type NamedTaskTranslation = { ok: true; graph: JobGraph } | { ok: false; errors: GraphValidationErrorDetail[] };

/**
 * The graph of the named tasks of a request, whose names `namedTaskNameErrors` passed. `uploadKeys` holds the storage key of each
 * `upload_id` the tasks name, which the route resolved. The tasks run under `fail_fast`, so a failed task ends the job as failed
 * and the tasks that did not end are stopped: a job reports one outcome. What a graph is checked for (inputs, cycles, formats)
 * is left to `validateJobGraph` on the result, whose errors `namedTaskRefusal` words by task.
 */
export function namedTasksToJobGraph(tasks: NamedTaskMap, uploadKeys: Readonly<Record<string, string>> = {}): NamedTaskTranslation {
  const errors: GraphValidationErrorDetail[] = [];
  const nodes: Record<string, TaskNode> = {};
  for (const [name, task] of Object.entries(tasks)) nodes[name] = taskNode(name, task, uploadKeys, errors);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, graph: { nodes, failurePolicy: 'fail_fast' } };
}

const TASK_NAME_INVALID = `${PROBLEM_TYPE_BASE}task-name-invalid`;
const TASK_NAME_DUPLICATE = `${PROBLEM_TYPE_BASE}task-name-duplicate`;
const TASK_COUNT_EXCEEDED = `${PROBLEM_TYPE_BASE}task-count-exceeded`;
const TASK_INPUT_UNKNOWN = `${PROBLEM_TYPE_BASE}task-input-unknown`;
const TASK_GRAPH_CYCLE = `${PROBLEM_TYPE_BASE}task-graph-cycle`;
const GENERIC_PROBLEM = `${PROBLEM_TYPE_BASE}unprocessable-entity`;

/** The problem `type` each error code of a named-task refusal answers with; a code not listed here is the generic 422. */
const CODED_PROBLEMS: Readonly<Record<string, string>> = {
  INVALID_NODE_ID: TASK_NAME_INVALID,
  DUPLICATE_TASK_NAME: TASK_NAME_DUPLICATE,
  GRAPH_NODE_LIMIT_EXCEEDED: TASK_COUNT_EXCEEDED,
  NON_EXISTENT_INPUT: TASK_INPUT_UNKNOWN,
  CYCLE_DETECTED: TASK_GRAPH_CYCLE,
  SELF_CYCLE_DETECTED: TASK_GRAPH_CYCLE,
};

/** What names a refusal first when several causes are present: a task that cannot be named or found cannot be read further. */
const PROBLEM_PRIORITY = [TASK_COUNT_EXCEEDED, TASK_NAME_DUPLICATE, TASK_NAME_INVALID, TASK_INPUT_UNKNOWN, TASK_GRAPH_CYCLE];

export interface NamedTaskRefusal {
  /** The problem `type`: one of `CODED_PROBLEMS`, else the generic 422. */
  type: string;
  detail: string;
  invalidParams: Array<{ name: string; reason: string }>;
}

/** The refusal of `errors` (those of the name checks, of `namedTasksToJobGraph`, or of `validateJobGraph` on its graph), by task. */
export function namedTaskRefusal(errors: readonly GraphValidationErrorDetail[]): NamedTaskRefusal {
  const named = errors.map((e) => ({ ...e, path: e.path.replace(/^nodes(?=\.|$)/, 'tasks'), problem: CODED_PROBLEMS[e.code] ?? GENERIC_PROBLEM }));
  return {
    type: PROBLEM_PRIORITY.find((candidate) => named.some((e) => e.problem === candidate)) ?? GENERIC_PROBLEM,
    detail: `Task validation failed: ${named.map((e) => e.message).join(' ')}`,
    invalidParams: named.map((e) => ({ name: e.path, reason: e.message })),
  };
}
