import { NextRequest, NextResponse } from 'next/server';
import { accessRefusal } from '@/lib/api/dashboard-refusal';
import { codedRefusal } from '@/lib/api/problem-details';
import type { DashboardRefusalCode } from '@/lib/refusal-codes';
import { getSessionFromRequest } from '@/lib/auth/session';
import { validateApiAccess } from '@/lib/api-keys/guard';
import { webhookDispatcher } from '@/lib/api-keys/webhook-dispatcher';
import { toPublicDlqEntry } from '@/lib/api-keys/public-views';

export const dynamic = 'force-dynamic';

const refusal = codedRefusal<DashboardRefusalCode>;

export async function GET(req: NextRequest) {
  let ownerUserId = (await getSessionFromRequest(req))?.id;
  if (!ownerUserId) {
    const auth = await validateApiAccess(req, 0, 'convert:read');
    if (!auth.authorized || !auth.user) {
      return accessRefusal(auth, 'Unauthorized: Authentication required.');
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
      return accessRefusal(auth, 'Unauthorized: Authentication required.');
    }
    if (auth.apiKey && !auth.apiKey.scopes?.includes('*')) {
      return refusal(403, 'admin_scope_required', 'Forbidden: API key lacks admin wildcard (*) scope to clear DLQ.');
    }
    ownerUserId = auth.user.id;
  }

  await webhookDispatcher.clearDlq(ownerUserId);
  return NextResponse.json({
    success: true,
    message: 'Dead letter queue cleared successfully.',
  });
}
