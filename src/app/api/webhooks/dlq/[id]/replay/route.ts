import { NextRequest, NextResponse } from 'next/server';
import { dashboardRefusal as refusal, resolveDashboardCaller } from '@/lib/api/dashboard-refusal';
import { webhookDispatcher } from '@/lib/api-keys/webhook-dispatcher';
import { redactUrl } from '@/lib/security/redact';

export const dynamic = 'force-dynamic';

const HTTP_NOT_FOUND = 404;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, context: RouteContext) {
  const caller = await resolveDashboardCaller(req, { action: 'replay DLQ entry', adminKey: true });
  if ('refused' in caller) return caller.refused;
  const { id } = await context.params;

  const result = await webhookDispatcher.replayDlq(id, caller.user.id);
  if (!result) {
    return refusal(HTTP_NOT_FOUND, undefined, `DLQ entry "${id}" not found.`);
  }

  return NextResponse.json({
    success: result.success,
    deliveryId: result.id,
    url: redactUrl(result.url),
    event: result.event,
    statusCode: result.finalStatusCode,
    attempts: result.totalAttempts,
    durationMs: result.durationMs,
    message: result.success
      ? 'Webhook replayed successfully.'
      : 'Webhook replay attempted but delivery failed.',
  });
}
