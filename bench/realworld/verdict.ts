/**
 * Verdicts of one corpus job. A typed refusal is what the API answers with a 4xx or 503 and a reason; a crash is
 * anything it would answer with a 500 (an untyped exception, a typed server fault, a dead worker); a hang is a job
 * past its deadline. A completed job whose output is empty, of the wrong type or unreadable is a bad output.
 */

export type Verdict = 'ok' | 'refused' | 'crash' | 'hang' | 'bad-output';

const HTTP_BAD_REQUEST = 400;
const HTTP_SERVER_ERROR = 500;
const HTTP_SERVICE_UNAVAILABLE = 503;

export interface ErrorFacts {
  /** The error is one of the conversion error types (ConversionFailedError or a class carrying an HTTP status). */
  typed: boolean;
  /** HTTP status the error carries; typed errors without one answer 400. */
  status: number | null;
}

/** HTTP status the API answers for an error with these facts. */
export function answeredStatus(facts: ErrorFacts): number {
  if (!facts.typed) return HTTP_SERVER_ERROR;
  return facts.status ?? HTTP_BAD_REQUEST;
}

/** Whether an error is a refusal with a reason (4xx, or 503 for a missing engine) rather than a server fault. */
export function isTypedRefusal(facts: ErrorFacts): boolean {
  const status = answeredStatus(facts);
  return status < HTTP_SERVER_ERROR || status === HTTP_SERVICE_UNAVAILABLE;
}

export const VERDICT_ORDER: readonly Verdict[] = ['ok', 'refused', 'bad-output', 'crash', 'hang'];

/** Verdicts that fail the gate whatever the baseline says. */
export const FATAL_VERDICTS: ReadonlySet<Verdict> = new Set<Verdict>(['crash', 'hang', 'bad-output']);

/**
 * How a sandboxed process failed, as the report names it: `exit 139` or `signal SIGSEGV`, or null for an error that carries
 * neither (the sandbox puts only the process's stderr in the message, so the exit status is otherwise lost).
 */
export function exitSummary(error: unknown): string | null {
  const { exitCode, signal } = error as { exitCode?: unknown; signal?: unknown };
  if (typeof signal === 'string' && signal !== '') return `signal ${signal}`;
  if (typeof exitCode === 'number') return `exit ${exitCode}`;
  return null;
}

/** The detail of a crash: the error class, how its process ended when it did, and its message. */
export function crashDetail(name: string, message: string, exit: string | null | undefined): string {
  return exit === null || exit === undefined ? `${name}: ${message}` : `${name} (${exit}): ${message}`;
}
