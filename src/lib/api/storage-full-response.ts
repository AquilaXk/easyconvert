import type { NextRequest, NextResponse } from 'next/server';
import { storageProvider } from '../storage';
import { STORAGE_FULL_RETRY_AFTER_SECONDS, admitsNewFiles } from '../storage/retention-service';
import { createProblemDetailsResponse } from './problem-details';

const HTTP_SERVICE_UNAVAILABLE = 503;
export const STORAGE_FULL_DETAIL = 'The server is out of disk space for new files. Retry the request shortly.';
export const STORAGE_FULL_PROBLEM_TYPE = 'https://api.easyconvert.io/problems/storage-full';
/** The problem `instance` of a request built without a URL, as some callers in tests do. */
const FALLBACK_INSTANCE = '/api';

/**
 * The 503 a new upload or conversion gets while the disk of the local storage driver is above
 * RESULT_DISK_REFUSE_PERCENT even after results were deleted early; undefined when it may go ahead.
 */
export async function storageFullResponse(instance: string): Promise<NextResponse | undefined> {
  if (await admitsNewFiles(storageProvider)) return undefined;
  return createProblemDetailsResponse(
    HTTP_SERVICE_UNAVAILABLE,
    STORAGE_FULL_DETAIL,
    instance,
    'Storage Full',
    STORAGE_FULL_PROBLEM_TYPE,
    { 'Retry-After': String(STORAGE_FULL_RETRY_AFTER_SECONDS) }
  );
}

/**
 * Wraps the POST handler of a route that takes new files (an upload or a conversion): while the disk is full the
 * request gets the 503 of `storageFullResponse` before the handler authenticates it, so a refused request uses no
 * quota. `takesNewFile` limits the check to the requests that start a new file; continuing or finishing one goes on.
 */
export function admittingNewFiles<Rest extends unknown[], Result extends Response>(
  handler: (req: NextRequest, ...rest: Rest) => Promise<Result>,
  takesNewFile: (req: NextRequest) => boolean = () => true
): (req: NextRequest, ...rest: Rest) => Promise<Result | NextResponse> {
  return async (req, ...rest) => {
    if (takesNewFile(req)) {
      const refused = await storageFullResponse(req.nextUrl?.pathname ?? FALLBACK_INSTANCE);
      if (refused) return refused;
    }
    return handler(req, ...rest);
  };
}
