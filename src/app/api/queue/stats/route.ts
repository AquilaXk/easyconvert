import { NextResponse } from 'next/server';
import { conversionQueue } from '@/lib/queue/conversion-queue';
import { storageProvider } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function GET() {
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
