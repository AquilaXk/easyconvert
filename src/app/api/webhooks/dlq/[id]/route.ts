import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/auth/session';
import { validateApiAccess } from '@/lib/api-keys/guard';
import { webhookDispatcher } from '@/lib/api-keys/webhook-dispatcher';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }> | { id: string };
}

export async function GET(req: NextRequest, context: RouteContext) {
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

  const resolvedParams = await Promise.resolve(context.params);
  const id = resolvedParams.id;
  if (!id) {
    return NextResponse.json(
      { success: false, error: 'Missing DLQ entry ID.' },
      { status: 400 }
    );
  }

  const entry = await webhookDispatcher.getDlqEntry(id);
  if (!entry) {
    return NextResponse.json(
      { success: false, error: `DLQ entry "${id}" not found.` },
      { status: 404 }
    );
  }

  return NextResponse.json({
    success: true,
    entry,
  });
}

export async function DELETE(req: NextRequest, context: RouteContext) {
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

  const resolvedParams = await Promise.resolve(context.params);
  const id = resolvedParams.id;
  if (!id) {
    return NextResponse.json(
      { success: false, error: 'Missing DLQ entry ID.' },
      { status: 400 }
    );
  }

  const deleted = await webhookDispatcher.deleteDlqEntry(id);
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
