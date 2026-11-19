import { NextRequest, NextResponse } from 'next/server';
import { conversionQueue } from '@/lib/queue/conversion-queue';
import { storageProvider } from '@/lib/storage';
import { withQueueErrors } from '@/lib/api/queue-error-response';
import { hasExternalProxyForwardingHeaders } from '@/lib/security/loopback-only-guard';

export const dynamic = 'force-dynamic';

const STATS_PATH = '/api/queue/stats';

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
