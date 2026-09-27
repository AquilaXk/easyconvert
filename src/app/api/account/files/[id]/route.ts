import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/auth/session';
import { keyStore } from '@/lib/api-keys/key-store';

export const dynamic = 'force-dynamic';

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await getSessionFromRequest(req);
  if (!user) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized: Sign in required.' },
      { status: 401 }
    );
  }

  const fileId = params.id;
  const deleted = await keyStore.deleteUserFile(user.id, fileId);

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
