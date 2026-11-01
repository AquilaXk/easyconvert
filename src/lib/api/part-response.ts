import type { NextResponse } from 'next/server';
import { PartRefusedError } from '../storage/part-admission';
import { createProblemDetailsResponse } from './problem-details';
import { parseContentLength } from './request-body-limit';
import { PART_IN_FLIGHT_PROBLEM_TYPE, PART_IN_FLIGHT_STATUS } from '../part-in-flight';
import { STORAGE_RETRY_AFTER_SECONDS, storageErrorResponse } from './storage-error-response';

const HTTP_NOT_FOUND = 404;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const HTTP_SERVICE_UNAVAILABLE = 503;

/** The detail of a failure worth sending again; the error, which can name a host or a path, stays in the server log. */
export const UPLOAD_UNAVAILABLE_DETAIL = 'A service this upload needs is temporarily unavailable. Retry the request shortly.';

/** The detail of a session whose files are gone: a session removed under a running request is a missing session, not a server fault. */
export const UPLOAD_SESSION_NOT_FOUND = 'Upload session not found or has expired.';
const UPLOAD_STORAGE_ERROR_DETAIL = 'Upload storage error';
const UPLOAD_LOG_PREFIX = '[uploads]';
const MISSING_FILE_CODE = 'ENOENT';
/**
 * Codes of the operating system that mean "try again" and not "this cannot work": POSIX defines EAGAIN and EINTR as
 * retry conditions, and EBUSY, EIO, EMFILE and ENFILE as a device or a table of the host that is busy, failing or full
 * for now. Any other code (EACCES, ENOSPC, EROFS and the rest) is a fault a repeat does not change.
 */
const TRANSIENT_SYSTEM_CODES: ReadonlySet<string> = new Set(['EIO', 'EAGAIN', 'EBUSY', 'EINTR', 'EMFILE', 'ENFILE']);

/** The 404 for an upload session that does not exist, expired, or belongs to another caller. */
export function uploadSessionNotFoundResponse(instanceUri: string, extraHeaders: Record<string, string> = {}): NextResponse {
  return createProblemDetailsResponse(HTTP_NOT_FOUND, UPLOAD_SESSION_NOT_FOUND, instanceUri, undefined, undefined, extraHeaders);
}

function uploadUnavailableResponse(instanceUri: string, extraHeaders: Record<string, string>): NextResponse {
  return createProblemDetailsResponse(HTTP_SERVICE_UNAVAILABLE, UPLOAD_UNAVAILABLE_DETAIL, instanceUri, undefined, undefined, {
    'Retry-After': String(STORAGE_RETRY_AFTER_SECONDS),
    ...extraHeaders,
  });
}

/** An error from the operating system (it carries an errno code and syscall); its message names server paths. */
function isSystemError(error: unknown): error is NodeJS.ErrnoException & { code: string; syscall: string } {
  const { code, syscall } = (error ?? {}) as NodeJS.ErrnoException;
  return error instanceof Error && typeof code === 'string' && typeof syscall === 'string';
}

/**
 * The problem an error of the local disk maps to, or undefined when the error is not one: 503 with `Retry-After` while
 * the host is busy for now (TRANSIENT_SYSTEM_CODES), 404 when the files of the upload session are gone, else a fixed 500
 * whose sentence names no path. The error itself goes to the server log.
 */
export function systemErrorResponse(error: unknown, instanceUri: string, extraHeaders: Record<string, string> = {}): NextResponse | undefined {
  if (!isSystemError(error)) return undefined;
  if (error.code === MISSING_FILE_CODE) return uploadSessionNotFoundResponse(instanceUri, extraHeaders);
  console.error(`${UPLOAD_LOG_PREFIX} ${error.code} ${error.syscall}: ${error.message}`);
  if (TRANSIENT_SYSTEM_CODES.has(error.code)) return uploadUnavailableResponse(instanceUri, extraHeaders);
  return createProblemDetailsResponse(HTTP_INTERNAL_SERVER_ERROR, UPLOAD_STORAGE_ERROR_DETAIL, instanceUri, 'Internal Server Error', undefined, extraHeaders);
}

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
  return uploadUnavailableResponse(instanceUri, extraHeaders);
}
