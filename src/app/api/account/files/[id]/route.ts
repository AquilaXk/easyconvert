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
  // A synchronous conversion is stored under its owner's name; a queue job's result under its job id, and its record, made by the
  // job's completion, is the owner's.
  const stored = record.storageKey ? classifyStorageKey(record.storageKey) : undefined;
  // A job's record is made under the job id, so its result is the one under `results/<record id>/`; a final output of a graph is
  // recorded under its own id and names the graph, so its key is the one under `results/<graphId>/`. Any other key is not deleted.
  if (stored?.namespace === 'job-result' && stored.jobId !== (record.graphId ?? record.id)) {
    return notFoundRefusal('File record not found or not owned by user.');
  }
  const ownsStored = stored?.namespace === 'job-result' || (stored?.namespace === 'user-conversion' && stored.userId === caller.user.id);
  if (record.storageKey && ownsStored) {
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
