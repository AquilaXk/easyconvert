import { NextRequest, NextResponse } from 'next/server';
import { dashboardRefusal as refusal, resolveDashboardCaller } from '@/lib/api/dashboard-refusal';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';

export const dynamic = 'force-dynamic';

const HTTP_NOT_FOUND = 404;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function DELETE(req: NextRequest, context: RouteContext) {
  const caller = await resolveDashboardCaller(req, { action: 'delete converted files', scope: 'storage:download' });
  if ('refused' in caller) return caller.refused;
  const { id: fileId } = await context.params;

  const deleted = await redisKeyStore.deleteUserFile(caller.user.id, fileId);
  if (!deleted) {
    return refusal(HTTP_NOT_FOUND, undefined, 'File record not found or not owned by user.');
  }

  return NextResponse.json({
    success: true,
    message: 'File record removed.',
  });
}
