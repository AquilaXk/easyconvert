import { NextRequest, NextResponse } from 'next/server';
import { validateApiAccess } from '@/lib/api-keys/guard';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';

export const dynamic = 'force-dynamic';

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await validateApiAccess(req, 0, 'storage:download');
  if (!auth.authorized || !auth.user) {
    return NextResponse.json(
      { success: false, error: auth.error ?? 'Unauthorized: Sign in or valid API key required.' },
      { status: auth.status ?? 401 }
    );
  }

  const fileId = params.id;
  const deleted = await redisKeyStore.deleteUserFile(auth.user.id, fileId);

  if (!deleted) {
    return NextResponse.json(
      { success: false, error: 'File record not found or not owned by user.' },
      { status: 404 }
    );
  }

  return NextResponse.json({
    success: true,
    message: 'File record removed.',
  });
}
