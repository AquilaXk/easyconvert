import { NextRequest, NextResponse } from 'next/server';
import { conversionQueue } from '@/lib/queue/conversion-queue';
import { storageProvider } from '@/lib/storage';
import { withQueueErrors } from '@/lib/api/queue-error-response';

export const dynamic = 'force-dynamic';

const STATS_PATH = '/api/queue/stats';

function isLoopbackIp(raw: string): boolean {
  const normalized = raw.trim().replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === '::ffff:127.0.0.1';
}

function hasExternalProxyForwardingHeaders(headers: Headers): boolean {
  if (headers.has('x-forwarded-for') || headers.has('cf-connecting-ip')) {
    return true;
  }
  const realIp = headers.get('x-real-ip');
  return realIp !== null && !isLoopbackIp(realIp);
}

export async function GET(): Promise<NextResponse>;
export async function GET(req: NextRequest | Request): Promise<NextResponse>;
export async function GET(req?: NextRequest | Request): Promise<NextResponse> {
  if (process.env.NODE_ENV === 'production' && req && hasExternalProxyForwardingHeaders(req.headers)) {
    return NextResponse.json({ error: 'Not Found' }, { status: 404 });
  }
  return withQueueErrors(STATS_PATH, readStats);
}

async function readStats() {
  const counts = await conversionQueue.getJobCounts();

  return NextResponse.json({
    success: true,
    queue: conversionQueue.name,
    counts,
    storage: {
      activeUploadSessions: await storageProvider.getActiveSessionsCount(),
      storedObjects: await storageProvider.getObjectsCount(),
    },
    system: {
      uptimeSeconds: Math.floor(process.uptime()),
      memoryUsageMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    },
  });
}
