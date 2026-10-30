import { NextRequest, NextResponse } from 'next/server';
import { validateApiAccess, authErrorHeaders } from '@/lib/api-keys/guard';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';
import { resultAvailability } from '@/lib/storage/retention-service';

export const dynamic = 'force-dynamic';

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
  const availabilities = await Promise.all(
    files.map((file) => (file.storageKey ? resultAvailability(file.storageKey, now) : undefined))
  );
  const formattedFiles = files.flatMap((file, index) => {
    const availability = availabilities[index];
    if (availability?.state === 'deleted') return [];
    const expiresAt = Math.min(file.expiresAt, availability?.deleteAt ?? file.expiresAt);
    return [{ ...file, expiresAt, remainingSeconds: Math.max(0, Math.floor((expiresAt - now) / 1000)) }];
  });

  return NextResponse.json({
    success: true,
    files: formattedFiles,
  });
}
