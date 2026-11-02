/**
 * Why a conversion in the queue, or the ZIP of its results, failed, in a form the interface words in the page's language: a
 * code for a failure the client decided, the server's refusing answer (its `code` or problem type, RFC 9457, with the HTTP
 * status), or a queued job that failed on a worker (the refusal code the job recorded; a job's failure has no HTTP status).
 */
export type ConversionFailure =
  | { readonly code: 'conversionFailed' | 'jobTimedOut' | 'zipFailed' }
  | { readonly code: 'clientEdgeFailed' }
  | { readonly code: 'clientOnlyBlocked'; readonly source: string; readonly target: string; readonly edgeFailed?: true }
  | { readonly code: 'server'; readonly problem: Readonly<Record<string, unknown>> }
  | { readonly code: 'jobFailed'; readonly refusalCode?: string };

/** An error that names its failure; its message is the English sentence for logs and API callers, never shown as is. */
export class ConversionFailureError extends Error {
  readonly failure: ConversionFailure;

  constructor(message: string, failure: ConversionFailure) {
    super(message);
    this.name = 'ConversionFailureError';
    this.failure = failure;
  }
}

const UNNAMED_FAILURE: ConversionFailure = { code: 'conversionFailed' };

/** The failure an error names; any other error (a network failure, a bug) is an unnamed conversion failure. */
export function conversionFailureOf(err: unknown): ConversionFailure {
  return err instanceof ConversionFailureError ? err.failure : UNNAMED_FAILURE;
}

/** The error for a refusing answer: its message is the server's sentence, and its failure carries the whole answer. */
export function serverRefusal(body: unknown, status: number, fallbackMessage: string): ConversionFailureError {
  const problem: Record<string, unknown> = body && typeof body === 'object' ? { ...body, status } : { status };
  const sentence = [problem.detail, problem.error].find((text): text is string => typeof text === 'string' && text !== '');
  return new ConversionFailureError(sentence ?? fallbackMessage, { code: 'server', problem });
}

const nonEmpty = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/** The error for a job that ended failed: its message is the worker's reason, and its failure carries the job's record. */
export function jobFailure(job: { readonly failedReason?: unknown; readonly failedRefusalCode?: unknown }): ConversionFailureError {
  const reason = nonEmpty(job.failedReason);
  return new ConversionFailureError(reason ?? 'The conversion failed.', { code: 'jobFailed', refusalCode: nonEmpty(job.failedRefusalCode) });
}
