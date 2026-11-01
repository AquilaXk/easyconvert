/**
 * Why a conversion in the queue failed, in a form the interface words in the page's language: a code for a failure the
 * client decided, or the server's refusing answer (problem details, RFC 9457), which the interface words by its problem
 * type or shows as the server wrote it.
 */
export type ConversionFailure =
  | { readonly code: 'conversionFailed' | 'jobTimedOut' }
  | { readonly code: 'clientEdgeFailed'; readonly reason?: string }
  | { readonly code: 'clientOnlyBlocked'; readonly source: string; readonly target: string; readonly edgeFailure?: EdgeFailure }
  | { readonly code: 'server'; readonly problem: Readonly<Record<string, unknown>> };

/** The browser tier that failed before a client-only conversion was refused, and its error, shown after the sentence. */
export interface EdgeFailure {
  readonly tier: string;
  readonly reason: string;
}

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
