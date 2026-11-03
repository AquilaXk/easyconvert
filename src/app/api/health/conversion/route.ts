import { NextRequest, NextResponse } from 'next/server';
import { deadlineErrorResponse, runUnderDeadline } from '@/lib/api/sync-deadline';
import { serverFault } from '@/lib/api/problem-details';
import { dispatchConversion } from '@/lib/conversions/dispatch';
import { bindJobLimits } from '@/lib/conversions/job-time';

export const dynamic = 'force-dynamic';

/** A one-pixel red PPM, which ImageMagick decodes in the sandboxed child that every native conversion starts in. */
const SMOKE_PPM = Buffer.concat([Buffer.from('P6\n1 1\n255\n', 'latin1'), Buffer.from([0xff, 0x00, 0x00])]);
/** Answers before deploy.sh stops waiting (`curl --max-time 60`), so a slow sandbox is logged as this route's 504. */
const SMOKE_DEADLINE_MS = 30_000;

/**
 * The deploy's smoke conversion (deploy/oci/deploy.sh): the fixed picture above to PNG, through the dispatcher that /api/convert
 * uses. It reads nothing of the request, so it is no conversion service: it charges no allowance and gives a caller nothing of its
 * own converted. The host proxy does not forward paths under /api/health/ (deploy/oci/nginx-easyconvert.conf).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const instanceUri = req.nextUrl?.pathname || '/api/health/conversion';
  try {
    const result = await runUnderDeadline(req, SMOKE_DEADLINE_MS, (limits) =>
      dispatchConversion(SMOKE_PPM, 'ppm', 'png', bindJobLimits({}, limits), 'smoke.ppm')
    );
    return new NextResponse(new Uint8Array(result.buffer), {
      status: 200,
      headers: { 'Content-Type': result.mimeType, 'Cache-Control': 'no-store' },
    });
  } catch (error: unknown) {
    return deadlineErrorResponse(error, instanceUri) ?? serverFault('health/conversion', error, 'The smoke conversion failed on the server.');
  }
}
