import type { NextResponse } from 'next/server';
import { GraphStateCorruptError, QueueUnavailableError } from '../types';
import { createProblemDetailsResponse } from './problem-details';

/**
 * The one place a job queue failure becomes an API answer. A queue whose Redis is down is a 503 with
 * `Retry-After`, never a 404 or an empty list; a corrupt stored graph record is a 500. Neither body
 * names the Redis endpoint, a key or the corrupt field (the server log has them).
 */

const HTTP_INTERNAL_SERVER_ERROR = 500;
const HTTP_SERVICE_UNAVAILABLE = 503;
/** How long a client should wait before retrying a request that hit an unavailable queue. */
export const QUEUE_RETRY_AFTER_SECONDS = 5;

export const QUEUE_UNAVAILABLE_DETAIL = 'The job queue is temporarily unavailable. Retry the request shortly.';
const GRAPH_STATE_CORRUPT_DETAIL = 'The stored state of this job is corrupt and the job cannot be read.';

/** Problem type for a stored graph record that failed validation. */
export const GRAPH_STATE_CORRUPT_PROBLEM_TYPE = 'https://api.easyconvert.io/problems/job-state-corrupt';

/** The `Retry-After` header of an unavailable queue. */
export function queueRetryAfterHeaders(): Record<string, string> {
  return { 'Retry-After': String(QUEUE_RETRY_AFTER_SECONDS) };
}

/** The problem+json response for a queue error, or undefined when the error is not a queue error. */
export function queueErrorResponse(
  error: unknown,
  instance: string,
  extraHeaders: Record<string, string> = {}
): NextResponse | undefined {
  if (error instanceof QueueUnavailableError) {
    console.error(`[queue] ${error.engineName} unavailable: ${error.reason}`);
    return createProblemDetailsResponse(
      HTTP_SERVICE_UNAVAILABLE,
      QUEUE_UNAVAILABLE_DETAIL,
      instance,
      'Service Unavailable',
      undefined,
      { ...queueRetryAfterHeaders(), ...extraHeaders }
    );
  }
  if (error instanceof GraphStateCorruptError) {
    console.error(`[queue] ${error.name}: ${error.message}`);
    return createProblemDetailsResponse(
      HTTP_INTERNAL_SERVER_ERROR,
      GRAPH_STATE_CORRUPT_DETAIL,
      instance,
      'Job State Corrupt',
      GRAPH_STATE_CORRUPT_PROBLEM_TYPE,
      extraHeaders
    );
  }
  return undefined;
}

/**
 * Runs a route handler and answers a queue error with its problem response; any other error
 * propagates unchanged.
 */
export async function withQueueErrors<T extends Response>(
  instance: string,
  handler: () => Promise<T>
): Promise<T | NextResponse> {
  try {
    return await handler();
  } catch (error) {
    const problem = queueErrorResponse(error, instance);
    if (problem) {
      return problem;
    }
    throw error;
  }
}
