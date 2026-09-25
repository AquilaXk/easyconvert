import { NextResponse } from 'next/server';
import { conversionQueue } from '@/lib/queue/conversion-queue';
import { s3Storage } from '@/lib/storage/s3-storage';

export const dynamic = 'force-dynamic';

export async function GET() {
  const counts = await conversionQueue.getJobCounts();

  return NextResponse.json({
    success: true,
    queue: conversionQueue.name,
    counts,
    storage: {
      activeUploadSessions: s3Storage.getActiveSessionsCount(),
      storedObjects: s3Storage.getObjectsCount(),
    },
    system: {
      uptimeSeconds: Math.floor(process.uptime()),
      memoryUsageMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    },
  });
}
