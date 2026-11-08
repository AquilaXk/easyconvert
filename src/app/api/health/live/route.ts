import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Liveness probe: 200 as long as this process serves requests. It reads no request, imports no store, queue or worker module and
 * calls nothing, so a Redis, storage or worker outage cannot turn it red; `/api/health` is the readiness probe that checks those.
 * The container health check asks this route, since restarting a web process does not repair a dependency. The host proxy does not
 * forward paths under /api/health/ (deploy/oci/nginx-easyconvert.conf), so only the loopback port answers it.
 */
export function GET(): NextResponse {
  return NextResponse.json({ status: 'alive' }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
}
