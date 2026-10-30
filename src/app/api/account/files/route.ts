import { NextRequest, NextResponse } from 'next/server';
import { validateApiAccess, authErrorHeaders } from '@/lib/api-keys/guard';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';
import { resultAvailability } from '@/lib/storage/retention-service';

export const dynamic = 'force-dynamic';

const DOWNLOAD_PATH_PREFIX = '/api/storage/file/';

/** The storage key a `downloadUrl` of this application names. */
function storageKeyOf(downloadUrl: string): string {
  return decodeURIComponent(downloadUrl.slice(DOWNLOAD_PATH_PREFIX.length));
}

export async function GET(req: NextRequest) {
  const auth = await validateApiAccess(req, 0, 'storage:download');
  if (!auth.authorized || !auth.user) {
    return NextResponse.json(
      { success: false, error: auth.error ?? 'Unauthorized: Sign in or valid API key required.' },
      { status: auth.status ?? 401, headers: authErrorHeaders(auth) }
    );
  }

  const files = await redisKeyStore.listUserFiles(auth.user.id);
  const now = Date.now();

  // A file the retention rule already deleted is not listed, and one that is about to go counts down to that time.
  const formattedFiles = [];
  for (const file of files) {
    const availability = await resultAvailability(storageKeyOf(file.downloadUrl), now);
    if (availability?.state === 'deleted') continue;
    const expiresAt = Math.min(file.expiresAt, availability?.deleteAt ?? file.expiresAt);
    formattedFiles.push({ ...file, expiresAt, remainingSeconds: Math.max(0, Math.floor((expiresAt - now) / 1000)) });
  }

  return NextResponse.json({
    success: true,
    files: formattedFiles,
  });
}
