import { redactForOutput } from '../../security/redact';
import {
  MAX_SEALED_PLAINTEXT_BYTES,
  SecretSealError,
  sealJobSecret,
  unsealJobSecret,
} from '../../security/job-secret-seal';
import { ConversionFailedError } from '../../types';
import type { GraphNode, JobGraph, NodeId } from './types';

/** Operations whose `url` and `headers` are bearer secrets of customer storage. */
const SECRET_URL_OPERATIONS: ReadonlySet<string> = new Set(['import.url', 'export.url']);
/** Longest URL a sealed node may carry, in characters. */
export const MAX_SEALED_URL_CHARS = 8192;
/** Most request headers a sealed node may carry. */
export const MAX_SEALED_HEADERS = 64;
/** Longest header name and header value a sealed node may carry, in characters. */
export const MAX_SEALED_HEADER_NAME_CHARS = 256;
export const MAX_SEALED_HEADER_VALUE_CHARS = 8192;
/** Longest header name echoed in a problem path. */
const MAX_REPORTED_HEADER_NAME_CHARS = 48;

export interface UrlNodeSecrets {
  url: string;
  headers?: Record<string, string>;
}

type UrlNodeFields = { op: string; url?: unknown; headers?: unknown; sealed?: unknown };

/**
 * Replaces the plaintext `url` and `headers` of an import.url or export.url node by one sealed
 * blob bound to `jobId`. Other nodes, and nodes without plaintext secrets, are returned as they are.
 */
export function sealGraphNode<N extends GraphNode>(node: N, jobId: string): N {
  const fields = node as unknown as UrlNodeFields;
  if (!SECRET_URL_OPERATIONS.has(fields.op) || (fields.url === undefined && fields.headers === undefined)) {
    return node;
  }
  const { url, headers, ...rest } = node as unknown as UrlNodeFields & Record<string, unknown>;
  const payload: Record<string, unknown> = { url };
  if (headers !== undefined) {
    payload.headers = headers;
  }
  return { ...rest, sealed: sealJobSecret(JSON.stringify(payload), jobId) } as unknown as N;
}

/** A copy of `graph` in which every node's secrets are sealed under the job id `jobIdOf` gives that node. */
export function sealJobGraph(graph: JobGraph, jobIdOf: (nodeId: NodeId) => string): JobGraph {
  const nodes: Record<NodeId, GraphNode> = {};
  for (const [nodeId, node] of Object.entries(graph.nodes)) {
    nodes[nodeId] = sealGraphNode(node, jobIdOf(nodeId));
  }
  return { ...graph, nodes };
}

/**
 * Display-only task records are never executed, so they are stored masked rather than sealed:
 * nothing needs their plaintext.
 */
export function maskTaskRecords(tasks: unknown[] | undefined): unknown[] | undefined {
  return tasks === undefined ? undefined : redactForOutput(tasks);
}

function malformedPayload(): SecretSealError {
  return new SecretSealError('MALFORMED_BLOB', '[JobSecretSeal] Sealed node payload is malformed.');
}

function parseHeaders(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw malformedPayload();
  }
  const entries = Object.entries(raw);
  if (entries.length > MAX_SEALED_HEADERS || entries.some(([, value]) => typeof value !== 'string')) {
    throw malformedPayload();
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

/**
 * Opens the secrets of an import.url or export.url node inside the worker, at the point of use.
 * A node that still carries plaintext is refused, and an unsealing failure throws a SecretSealError;
 * neither falls back to the plaintext.
 */
export function openUrlNodeSecrets(node: object, jobId: string): UrlNodeSecrets {
  const fields = node as UrlNodeFields;
  if (fields.url !== undefined || fields.headers !== undefined) {
    throw new SecretSealError('UNSEALED_SECRET', '[JobSecretSeal] Refusing a node whose URL or headers are not sealed.');
  }
  if (typeof fields.sealed !== 'string') {
    throw new ConversionFailedError(`Node (${fields.op}) has no url`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(unsealJobSecret(fields.sealed, jobId));
  } catch (err) {
    throw err instanceof SecretSealError ? err : malformedPayload();
  }
  const { url, headers } = (payload ?? {}) as { url?: unknown; headers?: unknown };
  if (typeof url !== 'string' || url.length === 0) {
    throw malformedPayload();
  }
  return { url, headers: parseHeaders(headers) };
}

export interface SealedSecretProblem {
  /** Where the problem is, relative to the node: `url`, `headers`, `headers.<name>`, or empty for the whole node. */
  path: string;
  /** What is wrong, without repeating any secret. */
  reason: string;
}

/**
 * The reasons a node's URL and headers cannot be sealed, found before anything is stored: a URL or
 * header beyond its limit, too many headers, values that are not strings, or a combined payload
 * beyond what one sealed blob holds. Nodes without secrets have no problems.
 */
export function findSealedSecretProblems(node: unknown): SealedSecretProblem[] {
  if (typeof node !== 'object' || node === null) {
    return [];
  }
  const fields = node as { op?: unknown; operation?: unknown; url?: unknown; headers?: unknown };
  const operation = typeof fields.op === 'string' ? fields.op : fields.operation;
  if (typeof operation !== 'string' || !SECRET_URL_OPERATIONS.has(operation.replace('/', '.'))) {
    return [];
  }
  const problems: SealedSecretProblem[] = [];
  if (fields.url !== undefined) {
    if (typeof fields.url !== 'string') {
      problems.push({ path: 'url', reason: 'url must be a string' });
    } else if (fields.url.length > MAX_SEALED_URL_CHARS) {
      problems.push({ path: 'url', reason: `url is longer than ${MAX_SEALED_URL_CHARS} characters` });
    }
  }
  if (fields.headers !== undefined) {
    problems.push(...headerProblems(fields.headers));
  }
  if (problems.length === 0 && fields.url !== undefined) {
    const payloadBytes = Buffer.byteLength(JSON.stringify({ url: fields.url, headers: fields.headers }), 'utf8');
    if (payloadBytes > MAX_SEALED_PLAINTEXT_BYTES) {
      problems.push({ path: '', reason: `url and headers together are larger than ${MAX_SEALED_PLAINTEXT_BYTES} bytes` });
    }
  }
  return problems;
}

function headerProblems(headers: unknown): SealedSecretProblem[] {
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
    return [{ path: 'headers', reason: 'headers must be an object of strings' }];
  }
  const entries = Object.entries(headers);
  if (entries.length > MAX_SEALED_HEADERS) {
    return [{ path: 'headers', reason: `more than ${MAX_SEALED_HEADERS} headers` }];
  }
  const problems: SealedSecretProblem[] = [];
  for (const [name, value] of entries) {
    const path = `headers.${name.slice(0, MAX_REPORTED_HEADER_NAME_CHARS)}`;
    if (name.length > MAX_SEALED_HEADER_NAME_CHARS) {
      problems.push({ path, reason: `header name is longer than ${MAX_SEALED_HEADER_NAME_CHARS} characters` });
    } else if (typeof value !== 'string') {
      problems.push({ path, reason: 'header value must be a string' });
    } else if (value.length > MAX_SEALED_HEADER_VALUE_CHARS) {
      problems.push({ path, reason: `header value is longer than ${MAX_SEALED_HEADER_VALUE_CHARS} characters` });
    }
  }
  return problems;
}
