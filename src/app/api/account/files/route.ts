import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/auth/session';
import { keyStore } from '@/lib/api-keys/key-store';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await getSessionFromRequest(req);
  if (!user) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized: Sign in required.' },
      { status: 401 }
    );
  }

  const files = await keyStore.listUserFiles(user.id);
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
