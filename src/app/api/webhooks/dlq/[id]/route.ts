import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/auth/session';
import { validateApiAccess, authErrorHeaders } from '@/lib/api-keys/guard';
import { webhookDispatcher } from '@/lib/api-keys/webhook-dispatcher';
import { toPublicDlqEntry } from '@/lib/api-keys/public-views';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, context: RouteContext) {
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

  const resolvedParams = await Promise.resolve(context.params);
  const id = resolvedParams.id;
  if (!id) {
    return NextResponse.json(
      { success: false, error: 'Missing DLQ entry ID.' },
      { status: 400 }
    );
  }

  const entry = await webhookDispatcher.getDlqEntry(id, ownerUserId);
  if (!entry) {
    return NextResponse.json(
      { success: false, error: `DLQ entry "${id}" not found.` },
      { status: 404 }
    );
  }

  return NextResponse.json({
    success: true,
    entry: toPublicDlqEntry(entry),
  });
}

export async function DELETE(req: NextRequest, context: RouteContext) {
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
        { success: false, error: 'Forbidden: API key lacks admin wildcard (*) scope to delete DLQ entry.' },
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

  const deleted = await webhookDispatcher.deleteDlqEntry(id, ownerUserId);
  if (!deleted) {
    return NextResponse.json(
      { success: false, error: `DLQ entry "${id}" not found.` },
      { status: 404 }
    );
  }

  return NextResponse.json({
    success: true,
    message: `DLQ entry "${id}" removed successfully.`,
  });
}
