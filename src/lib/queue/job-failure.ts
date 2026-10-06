import { ConversionFailedError, EngineUnavailableError } from '../types';

const HTTP_BAD_REQUEST = 400;
const HTTP_SERVICE_UNAVAILABLE = 503;

/** How a failed attempt is recorded on the job and whether the queue may try the job again. */
export interface JobFailureInfo {
  /** Error class name of a typed failure; undefined for an untyped one. */
  code?: string;
  /** HTTP status the same failure answers on the synchronous API; undefined for an untyped failure. */
  status?: number;
  /** False when another attempt would fail the same way. */
  retryable: boolean;
}

/** The status a typed failure carries itself (for example 413), when it is a number. */
function ownStatus(err: ConversionFailedError): number | undefined {
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * Classifies a failed attempt. A typed conversion failure is a verdict on the input (malformed, unsupported,
 * over a limit), so retrying only repeats the work; a missing engine is the exception, because another worker
 * of the pool may have it. Anything untyped (a dropped socket, an out-of-memory kill) says nothing about the
 * input and stays retryable.
 */
export function classifyJobFailure(err: unknown): JobFailureInfo {
  if (err instanceof EngineUnavailableError) {
    return { code: err.name, status: HTTP_SERVICE_UNAVAILABLE, retryable: true };
  }
  if (err instanceof ConversionFailedError) {
    return { code: err.name, status: ownStatus(err) ?? HTTP_BAD_REQUEST, retryable: false };
  }
  return { retryable: true };
}
