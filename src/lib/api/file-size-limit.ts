import type { NextResponse } from 'next/server';
import { rollbackQuota } from '../api-keys/guard';
import { fileTooLargeMessage, maxFileBytes, planOfCaller } from '../plan-limits';
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
