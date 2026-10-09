import type { NextResponse } from 'next/server';
import { JobTimeoutError, RequestAbortedError } from '../types';
import { createProblemDetailsResponse } from './problem-details';

/**
 * The deadline of a synchronous conversion route. The conversion runs under the same wall-clock limit as a queued
 * job (`jobDeadlineMs`) and stops when the client closes the connection: a signal that carries the reason
 * (`JobTimeoutError` or `RequestAbortedError`) is given to the conversion, so sandboxed child processes are killed
 * and temporary files are removed, and the route answers at the deadline even when the conversion ignores the signal.
 */

/** What a conversion under a deadline receives: merge it into the conversion options. */
export interface DeadlineLimits {
  timeoutMs: number;
  signal: AbortSignal;
}

/** Problem type of a conversion that ran past its deadline. */
export const JOB_TIMEOUT_PROBLEM_TYPE = 'https://api.easyconvert.io/problems/job-timeout';
/** Problem type of a request whose client went away before the conversion finished. */
export const CLIENT_CLOSED_PROBLEM_TYPE = 'https://api.easyconvert.io/problems/client-closed-request';

/** HTTP status for a client that closed the connection (the de facto 499; no answer reaches that client). */
export const HTTP_CLIENT_CLOSED_REQUEST = 499;
const MS_PER_SECOND = 1000;

/**
 * Runs `run` under `timeoutMs` and the request's own signal. Throws `JobTimeoutError` when the deadline passes and
 * `RequestAbortedError` when the client is gone (also when it was gone before the call, in which case `run` does
 * not start). Whatever `run` throws after the signal fired is replaced by the signal's reason, so an engine that
 * wraps an abort into another error cannot turn a timeout into a 400.
 */
export async function runUnderDeadline<T>(
  request: { signal: AbortSignal },
  timeoutMs: number,
  run: (limits: DeadlineLimits) => Promise<T>
): Promise<T> {
  const clientSignal = request.signal;
  if (clientSignal.aborted) throw new RequestAbortedError();

  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let onClientAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const reason = new JobTimeoutError(timeoutMs);
      controller.abort(reason);
      reject(reason);
    }, timeoutMs);
    onClientAbort = () => {
      const reason = new RequestAbortedError();
      controller.abort(reason);
      reject(reason);
    };
    clientSignal.addEventListener('abort', onClientAbort, { once: true });
  });

  const work = run({ timeoutMs, signal: controller.signal });
  // What the conversion reports after the deadline or the disconnect is not the answer.
  work.catch(() => undefined);
  try {
    return await Promise.race([work, stopped]);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    if (onClientAbort) clientSignal.removeEventListener('abort', onClientAbort);
  }
}

/**
 * The problem+json response for a conversion that ran past its deadline (504) or whose client went away (499), or
 * undefined for any other error.
 */
export function deadlineErrorResponse(
  error: unknown,
  instance: string,
  extraHeaders?: Record<string, string>
): NextResponse | undefined {
  if (error instanceof JobTimeoutError) {
    const seconds = Math.ceil(error.timeoutMs / MS_PER_SECOND);
    return createProblemDetailsResponse(
      error.status,
      `The conversion did not finish within its time limit of ${seconds} seconds and was stopped.`,
      instance,
      'Gateway Timeout',
      JOB_TIMEOUT_PROBLEM_TYPE,
      extraHeaders,
      undefined,
      { timeoutMs: error.timeoutMs }
    );
  }
  if (error instanceof RequestAbortedError) {
    return createProblemDetailsResponse(
      HTTP_CLIENT_CLOSED_REQUEST,
      error.message,
      instance,
      'Client Closed Request',
      CLIENT_CLOSED_PROBLEM_TYPE,
      extraHeaders
    );
  }
  return undefined;
}
