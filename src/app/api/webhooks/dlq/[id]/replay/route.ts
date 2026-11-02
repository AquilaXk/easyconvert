import { NextRequest, NextResponse } from 'next/server';
import { accessRefusal } from '@/lib/api/dashboard-refusal';
import { codedRefusal } from '@/lib/api/problem-details';
import type { DashboardRefusalCode } from '@/lib/refusal-codes';
import { getSessionFromRequest } from '@/lib/auth/session';
import { validateApiAccess } from '@/lib/api-keys/guard';
import { webhookDispatcher } from '@/lib/api-keys/webhook-dispatcher';
import { redactUrl } from '@/lib/security/redact';

export const dynamic = 'force-dynamic';

const refusal = codedRefusal<DashboardRefusalCode>;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, context: RouteContext) {
  let ownerUserId = (await getSessionFromRequest(req))?.id;
  if (!ownerUserId) {
    const auth = await validateApiAccess(req, 0);
    if (!auth.authorized || !auth.user) {
      return accessRefusal(auth, 'Unauthorized: Authentication required.');
    }
    if (auth.apiKey && !auth.apiKey.scopes?.includes('*')) {
      return refusal(403, 'admin_scope_required', 'Forbidden: API key lacks admin wildcard (*) scope to replay DLQ entry.');
    }
    ownerUserId = auth.user.id;
  }

  const resolvedParams = await Promise.resolve(context.params);
  const id = resolvedParams.id;
  if (!id) {
    return refusal(400, 'id_required', 'Missing DLQ entry ID.');
  }

  const result = await webhookDispatcher.replayDlq(id, ownerUserId);
  if (!result) {
    return refusal(404, 'not_found', `DLQ entry "${id}" not found.`);
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
