import { NextRequest, NextResponse } from 'next/server';
import { dashboardRefusal as refusal, resolveDashboardCaller } from '@/lib/api/dashboard-refusal';
import { webhookDispatcher } from '@/lib/api-keys/webhook-dispatcher';
import { toPublicDlqEntry } from '@/lib/api-keys/public-views';

export const dynamic = 'force-dynamic';

const HTTP_NOT_FOUND = 404;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, context: RouteContext) {
  const caller = await resolveDashboardCaller(req, { action: 'read failed webhooks', scope: 'convert:read' });
  if ('refused' in caller) return caller.refused;
  const { id } = await context.params;

  const entry = await webhookDispatcher.getDlqEntry(id, caller.user.id);
  if (!entry) {
    return refusal(HTTP_NOT_FOUND, undefined, `DLQ entry "${id}" not found.`);
  }

  return NextResponse.json({
    success: true,
    entry: toPublicDlqEntry(entry),
  });
}

export async function DELETE(req: NextRequest, context: RouteContext) {
  const caller = await resolveDashboardCaller(req, { action: 'delete DLQ entry', adminKey: true });
  if ('refused' in caller) return caller.refused;
  const { id } = await context.params;

  const deleted = await webhookDispatcher.deleteDlqEntry(id, caller.user.id);
  if (!deleted) {
    return refusal(HTTP_NOT_FOUND, undefined, `DLQ entry "${id}" not found.`);
  }

  return NextResponse.json({
    success: true,
    message: `DLQ entry "${id}" removed successfully.`,
  });
}
