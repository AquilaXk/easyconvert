import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/auth/session';
import { validateApiAccess } from '@/lib/api-keys/guard';
import { webhookDispatcher } from '@/lib/api-keys/webhook-dispatcher';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const sessionUser = await getSessionFromRequest(req);
  if (!sessionUser) {
    const auth = await validateApiAccess(req, 0);
    if (!auth.authorized) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized: Authentication required.' },
        { status: 401 }
      );
    }
  }

  const entries = await webhookDispatcher.getDlqEntries();
  return NextResponse.json({
    success: true,
    total: entries.length,
    entries,
  });
}

export async function DELETE(req: NextRequest) {
  const sessionUser = await getSessionFromRequest(req);
  if (!sessionUser) {
    const auth = await validateApiAccess(req, 0);
    if (!auth.authorized) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized: Authentication required.' },
        { status: 401 }
      );
    }
  }

  await webhookDispatcher.clearDlq();
  return NextResponse.json({
    success: true,
    message: 'Dead letter queue cleared successfully.',
  });
}
