import type { NextResponse } from 'next/server';
import { PartRefusedError } from '../storage/part-admission';
import { createProblemDetailsResponse } from './problem-details';
import { parseContentLength } from './request-body-limit';
import { PART_IN_FLIGHT_PROBLEM_TYPE, PART_IN_FLIGHT_STATUS } from './part-in-flight';
import { STORAGE_RETRY_AFTER_SECONDS, storageErrorResponse, systemErrorResponse } from './storage-error-response';

const HTTP_SERVICE_UNAVAILABLE = 503;

/** The detail of a failure worth sending again; the error, which can name a host or a path, stays in the server log. */
export const UPLOAD_UNAVAILABLE_DETAIL = 'A service this upload needs is temporarily unavailable. Retry the request shortly.';

/** The length a part request declared, when its Content-Length is a whole number of bytes (the route refused any other). */
export function declaredPartBytes(headers: Pick<Headers, 'get'>): number | undefined {
  const declared = parseContentLength(headers.get('content-length'));
  return declared.kind === 'bytes' ? declared.bytes : undefined;
}

/** The message of `error` when it names no path, else `fallback`: a path on this host stays in the server log. */
function messageWithoutPath(error: unknown, fallback: string): string {
  return error instanceof Error && error.message && !error.message.includes('/') && !error.message.includes('\\') ? error.message : fallback;
}

function partRefusalResponse(error: PartRefusedError, instanceUri: string, extraHeaders: Record<string, string>): NextResponse {
  if (error.statusCode !== PART_IN_FLIGHT_STATUS) {
    return createProblemDetailsResponse(error.statusCode, error.message, instanceUri, undefined, undefined, extraHeaders);
  }
  return createProblemDetailsResponse(error.statusCode, error.message, instanceUri, undefined, PART_IN_FLIGHT_PROBLEM_TYPE, {
    'Retry-After': String(STORAGE_RETRY_AFTER_SECONDS),
    ...extraHeaders,
  });
}

/**
 * The answer to a part that could not be written: the problem of a storage error or an error of the local disk, the
 * status a refusal or a bound of the store gave the error, or else 503 with `Retry-After`, since the store could not be
 * reached and the part is worth sending again.
 */
export function partFailureResponse(error: unknown, instanceUri: string, extraHeaders: Record<string, string> = {}): NextResponse {
  const storageProblem = storageErrorResponse(error, instanceUri, extraHeaders);
  if (storageProblem) return storageProblem;
  if (error instanceof PartRefusedError) return partRefusalResponse(error, instanceUri, extraHeaders);
  const diskProblem = systemErrorResponse(error, instanceUri, extraHeaders);
  if (diskProblem) return diskProblem;
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  if (typeof status === 'number') {
    return createProblemDetailsResponse(status, messageWithoutPath(error, 'The part could not be stored.'), instanceUri, undefined, undefined, extraHeaders);
  }
  console.error('[parts] A part could not be written:', error);
  return createProblemDetailsResponse(HTTP_SERVICE_UNAVAILABLE, UPLOAD_UNAVAILABLE_DETAIL, instanceUri, undefined, undefined, {
    'Retry-After': String(STORAGE_RETRY_AFTER_SECONDS),
    ...extraHeaders,
  });
}
