import type { NextRequest, NextResponse } from 'next/server';
import { rollbackQuota } from '../api-keys/guard';
import { formatBytes } from '../format-bytes';
import {
  SINGLE_REQUEST_BODY_MAX_BYTES,
  SINGLE_REQUEST_FILE_MAX_BYTES,
  UPLOAD_PART_MAX_BYTES,
  fileTooLargeMessage,
  maxFileBytes,
  planOfCaller,
} from '../plan-limits';
import { createProblemDetailsResponse } from './problem-details';

type Caller = Parameters<typeof planOfCaller>[0];

/** The most bytes one file of `caller` may have, by the plan table. */
export function callerMaxFileBytes(caller: Caller): number {
  return maxFileBytes(planOfCaller(caller));
}

/** The 413 for a file of `sizeBytes` over the plan limit of `caller`, or null when the file fits (or has no known size). */
export function fileSizeLimitProblem(
  caller: Caller,
  sizeBytes: number | undefined,
  instanceUri: string,
  extraHeaders?: Record<string, string>
): NextResponse | null {
  if (sizeBytes === undefined) return null;
  const plan = planOfCaller(caller);
  if (sizeBytes <= maxFileBytes(plan)) return null;
  return createProblemDetailsResponse(413, fileTooLargeMessage(plan, sizeBytes), instanceUri, undefined, undefined, extraHeaders);
}

/** `fileSizeLimitProblem` for a route that has reserved quota: the reservation is released when the file is refused. */
export async function refuseOversizeFile(
  caller: Caller,
  sizeBytes: number | undefined,
  instanceUri: string,
  reservationId: string | undefined
): Promise<NextResponse | null> {
  const problem = fileSizeLimitProblem(caller, sizeBytes, instanceUri);
  if (problem && reservationId) await rollbackQuota(reservationId);
  return problem;
}

/**
 * The 413 for a request whose declared body is larger than a route takes whole, or null when it fits or declares no
 * length. It is answered before the route reads the body, so no route holds more than `SINGLE_REQUEST_BODY_MAX_BYTES`
 * of one request. The detail names the way to send the file: in parts, then a job on the stored file.
 */
export function singleRequestBodyProblem(req: Request, instanceUri: string): NextResponse | null {
  const declared = Number.parseInt(req.headers.get('content-length') ?? '', 10);
  if (!Number.isFinite(declared) || declared <= SINGLE_REQUEST_BODY_MAX_BYTES) return null;
  const detail =
    `This request carries ${formatBytes(declared)}, over the ${formatBytes(SINGLE_REQUEST_FILE_MAX_BYTES)} one request may carry. ` +
    `Send a larger file in parts of at most ${formatBytes(UPLOAD_PART_MAX_BYTES)}: open an upload with POST /api/storage/multipart ` +
    '(or /api/v1/uploads), send the parts, then start the conversion with POST /api/queue/jobs (or /api/v1/jobs) on the stored file.';
  return createProblemDetailsResponse(413, detail, instanceUri, undefined, undefined, undefined, undefined, {
    maxRequestBytes: SINGLE_REQUEST_BODY_MAX_BYTES,
  });
}

/** The instance of a problem for a request built without a URL, as some callers in tests do. */
const FALLBACK_INSTANCE = '/api';

/** Wraps the handler of a route that reads its body whole: a body declared over a single request is refused before the handler runs. */
export function withinSingleRequest<Rest extends unknown[], Result extends Response>(
  handler: (req: NextRequest, ...rest: Rest) => Promise<Result>
): (req: NextRequest, ...rest: Rest) => Promise<Result | NextResponse> {
  return async (req, ...rest) => singleRequestBodyProblem(req, req.nextUrl?.pathname ?? FALLBACK_INSTANCE) ?? handler(req, ...rest);
}
