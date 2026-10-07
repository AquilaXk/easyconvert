import { NextRequest, NextResponse } from 'next/server';
import { authErrorHeaders, extractApiKeySecret, validateApiAccess } from '@/lib/api-keys/guard';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import { getHealthReport } from '@/lib/health/probes';

export const dynamic = 'force-dynamic';

const HTTP_OK = 200;
const HTTP_FORBIDDEN = 403;
const HTTP_SERVICE_UNAVAILABLE = 503;
/** An API key holding this scope is an administrator (the convention of the key and DLQ routes). */
const ADMIN_WILDCARD_SCOPE = '*';
/** The verdict changes with the dependencies, so no intermediary may reuse it. */
const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * Readiness probe. Everyone gets `{ status }` with 200 (healthy) or 503 (unhealthy). A request that
 * carries an API key with the wildcard scope also gets the per-component view.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const instanceUri = req.nextUrl?.pathname || '/api/health';
  const wantsDetail = extractApiKeySecret(req) !== null;

  if (wantsDetail) {
    let auth: Awaited<ReturnType<typeof validateApiAccess>>;
    try {
      auth = await validateApiAccess(req, { requiredUnits: 0 });
    } catch {
      // The key store is itself a dependency: without it nobody can be shown the detail.
      return createProblemDetailsResponse(
        HTTP_SERVICE_UNAVAILABLE,
        'The API key store is unavailable, so the detailed health view cannot be authorised.',
        instanceUri
      );
    }
    if (!auth.authorized || !auth.user) {
      return createProblemDetailsResponse(
        auth.status ?? 401,
        auth.error ?? 'Unauthorized',
        instanceUri,
        undefined,
        auth.problemType,
        authErrorHeaders(auth)
      );
    }
    if (!auth.apiKey?.scopes?.includes(ADMIN_WILDCARD_SCOPE)) {
      return createProblemDetailsResponse(
        HTTP_FORBIDDEN,
        'Forbidden: the detailed health view needs an API key with the admin wildcard (*) scope.',
        instanceUri
      );
    }
  }

  const report = await getHealthReport();
  const status = report.status === 'healthy' ? HTTP_OK : HTTP_SERVICE_UNAVAILABLE;
  const body = wantsDetail ? report : { status: report.status };
  return NextResponse.json(body, { status, headers: NO_STORE });
}
