import { NextRequest, NextResponse } from 'next/server';
import { deadlineErrorResponse, runUnderDeadline } from '@/lib/api/sync-deadline';
import { serverFault } from '@/lib/api/problem-details';
import { dispatchConversion } from '@/lib/conversions/dispatch';
import { bindJobLimits } from '@/lib/conversions/job-time';
import type { WorkerConversionResult } from '@/worker/engines';

export const dynamic = 'force-dynamic';

/** A one-pixel red PPM, which ImageMagick decodes in the sandboxed child that every native conversion starts in. */
const SMOKE_PPM = 'P6\n1 1\n255\n\xff\x00\x00';
/** Answers before deploy.sh stops waiting (`curl --max-time 60`), so a slow sandbox is logged as this route's 504. */
const SMOKE_DEADLINE_MS = 30_000;
/** How long a verdict is reused, as the readiness probes reuse theirs (`HEALTH_CACHE_TTL_MS` of src/lib/health/probes.ts). */
const SMOKE_VERDICT_TTL_MS = 5_000;
/** The conversion belongs to no caller, so a caller that goes away ends only its own wait. */
const NO_CALLER = { signal: new AbortController().signal };

let verdict: { result: Promise<WorkerConversionResult>; expiresAt: number } | undefined;

/** The fixed conversion, at most one at a time and one per SMOKE_VERDICT_TTL_MS: callers share it and its outcome, failure included. */
function smokeConversion(): Promise<WorkerConversionResult> {
  if (verdict && Date.now() < verdict.expiresAt) return verdict.result;
  const result = runUnderDeadline(NO_CALLER, SMOKE_DEADLINE_MS, (limits) =>
    dispatchConversion(Buffer.from(SMOKE_PPM, 'latin1'), 'ppm', 'png', bindJobLimits({}, limits), 'smoke.ppm')
  );
  const current = { result, expiresAt: Number.POSITIVE_INFINITY };
  const keep = () => {
    current.expiresAt = Date.now() + SMOKE_VERDICT_TTL_MS;
  };
  result.then(keep, keep);
  verdict = current;
  return result;
}

/**
 * The deploy's smoke conversion (deploy/oci/deploy.sh): the fixed picture above to PNG, through the dispatcher that /api/convert
 * uses. It reads nothing of the request, so it is no conversion service: it charges no allowance and gives a caller nothing of its
 * own converted, and calling it more often adds no conversion. The host proxy does not forward paths under /api/health/
 * (deploy/oci/nginx-easyconvert.conf).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const instanceUri = req.nextUrl?.pathname || '/api/health/conversion';
  try {
    const result = await runUnderDeadline(req, SMOKE_DEADLINE_MS, smokeConversion);
    return new NextResponse(new Uint8Array(result.buffer), {
      status: 200,
      headers: { 'Content-Type': result.mimeType, 'Cache-Control': 'no-store' },
    });
  } catch (error: unknown) {
    return deadlineErrorResponse(error, instanceUri) ?? serverFault('health/conversion', error, 'The smoke conversion failed on the server.');
  }
}
