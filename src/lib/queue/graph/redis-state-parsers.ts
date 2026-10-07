import { GraphStateCorruptError } from '../../types';
import type { JobGraph } from './types';
import type { GraphExecutionState, GraphNodeState, GraphStatus, NodeExecutionStatus } from './scheduler-types';

/**
 * Parsers for the records the Redis graph scheduler persists (the graph hash and one JSON document
 * per node). A record that is missing a field or holds a value of the wrong type is corrupt: the
 * parser throws `GraphStateCorruptError` and never substitutes a default, so a damaged record
 * fails its graph instead of becoming an empty, running one. Error messages name the graph and
 * field only, never a value (a value can be a webhook secret).
 */

const GRAPH_STATUSES: ReadonlySet<string> = new Set<GraphStatus>(['running', 'completed', 'failed', 'cancelled']);
const GRAPH_POLICIES: ReadonlySet<string> = new Set<GraphExecutionState['policy']>(['fail_fast', 'continue']);
const NODE_STATUSES: ReadonlySet<string> = new Set<NodeExecutionStatus>([
  'pending',
  'waiting',
  'active',
  'completed',
  'failed',
  'cancelled',
  'skipped',
]);
const NON_NEGATIVE_INTEGER = /^\d+$/;

/**
 * Graph hash fields written by every graph submission. An empty string means "not provided"; an
 * absent field means the record is damaged.
 */
export const REQUIRED_META_FIELDS = [
  'owner',
  'reservationId',
  'webhookUrl',
  'webhookSecret',
  'originalFilename',
  'sourceStorageKey',
] as const;

function corrupt(graphId: string, what: string): GraphStateCorruptError {
  return new GraphStateCorruptError(`Graph ${graphId} has a corrupt scheduler record: ${what}.`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(graphId: string, record: Record<string, string | undefined>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value === '') {
    throw corrupt(graphId, `field "${field}" is missing`);
  }
  return value;
}

/** A field that is always written, where the empty string stands for "not provided". */
function optionalString(graphId: string, record: Record<string, string | undefined>, field: string): string | undefined {
  const value = record[field];
  if (typeof value !== 'string') {
    throw corrupt(graphId, `field "${field}" is missing`);
  }
  return value === '' ? undefined : value;
}

/** A field that older records may lack: absent or empty is "not provided". */
function echoString(record: Record<string, string | undefined>, field: string): string | undefined {
  const value = record[field];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function requireCount(graphId: string, record: Record<string, string | undefined>, field: string): number {
  const value = record[field];
  if (typeof value !== 'string' || !NON_NEGATIVE_INTEGER.test(value)) {
    throw corrupt(graphId, `field "${field}" is not a non-negative integer`);
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count)) {
    throw corrupt(graphId, `field "${field}" is not a safe integer`);
  }
  return count;
}

/** `cjson` encodes an empty Lua table as `{}`, so an empty array may be stored as an empty object. */
function isEmptyObject(value: unknown): boolean {
  return isPlainObject(value) && Object.keys(value).length === 0;
}

function parseJson(graphId: string, what: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw corrupt(graphId, `${what} is not valid JSON`);
  }
}

/** The status string a script or a hash reports; anything outside the known statuses is corrupt. */
export function parseGraphStatus(graphId: string, value: unknown): GraphStatus {
  if (typeof value !== 'string' || !GRAPH_STATUSES.has(value)) {
    throw corrupt(graphId, 'the graph status is missing or unknown');
  }
  return value as GraphStatus;
}

/** The stored graph definition: an object whose `nodes` is an object of objects that each name an `op`. */
export function parseGraphDefinition(graphId: string, text: string | undefined): JobGraph {
  if (typeof text !== 'string' || text === '') {
    throw corrupt(graphId, 'field "graph" is missing');
  }
  const parsed = parseJson(graphId, 'field "graph"', text);
  if (!isPlainObject(parsed) || !isPlainObject(parsed.nodes)) {
    throw corrupt(graphId, 'field "graph" has no "nodes" object');
  }
  for (const [nodeId, node] of Object.entries(parsed.nodes)) {
    if (!isPlainObject(node) || typeof node.op !== 'string') {
      throw corrupt(graphId, `graph node "${nodeId}" has no "op"`);
    }
  }
  return parsed as unknown as JobGraph;
}

/** A JSON list a script or the outputs hash returned (`{}` is how `cjson` encodes an empty list). */
export function parseStoredList<T>(graphId: string, what: string, raw: unknown): T[] {
  if (typeof raw !== 'string') {
    throw corrupt(graphId, `${what} is missing`);
  }
  const parsed = parseJson(graphId, what, raw);
  if (Array.isArray(parsed)) {
    return parsed as T[];
  }
  if (isEmptyObject(parsed)) {
    return [];
  }
  throw corrupt(graphId, `${what} is not a list`);
}

/** The legacy linear task list echoed by the job API; a stored value must be a JSON array. */
function parseTasks(graphId: string, text: string | undefined): unknown[] | undefined {
  if (text === undefined || text === '') {
    return undefined;
  }
  const parsed = parseJson(graphId, 'field "tasks"', text);
  if (!Array.isArray(parsed)) {
    throw corrupt(graphId, 'field "tasks" is not an array');
  }
  return parsed;
}

