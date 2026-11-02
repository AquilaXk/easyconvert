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

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, context: RouteContext) {
  let ownerUserId = (await getSessionFromRequest(req))?.id;
  if (!ownerUserId) {
    const auth = await validateApiAccess(req, 0, 'convert:read');
    if (!auth.authorized || !auth.user) {
      return accessRefusal(auth, 'Unauthorized: Authentication required.');
    }
    ownerUserId = auth.user.id;
  }

  const resolvedParams = await Promise.resolve(context.params);
  const id = resolvedParams.id;
  if (!id) {
    return refusal(400, 'id_required', 'Missing DLQ entry ID.');
  }

  const entry = await webhookDispatcher.getDlqEntry(id, ownerUserId);
  if (!entry) {
    return refusal(404, 'not_found', `DLQ entry "${id}" not found.`);
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
      return accessRefusal(auth, 'Unauthorized: Authentication required.');
    }
    if (auth.apiKey && !auth.apiKey.scopes?.includes('*')) {
      return refusal(403, 'admin_scope_required', 'Forbidden: API key lacks admin wildcard (*) scope to delete DLQ entry.');
    }
    ownerUserId = auth.user.id;
  }

  const resolvedParams = await Promise.resolve(context.params);
  const id = resolvedParams.id;
  if (!id) {
    return refusal(400, 'id_required', 'Missing DLQ entry ID.');
  }

  const deleted = await webhookDispatcher.deleteDlqEntry(id, ownerUserId);
  if (!deleted) {
    return refusal(404, 'not_found', `DLQ entry "${id}" not found.`);
  }

  return NextResponse.json({
    success: true,
    message: `DLQ entry "${id}" removed successfully.`,
  });
}
