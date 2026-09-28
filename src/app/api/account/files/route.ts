import { NextRequest, NextResponse } from 'next/server';
import { validateApiAccess } from '@/lib/api-keys/guard';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await validateApiAccess(req, 0, 'storage:download');
  if (!auth.authorized || !auth.user) {
    return NextResponse.json(
      { success: false, error: auth.error ?? 'Unauthorized: Sign in or valid API key required.' },
      { status: auth.status ?? 401 }
    );
  }

  const files = await redisKeyStore.listUserFiles(auth.user.id);
  const now = Date.now();

  const formattedFiles = files.map((file) => ({
    ...file,
    remainingSeconds: Math.max(0, Math.floor((file.expiresAt - now) / 1000)),
  }));

  return NextResponse.json({
    success: true,
    files: formattedFiles,
  });
}
