import { NextRequest, NextResponse } from 'next/server';
import { deadlineErrorResponse, runUnderDeadline } from '@/lib/api/sync-deadline';
import { serverFault } from '@/lib/api/problem-details';
import { SMOKE_DEADLINE_MS, smokeConversion } from '@/lib/health/smoke-conversion';

export const dynamic = 'force-dynamic';

/**
 * The deploy's smoke conversion (deploy/oci/deploy.sh): a fixed one-pixel PPM to PNG, through the dispatcher that /api/convert
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
