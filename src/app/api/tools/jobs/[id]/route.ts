import { NextRequest, NextResponse } from 'next/server';
import { validateApiAccess, authErrorHeaders } from '@/lib/api-keys/guard';
import { isAnonymousUserId } from '@/lib/auth/anonymous-identity';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import { storageProvider as s3Storage } from '@/lib/storage';
import { eraseOwnedFile } from '@/lib/storage/retention-service';
import { cancelToolJob, deleteToolJob, getToolJob, type StoredToolJobResult, type ToolJobState } from '@/lib/tools/tool-job-store';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

function isJobVisibleToCaller(job: ToolJobState, callerUserId: string): boolean {
  return isAnonymousUserId(job.userId) || job.userId === callerUserId;
}

export async function GET(req: NextRequest, context: RouteContext) {
  const resolvedParams = await context.params;
  const jobId = resolvedParams.id;
  const instanceUri = req.nextUrl?.pathname || `/api/tools/jobs/${jobId}`;

  const auth = await validateApiAccess(req, { requiredUnits: 0, requiredScope: 'convert:read', allowAnonymous: true });
  if (!auth.authorized || !auth.user) {
    return createProblemDetailsResponse(
      auth.status ?? 401,
      auth.error ?? 'Unauthorized',
      instanceUri,
      undefined,
      auth.problemType,
      authErrorHeaders(auth)
    );
  }

  const job = await getToolJob(jobId);
  if (!job || !isJobVisibleToCaller(job, auth.user.id)) {
    return NextResponse.json({ success: false, error: 'Job not found.' }, { status: 404 });
  }

  return NextResponse.json({
    success: true,
    id: job.id,
    status: job.status,
    progress: job.progress,
    result: job.result?.kind === 'file' ? job.result.file : undefined,
    toolResult: job.result,
    error: job.error,
  });
}

function resultKeysOf(result: StoredToolJobResult | undefined): string[] {
  if (!result) return [];
  if (result.kind === 'file') return result.file.key ? [result.file.key] : [];
  if (result.kind === 'entries') return result.entries.map((entry) => entry.key);
  return [];
}

export async function DELETE(req: NextRequest, context: RouteContext) {
  const resolvedParams = await context.params;
  const jobId = resolvedParams.id;
  const instanceUri = req.nextUrl?.pathname || `/api/tools/jobs/${jobId}`;

  const auth = await validateApiAccess(req, { requiredUnits: 0, requiredScope: 'convert:write', allowAnonymous: true });
  if (!auth.authorized || !auth.user) {
    return createProblemDetailsResponse(
      auth.status ?? 401,
      auth.error ?? 'Unauthorized',
      instanceUri,
      undefined,
      auth.problemType,
      authErrorHeaders(auth)
    );
  }

  const job = await getToolJob(jobId);
  if (!job || !isJobVisibleToCaller(job, auth.user.id)) {
    return NextResponse.json({ success: false, error: 'Job not found.' }, { status: 404 });
  }

  if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
    await Promise.all(resultKeysOf(job.result).map((key) => eraseOwnedFile(s3Storage, key).catch(() => undefined)));
    await deleteToolJob(jobId);
    return NextResponse.json({ success: true, message: 'Job deleted.' });
  }

  await cancelToolJob(jobId);
  return NextResponse.json({ success: true, message: 'Job cancelled.' });
}
