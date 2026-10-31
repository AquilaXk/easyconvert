import type { NextRequest, NextResponse } from 'next/server';
import { rollbackQuota } from '../api-keys/guard';
import { SINGLE_REQUEST_BODY_MAX_BYTES, fileTooLargeMessage, maxFileBytes, planOfCaller, type PlanCaller } from '../plan-limits';
import { createProblemDetailsResponse } from './problem-details';
import { partBodyVerdict, singleRequestVerdict, type BodyLengthVerdict } from './request-body-limit';

/** The 413 for a file of `sizeBytes` over the plan limit of `caller`, or null when the file fits (or has no known size). */
export function fileSizeLimitProblem(
  caller: PlanCaller,
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
  caller: PlanCaller,
  sizeBytes: number | undefined,
  instanceUri: string,
  reservationId: string | undefined
): Promise<NextResponse | null> {
  const problem = fileSizeLimitProblem(caller, sizeBytes, instanceUri);
  if (problem && reservationId) await rollbackQuota(reservationId);
  return problem;
}

function verdictProblem(verdict: BodyLengthVerdict, instanceUri: string, extra?: Record<string, unknown>): NextResponse | null {
  if (!verdict) return null;
  return createProblemDetailsResponse(verdict.status, verdict.detail, instanceUri, undefined, undefined, undefined, undefined, extra);
}

/**
 * The 400 for a malformed `Content-Length`, or the 413 for a declared body larger than a route takes whole; null when
 * the body may be read. It is answered before the route reads the body, so no route holds more than
 * `SINGLE_REQUEST_BODY_MAX_BYTES` of one request. The 413 names the way to send the file: in parts, then a job on the
 * stored file.
 */
function singleRequestBodyProblem(req: Request, instanceUri: string): NextResponse | null {
  const verdict = singleRequestVerdict(instanceUri, req.headers.get('content-length'));
  return verdictProblem(verdict, instanceUri, verdict?.status === 413 ? { maxRequestBytes: SINGLE_REQUEST_BODY_MAX_BYTES } : undefined);
}

/** The 400 for a malformed `Content-Length` of a part, or the 413 for a part declared over the largest part; null when it may be read. */
export function partBodyProblem(req: Request, instanceUri: string): NextResponse | null {
  return verdictProblem(partBodyVerdict(req.headers.get('content-length')), instanceUri);
}

/** The instance of a problem for a request built without a URL, as some callers in tests do. */
const FALLBACK_INSTANCE = '/api';

/** Wraps the handler of a route that reads its body whole: a body declared over a single request is refused before the handler runs. */
export function withinSingleRequest<Rest extends unknown[], Result extends Response>(
  handler: (req: NextRequest, ...rest: Rest) => Promise<Result>
): (req: NextRequest, ...rest: Rest) => Promise<Result | NextResponse> {
  return async (req, ...rest) => singleRequestBodyProblem(req, req.nextUrl?.pathname ?? FALLBACK_INSTANCE) ?? handler(req, ...rest);
}
