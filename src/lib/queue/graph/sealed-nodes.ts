import { redactSecrets } from '../../security/redact';
import { SecretSealError, sealJobSecret, unsealJobSecret } from '../../security/job-secret-seal';
import { ConversionFailedError } from '../../types';
import type { GraphNode, JobGraph, NodeId } from './types';

/** Operations whose `url` and `headers` are bearer secrets of customer storage. */
const SECRET_URL_OPERATIONS: ReadonlySet<string> = new Set(['import.url', 'export.url']);
/** Most request headers a sealed node may carry. */
const MAX_SEALED_HEADERS = 64;

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
  return tasks === undefined ? undefined : redactSecrets(tasks);
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
