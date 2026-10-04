import { NextRequest, NextResponse } from 'next/server';
import { validateApiAccess } from '@/lib/api-keys/guard';
import { buildRateLimitHeaders } from '@/lib/api/rate-limit';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';
import { getUsageLedger } from '@/lib/quota/usage-ledger';

function parseTimestampParam(raw: string | null): number | undefined | null {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const parsedInt = Number.parseInt(trimmed, 10);
    return Number.isFinite(parsedInt) ? parsedInt : null;
  }
  const dateParsed = Date.parse(trimmed);
  return Number.isNaN(dateParsed) ? null : dateParsed;
}

function parseLimitParam(raw: string | null): number {
  if (!raw) return 50;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 50;
  return Math.min(200, parsed);
}

export async function GET(req: NextRequest) {
  const auth = await validateApiAccess(req, ['read:usage', 'read', 'admin']);
  if (!auth.authenticated || !auth.user) {
    return NextResponse.json(
      { error: auth.error || 'Unauthorized', code: 'UNAUTHORIZED' },
      { status: 401 }
    );
  }

  const searchParams = req.nextUrl.searchParams;
  const rawFrom = searchParams.get('from');
  const rawTo = searchParams.get('to');
  const rawLimit = searchParams.get('limit');

  const from = parseTimestampParam(rawFrom);
  if (from === null) {
    return NextResponse.json(
      { error: 'Invalid "from" query parameter. Expected epoch milliseconds or ISO 8601 string.', code: 'INVALID_QUERY_PARAM' },
      { status: 400 }
    );
  }

  const to = parseTimestampParam(rawTo);
  if (to === null) {
    return NextResponse.json(
      { error: 'Invalid "to" query parameter. Expected epoch milliseconds or ISO 8601 string.', code: 'INVALID_QUERY_PARAM' },
      { status: 400 }
    );
  }

  const limit = parseLimitParam(rawLimit);

  const ledger = getUsageLedger();
  const result = await ledger.queryUsage(auth.user.id, { from, to, limit });

  let rateLimitHeaders: Record<string, string> = {};
  try {
    const quota = await redisKeyStore.getQuotaUsage(auth.user.id);
    rateLimitHeaders = buildRateLimitHeaders(quota);
  } catch {
    // Best-effort quota header generation
  }

  return NextResponse.json(
    {
      success: true,
      items: result.items,
      totalUnits: result.totalUnits,
      count: result.count,
    },
    {
      status: 200,
      headers: {
        ...rateLimitHeaders,
        'Content-Type': 'application/json',
      },
    }
  );
}
