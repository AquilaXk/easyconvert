import { NextRequest, NextResponse } from 'next/server';
import { deadlineErrorResponse, runUnderDeadline } from '@/lib/api/sync-deadline';
import { serverFault } from '@/lib/api/problem-details';
import { SMOKE_DEADLINE_MS, smokeConversion } from '@/lib/health/smoke-conversion';
import { hasExternalProxyForwardingHeaders } from '@/lib/security/loopback-only-guard';

export const dynamic = 'force-dynamic';

/**
 * The deploy's smoke conversion (deploy/oci/deploy.sh): a fixed one-pixel PPM to PNG, through the dispatcher that /api/convert
 * uses. It reads nothing of the request, so it is no conversion service: it charges no allowance and gives a caller nothing of its
 * own converted, and calling it more often adds no conversion. Both nginx (deploy/oci/nginx-easyconvert.conf) and this route
 * in production refuse forwarded requests directly with 404 before launching any conversion.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  if (process.env.NODE_ENV === 'production' && hasExternalProxyForwardingHeaders(req.headers)) {
    return NextResponse.json({ error: 'Not Found' }, { status: 404 });
  }
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