/** The graph hash without its node states (those are parsed one by one with `parseNodeState`). */
export type GraphMeta = Omit<GraphExecutionState, 'nodes'>;

/**
 * Validates the graph hash. `sourceFormat`, `targetFormat` and `tasks` only echo the submission, so
 * records written before they existed stay readable; every other field must be present.
 */
export function parseGraphMeta(graphId: string, raw: Record<string, string | undefined>): GraphMeta {
  const policy = requireString(graphId, raw, 'policy');
  if (!GRAPH_POLICIES.has(policy)) {
    throw corrupt(graphId, 'field "policy" is unknown');
  }
  const optional = Object.fromEntries(
    REQUIRED_META_FIELDS.map((field) => [field, optionalString(graphId, raw, field)])
  ) as Record<(typeof REQUIRED_META_FIELDS)[number], string | undefined>;
  const finishedOn = raw.finishedOn;
  if (finishedOn !== undefined && finishedOn !== '' && !NON_NEGATIVE_INTEGER.test(finishedOn)) {
    throw corrupt(graphId, 'field "finishedOn" is not a non-negative integer');
  }

  if (requireString(graphId, raw, 'graphId') !== graphId) {
    throw corrupt(graphId, 'field "graphId" names a different graph');
  }

  return {
    graphId,
    status: parseGraphStatus(graphId, raw.status),
    policy: policy as GraphExecutionState['policy'],
    ownerUserId: optional.owner,
    reservationId: optional.reservationId,
    webhookUrl: optional.webhookUrl,
    webhookSecret: optional.webhookSecret,
    originalFilename: optional.originalFilename,
    sourceStorageKey: optional.sourceStorageKey,
    sourceFormat: echoString(raw, 'sourceFormat'),
    targetFormat: echoString(raw, 'targetFormat'),
    tasks: parseTasks(graphId, raw.tasks),
    createdAt: requireCount(graphId, raw, 'createdAt'),
    finishedAt: finishedOn ? Number(finishedOn) : undefined,
    failedReason: echoString(raw, 'failedReason'),
    totalNodes: requireCount(graphId, raw, 'totalNodes'),
    completedNodes: requireCount(graphId, raw, 'completedNodes'),
    failedNodes: requireCount(graphId, raw, 'failedNodes'),
    graph: parseGraphDefinition(graphId, raw.graph),
  };
}

function optionalTimestamp(graphId: string, nodeId: string, value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw corrupt(graphId, `node "${nodeId}" field "${field}" is not a timestamp`);
  }
  return value;
}

/** Validates one node's JSON document; `nodeId` is the hash field it was stored under. */
export function parseNodeState(graphId: string, nodeId: string, text: string | undefined): GraphNodeState {
  if (typeof text !== 'string' || text === '') {
    throw corrupt(graphId, `node "${nodeId}" has no state`);
  }
  const parsed = parseJson(graphId, `node "${nodeId}"`, text);
  if (!isPlainObject(parsed)) {
    throw corrupt(graphId, `node "${nodeId}" state is not an object`);
  }
  if (parsed.id !== nodeId) {
    throw corrupt(graphId, `node "${nodeId}" state names a different node`);
  }
  if (typeof parsed.op !== 'string' || parsed.op === '') {
    throw corrupt(graphId, `node "${nodeId}" field "op" is missing`);
  }
  if (typeof parsed.status !== 'string' || !NODE_STATUSES.has(parsed.status)) {
    throw corrupt(graphId, `node "${nodeId}" field "status" is missing or unknown`);
  }
  let outputs: string[];
  if (Array.isArray(parsed.outputs) && parsed.outputs.every((o) => typeof o === 'string')) {
    outputs = parsed.outputs as string[];
  } else if (isEmptyObject(parsed.outputs)) {
    outputs = [];
  } else {
    throw corrupt(graphId, `node "${nodeId}" field "outputs" is not a list of keys`);
  }
  if (parsed.error !== undefined && typeof parsed.error !== 'string') {
    throw corrupt(graphId, `node "${nodeId}" field "error" is not a string`);
  }

  return {
    id: nodeId,
    op: parsed.op as GraphNodeState['op'],
    status: parsed.status as NodeExecutionStatus,
    outputs,
    error: parsed.error,
    startedAt: optionalTimestamp(graphId, nodeId, parsed.startedAt, 'startedAt'),
    finishedAt: optionalTimestamp(graphId, nodeId, parsed.finishedAt, 'finishedAt'),
  };
}

/** Validates every node document of a graph and checks that none is missing. */
export function parseNodeStates(
  graphId: string,
  rawNodes: Record<string, string>,
  expectedCount: number
): Record<string, GraphNodeState> {
  const nodes: Record<string, GraphNodeState> = {};
  for (const [nodeId, text] of Object.entries(rawNodes)) {
    nodes[nodeId] = parseNodeState(graphId, nodeId, text);
  }
  if (Object.keys(nodes).length !== expectedCount) {
    throw corrupt(graphId, 'the node records do not match "totalNodes"');
  }
  return nodes;
}
