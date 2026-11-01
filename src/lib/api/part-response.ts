import type { NextResponse } from 'next/server';
import { PartRefusedError } from '../storage/part-admission';
import { createProblemDetailsResponse } from './problem-details';
import { parseContentLength } from './request-body-limit';
import { PART_IN_FLIGHT_PROBLEM_TYPE, PART_IN_FLIGHT_STATUS } from '../part-in-flight';
import { STORAGE_RETRY_AFTER_SECONDS, storageErrorResponse, uploadSessionNotFoundResponse } from './storage-error-response';

const HTTP_INTERNAL_SERVER_ERROR = 500;
const HTTP_SERVICE_UNAVAILABLE = 503;

/** The detail of a failure worth sending again; the error, which can name a host or a path, stays in the server log. */
export const UPLOAD_UNAVAILABLE_DETAIL = 'A service this upload needs is temporarily unavailable. Retry the request shortly.';

const UPLOAD_STORAGE_ERROR_DETAIL = 'Upload storage error';
const UPLOAD_LOG_PREFIX = '[uploads]';
const MISSING_FILE_CODE = 'ENOENT';
/**
 * Codes of the operating system that mean "try again" and not "this cannot work", each as a library that has to live
 * with them treats it:
 * - EMFILE and ENFILE, no file descriptor free in the process or the host: graceful-fs queues the call and sends it
 *   again when one closes (isaacs/node-graceful-fs, graceful-fs.js:119-358, commit f7a4370), and Node retries them in
 *   `fs.rm` (nodejs/node, lib/internal/fs/rimraf.js:31, commit e97c75e).
 * - EBUSY, a file or device in use for now: in the same Node set.
 * - EAGAIN and EINTR, resource temporarily unavailable and a call cut short by a signal: libuv sends an `EINTR` call
 *   again itself and treats `EAGAIN` as "wait and continue" (libuv/libuv, src/unix/fs.c:389, 882, 1112, 1730,
 *   commit 7228e05), so one that reaches this code is the same condition.
 * EIO is left out: a failing device or a read error that a repeat does not mend, and a 503 would make the browser
 * send the part four times at it. Any other code (EACCES, ENOSPC, EROFS and the rest) is a fault a repeat does not change.
 */
const TRANSIENT_SYSTEM_CODES: ReadonlySet<string> = new Set(['EAGAIN', 'EBUSY', 'EINTR', 'EMFILE', 'ENFILE']);

/**
 * The actions that work on an upload session the caller already holds: a missing file of the session then means the
 * session is gone. `initiate`, `discard` and `presign` work on no session, so a missing file there is the host failing.
 */
const SESSION_BOUND_ACTIONS: ReadonlySet<string> = new Set(['chunk', 'part', 'complete', 'abort']);

/** The 503 with `Retry-After` for a failure with no HTTP status of its own: a service the upload needs could not be reached. */
export function uploadUnavailableResponse(instanceUri: string, extraHeaders: Record<string, string> = {}): NextResponse {
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
 * the host is busy for now (TRANSIENT_SYSTEM_CODES), 404 when the files of the upload session an action works on are
 * gone (SESSION_BOUND_ACTIONS), else a fixed 500 whose sentence names no path. The error itself goes to the server log.
 */
function systemErrorResponse(error: unknown, instanceUri: string, action: string, extraHeaders: Record<string, string>): NextResponse | undefined {
  if (!isSystemError(error)) return undefined;
  if (error.code === MISSING_FILE_CODE && SESSION_BOUND_ACTIONS.has(action)) return uploadSessionNotFoundResponse(instanceUri, extraHeaders);
  console.error(`${UPLOAD_LOG_PREFIX} ${error.code} ${error.syscall}: ${error.message}`);
  if (TRANSIENT_SYSTEM_CODES.has(error.code)) return uploadUnavailableResponse(instanceUri, extraHeaders);
  return createProblemDetailsResponse(HTTP_INTERNAL_SERVER_ERROR, UPLOAD_STORAGE_ERROR_DETAIL, instanceUri, 'Internal Server Error', undefined, extraHeaders);
}

/**
 * The one answer to an error of an upload action that has a mapping: a storage error, or an error of the local disk
 * as `action` reads it. Undefined for any other error, which each route answers by its own rule.
 */
export function uploadErrorResponse(error: unknown, instanceUri: string, action: string, extraHeaders: Record<string, string> = {}): NextResponse | undefined {
  return storageErrorResponse(error, instanceUri, extraHeaders) ?? systemErrorResponse(error, instanceUri, action, extraHeaders);
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
 * reached and the part is worth sending again. Only for the write of a part: any other failure of a route is not a part.
 */
export function partFailureResponse(error: unknown, instanceUri: string, extraHeaders: Record<string, string> = {}): NextResponse {
  if (error instanceof PartRefusedError) return partRefusalResponse(error, instanceUri, extraHeaders);
  const mapped = uploadErrorResponse(error, instanceUri, 'chunk', extraHeaders);
  if (mapped) return mapped;
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  if (typeof status === 'number') {
    return createProblemDetailsResponse(status, messageWithoutPath(error, 'The part could not be stored.'), instanceUri, undefined, undefined, extraHeaders);
  }
  console.error('[parts] A part could not be written:', error);
  return uploadUnavailableResponse(instanceUri, extraHeaders);
}
