import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/auth/session';
import { validateApiAccess, authErrorHeaders } from '@/lib/api-keys/guard';
import { webhookDispatcher } from '@/lib/api-keys/webhook-dispatcher';
import { toPublicDlqEntry } from '@/lib/api-keys/public-views';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  let ownerUserId = (await getSessionFromRequest(req))?.id;
  if (!ownerUserId) {
    const auth = await validateApiAccess(req, 0, 'convert:read');
    if (!auth.authorized || !auth.user) {
      return NextResponse.json(
        { success: false, error: auth.error ?? 'Unauthorized: Authentication required.' },
        { status: auth.status ?? 401, headers: authErrorHeaders(auth) }
      );
    }
    ownerUserId = auth.user.id;
  }

  const entries = await webhookDispatcher.getDlqEntries(ownerUserId);
  return NextResponse.json({
    success: true,
    total: entries.length,
    entries: entries.map(toPublicDlqEntry),
  });
}

export async function DELETE(req: NextRequest) {
  let ownerUserId = (await getSessionFromRequest(req))?.id;
  if (!ownerUserId) {
    const auth = await validateApiAccess(req, 0);
    if (!auth.authorized || !auth.user) {
      return NextResponse.json(
        { success: false, error: auth.error ?? 'Unauthorized: Authentication required.' },
        { status: auth.status ?? 401, headers: authErrorHeaders(auth) }
      );
    }
    if (auth.apiKey && !auth.apiKey.scopes?.includes('*')) {
      return NextResponse.json(
        { success: false, error: 'Forbidden: API key lacks admin wildcard (*) scope to clear DLQ.' },
        { status: 403 }
      );
    }
    ownerUserId = auth.user.id;
  }

  await webhookDispatcher.clearDlq(ownerUserId);
  return NextResponse.json({
    success: true,
    message: 'Dead letter queue cleared successfully.',
  });
}
