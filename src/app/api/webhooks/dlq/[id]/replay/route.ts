import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/auth/session';
import { validateApiAccess, authErrorHeaders } from '@/lib/api-keys/guard';
import { webhookDispatcher } from '@/lib/api-keys/webhook-dispatcher';
import { redactUrl } from '@/lib/security/redact';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, context: RouteContext) {
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
        { success: false, error: 'Forbidden: API key lacks admin wildcard (*) scope to replay DLQ entry.' },
        { status: 403 }
      );
    }
    ownerUserId = auth.user.id;
  }

  const resolvedParams = await Promise.resolve(context.params);
  const id = resolvedParams.id;
  if (!id) {
    return NextResponse.json(
      { success: false, error: 'Missing DLQ entry ID.' },
      { status: 400 }
    );
  }

  const result = await webhookDispatcher.replayDlq(id, ownerUserId);
  if (!result) {
    return NextResponse.json(
      { success: false, error: `DLQ entry "${id}" not found.` },
      { status: 404 }
    );
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
