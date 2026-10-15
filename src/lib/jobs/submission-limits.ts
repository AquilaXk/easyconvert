import { MAX_REDACTION_DEPTH, MAX_REDACTION_NODES } from '../security/redact';
import { MAX_SEALED_URL_CHARS, findSealedSecretProblems } from '../queue/graph/sealed-nodes';

/**
 * Limits a job submission must meet to be stored, sealed and shown back. The structure limits are
 * the redaction limits, so every accepted graph can be masked in full; the secret limits are the
 * sealing limits. Checked before a job exists, so nothing is created or charged for a refusal.
 */
export interface SubmissionProblem {
  /** Request path of the offending value, e.g. `graph.nodes.in.url`. */
  name: string;
  /** What is wrong, without repeating any submitted value. */
  reason: string;
}

/** Why `value` is beyond the redaction limits, or undefined. Iterative, so the check itself is bounded. */
function structureProblem(value: unknown): string | undefined {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let visited = 0;
  for (let item = stack.pop(); item; item = stack.pop()) {
    visited++;
    if (visited > MAX_REDACTION_NODES) {
      return `more than ${MAX_REDACTION_NODES} values`;
    }
    if (typeof item.value !== 'object' || item.value === null) {
      continue;
    }
    if (item.depth >= MAX_REDACTION_DEPTH) {
      return `nested deeper than ${MAX_REDACTION_DEPTH} levels`;
    }
    for (const child of Object.values(item.value)) {
      stack.push({ value: child, depth: item.depth + 1 });
    }
  }
  return undefined;
}

function nodeEntries(graph: unknown): [string, unknown][] {
  if (typeof graph !== 'object' || graph === null) {
    return [];
  }
  const entries: [string, unknown][] = [];
  for (const group of ['nodes', 'tasks'] as const) {
    const container = (graph as Record<string, unknown>)[group];
    if (typeof container === 'object' && container !== null) {
      for (const [key, node] of Object.entries(container)) {
        entries.push([`graph.${group}.${key}`, node]);
      }
    }
  }
  return entries;
}

export function checkSubmissionLimits(input: { graph?: unknown; tasks?: unknown }): SubmissionProblem[] {
  const problems: SubmissionProblem[] = [];
  for (const [name, value] of [['graph', input.graph], ['tasks', input.tasks]] as const) {
    const reason = value === undefined ? undefined : structureProblem(value);
    if (reason) {
      problems.push({ name, reason });
    }
  }
  if (problems.length > 0) {
    return problems;
  }
  for (const [name, node] of nodeEntries(input.graph)) {
    for (const problem of findSealedSecretProblems(node)) {
      problems.push({ name: problem.path ? `${name}.${problem.path}` : name, reason: problem.reason });
    }
  }
  if (Array.isArray(input.tasks)) {
    input.tasks.forEach((task: unknown, index) => {
      const url = (task as { url?: unknown } | null)?.url;
      if (typeof url === 'string' && url.length > MAX_SEALED_URL_CHARS) {
        problems.push({ name: `tasks.${index}.url`, reason: `url is longer than ${MAX_SEALED_URL_CHARS} characters` });
      }
    });
  }
  return problems;
}
