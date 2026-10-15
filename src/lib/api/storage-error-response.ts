import type { NextResponse } from 'next/server';
import {
  StorageAdapterError,
  StorageAuthenticationError,
  StorageInputError,
  StorageInvalidKeyError,
  StorageNotFoundError,
  StorageServiceError,
  StorageTimeoutError,
} from '../storage/adapters/adapter-interface';
import { createProblemDetailsResponse } from './problem-details';

/**
 * The one place a storage failure becomes an API answer. A store that is down, slow, or refuses
 * this application's credentials is a 503 whose body names no provider, credential, endpoint or
 * request id (those go to the server log); a caller's own bad input is a 400.
 */

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const HTTP_SERVICE_UNAVAILABLE = 503;
/** How long a client should wait before retrying a request that hit an unavailable store. */
export const STORAGE_RETRY_AFTER_SECONDS = 5;

const UNAVAILABLE_DETAIL = 'Object storage is temporarily unavailable. Retry the request shortly.';
const UNAVAILABLE_TITLE = 'Service Unavailable';
const INVALID_KEY_DETAIL = 'The object key is not valid for object storage.';
const UPLOAD_GONE_DETAIL = 'The upload session no longer exists or has expired.';
const PARTS_REJECTED_DETAIL = 'The uploaded parts were rejected by object storage.';
const STORAGE_FAILED_DETAIL = 'The object storage request failed.';

/** Store error codes that say the uploaded parts themselves are wrong, not that the store failed. */
const REJECTED_PARTS_CODES: ReadonlySet<string> = new Set(['EntityTooSmall', 'EntityTooLarge', 'InvalidPart', 'InvalidPartOrder']);
const NO_SUCH_UPLOAD_CODE = 'NoSuchUpload';

export interface StorageErrorProblem {
  status: number;
  detail: string;
  title: string;
  headers?: Record<string, string>;
}

/** The problem a storage error maps to, or undefined when the error is not a storage error. */
export function describeStorageError(error: unknown): StorageErrorProblem | undefined {
  if (!(error instanceof StorageAdapterError)) return undefined;

  if (error instanceof StorageInvalidKeyError) {
    return { status: HTTP_BAD_REQUEST, detail: INVALID_KEY_DETAIL, title: 'Bad Request' };
  }
  if (error instanceof StorageInputError) {
    return { status: HTTP_BAD_REQUEST, detail: error.message, title: 'Bad Request' };
  }
  if (error instanceof StorageNotFoundError) {
    return { status: HTTP_NOT_FOUND, detail: 'The object does not exist.', title: 'Not Found' };
  }
  if (error instanceof StorageTimeoutError || error instanceof StorageAuthenticationError) {
    return unavailable(error);
  }
  if (error instanceof StorageServiceError) {
    if (error.code === NO_SUCH_UPLOAD_CODE) {
      return { status: HTTP_NOT_FOUND, detail: UPLOAD_GONE_DETAIL, title: 'Not Found' };
    }
    if (error.code !== undefined && REJECTED_PARTS_CODES.has(error.code)) {
      return { status: HTTP_BAD_REQUEST, detail: PARTS_REJECTED_DETAIL, title: 'Bad Request' };
    }
    if (error.retryable) return unavailable(error);
  }
  console.error(`[storage] ${error.name}: ${error.message}`);
  return { status: HTTP_INTERNAL_SERVER_ERROR, detail: STORAGE_FAILED_DETAIL, title: 'Internal Server Error' };
}

function unavailable(error: StorageAdapterError): StorageErrorProblem {
  const requestId = error instanceof StorageServiceError ? error.requestId : undefined;
  console.error(
    `[storage] ${error.provider} unavailable (${error.name}): ${error.message}${requestId ? ` [request ${requestId}]` : ''}`
  );
  return {
    status: HTTP_SERVICE_UNAVAILABLE,
    detail: UNAVAILABLE_DETAIL,
    title: UNAVAILABLE_TITLE,
    headers: { 'Retry-After': String(STORAGE_RETRY_AFTER_SECONDS) },
  };
}

/** The problem+json response for a storage error, or undefined when the error is not a storage error. */
export function storageErrorResponse(
  error: unknown,
  instance: string,
  extraHeaders: Record<string, string> = {}
): NextResponse | undefined {
  const problem = describeStorageError(error);
  if (!problem) return undefined;
  return createProblemDetailsResponse(problem.status, problem.detail, instance, problem.title, undefined, {
    ...problem.headers,
    ...extraHeaders,
  });
}
