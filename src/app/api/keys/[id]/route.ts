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

  const keyId = params.id;
  if (!keyId) {
    return NextResponse.json(
      { success: false, error: 'Key ID parameter missing.' },
      { status: 400 }
    );
  }

  const revoked = await keyStore.revokeApiKey(user.id, keyId);
  if (!revoked) {
    return NextResponse.json(
      { success: false, error: 'API key not found or not owned by the current user.' },
      { status: 404 }
    );
  }

  return NextResponse.json({
    success: true,
    message: 'API key successfully revoked.',
  });
}
