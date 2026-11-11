import { NextRequest, NextResponse } from 'next/server';
import { resolveDashboardCaller } from '@/lib/api/dashboard-refusal';
import { webhookDispatcher } from '@/lib/api-keys/webhook-dispatcher';
import { toPublicDlqEntry } from '@/lib/api-keys/public-views';
import { DLQ_PAGE_DEFAULT } from '@/lib/api-keys/webhook-dlq-store';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const caller = await resolveDashboardCaller(req, { action: 'read failed webhooks', scope: 'convert:read' });
  if ('refused' in caller) return caller.refused;

  const { searchParams } = new URL(req.url);
  const limit = Number(searchParams.get('limit') ?? DLQ_PAGE_DEFAULT);
  const offset = Number(searchParams.get('offset') ?? 0);
  const page = await webhookDispatcher.getDlqPage(caller.user.id, {
    limit: Number.isFinite(limit) ? limit : DLQ_PAGE_DEFAULT,
    offset: Number.isFinite(offset) ? offset : 0,
  });
  return NextResponse.json({
    success: true,
    total: page.total,
    entries: page.entries.map(toPublicDlqEntry),
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
