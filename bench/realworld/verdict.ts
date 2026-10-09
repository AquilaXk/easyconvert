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
