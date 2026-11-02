import { NextRequest, NextResponse } from 'next/server';
import { accessRefusal } from '@/lib/api/dashboard-refusal';
import { codedRefusal } from '@/lib/api/problem-details';
import type { DashboardRefusalCode } from '@/lib/refusal-codes';
import { validateApiAccess } from '@/lib/api-keys/guard';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';

export const dynamic = 'force-dynamic';

const refusal = codedRefusal<DashboardRefusalCode>;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function DELETE(req: NextRequest, context: RouteContext) {
  const auth = await validateApiAccess(req, 0, 'storage:download');
  if (!auth.authorized || !auth.user) {
    return accessRefusal(auth, 'Unauthorized: Sign in or valid API key required.');
  }

  const resolvedParams = await Promise.resolve(context.params);
  const fileId = resolvedParams.id;
  if (!fileId) {
    return refusal(400, 'id_required', 'File ID parameter missing.');
  }
  const deleted = await redisKeyStore.deleteUserFile(auth.user.id, fileId);

  if (!deleted) {
    return refusal(404, 'not_found', 'File record not found or not owned by user.');
  }

  return NextResponse.json({
    success: true,
    message: 'File record removed.',
  });
}
