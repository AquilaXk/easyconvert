import { NextRequest, NextResponse } from 'next/server';
import { notFoundRefusal, resolveDashboardCaller } from '@/lib/api/dashboard-refusal';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function DELETE(req: NextRequest, context: RouteContext) {
  const caller = await resolveDashboardCaller(req, { action: 'delete converted files', scope: 'storage:download' });
  if ('refused' in caller) return caller.refused;
  const { id: fileId } = await context.params;

  const deleted = await redisKeyStore.deleteUserFile(caller.user.id, fileId);
  if (!deleted) {
    return notFoundRefusal('File record not found or not owned by user.');
  }

  return NextResponse.json({
    success: true,
    message: 'File record removed.',
  });
}
