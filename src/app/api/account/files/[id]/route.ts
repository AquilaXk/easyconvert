import { NextRequest, NextResponse } from 'next/server';
import { notFoundRefusal, resolveDashboardCaller } from '@/lib/api/dashboard-refusal';
import { storageErrorResponse } from '@/lib/api/storage-error-response';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';
import { storageProvider } from '@/lib/storage';
import { classifyStorageKey } from '@/lib/storage/key-namespace';
import { eraseOwnedFile } from '@/lib/storage/retention-service';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function DELETE(req: NextRequest, context: RouteContext) {
  const caller = await resolveDashboardCaller(req, { action: 'delete converted files', scope: 'storage:download' });
  if ('refused' in caller) return caller.refused;
  const { id: fileId } = await context.params;

  const record = await redisKeyStore.findUserFile(caller.user.id, fileId);
  if (!record) {
    return notFoundRefusal('File record not found or not owned by user.');
  }

  // The stored file goes first: a store that fails leaves the record, so the request can be sent again.
  const stored = record.storageKey ? classifyStorageKey(record.storageKey) : undefined;
  if (record.storageKey && stored?.namespace === 'user-conversion' && stored.userId === caller.user.id) {
    try {
      await eraseOwnedFile(storageProvider, record.storageKey);
    } catch (error: unknown) {
      const problem = storageErrorResponse(error, req.nextUrl?.pathname ?? '/api/account/files');
      if (problem) return problem;
      throw error;
    }
  }
  if (!(await redisKeyStore.deleteUserFile(caller.user.id, fileId))) {
    return notFoundRefusal('File record not found or not owned by user.');
  }

  return NextResponse.json({
    success: true,
    message: 'File removed.',
  });
}
