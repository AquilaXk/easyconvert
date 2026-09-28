import { NextRequest, NextResponse } from 'next/server';
import { validateApiAccess } from '@/lib/api-keys/guard';
import { conversionQueue } from '@/lib/queue/conversion-queue';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }> | { id: string };
}

export async function GET(req: NextRequest, context: RouteContext) {
  const auth = await validateApiAccess(req, 0, 'convert:read');
  if (!auth.authorized || !auth.user) {
    return NextResponse.json(
      {
        success: false,
        error: auth.error ?? 'Unauthorized',
      },
      { status: auth.status ?? 401 }
    );
  }

  const resolvedParams = await Promise.resolve(context.params);
  const jobId = resolvedParams.id;

  if (!jobId) {
    return NextResponse.json(
      { success: false, error: 'Missing job ID in request path.' },
      { status: 400 }
    );
  }

  const job = await conversionQueue.getJob(jobId);
  if (!job) {
    return NextResponse.json(
      { success: false, error: `Job with ID "${jobId}" not found.` },
      { status: 404 }
    );
  }

  // Enforce tenant boundary: user can only inspect their own jobs
  if (!job.data?.userId || job.data.userId !== auth.user.id) {
    return NextResponse.json(
      { success: false, error: 'Access denied to this conversion job.' },
      { status: 403 }
    );
  }

  return NextResponse.json({
    success: true,
    jobId: job.id,
    status: job.state,
    progress: job.progress,
    sourceFormat: job.data?.sourceFormat,
    targetFormat: job.data?.targetFormat,
    originalFilename: job.data?.originalFilename,
    fileSize: job.data?.fileSize,
    createdAt: job.timestamp,
    processedOn: job.processedOn,
    finishedOn: job.finishedOn,
    attemptsMade: job.attemptsMade,
    failedReason: job.failedReason,
    result: job.returnvalue,
    logs: job.logs,
  });
}
