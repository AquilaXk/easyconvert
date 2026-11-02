import { NextRequest, NextResponse } from 'next/server';
import { resolveDashboardCaller } from '@/lib/api/dashboard-refusal';
import { webhookDispatcher } from '@/lib/api-keys/webhook-dispatcher';
import { toPublicDlqEntry } from '@/lib/api-keys/public-views';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const caller = await resolveDashboardCaller(req, { action: 'read failed webhooks', scope: 'convert:read' });
  if ('refused' in caller) return caller.refused;

  const entries = await webhookDispatcher.getDlqEntries(caller.user.id);
  return NextResponse.json({
    success: true,
    total: entries.length,
    entries: entries.map(toPublicDlqEntry),
  });
}

export async function DELETE(req: NextRequest) {
  const caller = await resolveDashboardCaller(req, { action: 'clear DLQ', adminKey: true });
  if ('refused' in caller) return caller.refused;

  await webhookDispatcher.clearDlq(caller.user.id);
  return NextResponse.json({
    success: true,
    message: 'Dead letter queue cleared successfully.',
  });
}
