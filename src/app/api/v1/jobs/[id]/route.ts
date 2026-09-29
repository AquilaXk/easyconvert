import { NextRequest, NextResponse } from 'next/server';
import { validateApiAccess, authErrorHeaders } from '@/lib/api-keys/guard';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';
import { conversionQueue } from '@/lib/queue/conversion-queue';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }> | { id: string };
}

export async function GET(req: NextRequest, context: RouteContext) {
  const resolvedParams = await Promise.resolve(context.params);
  const jobId = resolvedParams.id;
  const instanceUri = req.nextUrl?.pathname || `/api/v1/jobs/${jobId || ''}`;

  const auth = await validateApiAccess(req, { requiredUnits: 0, requiredScope: 'convert:read' });
  if (!auth.authorized || !auth.user) {
    return createProblemDetailsResponse(
      auth.status ?? 401,
      auth.error ?? 'Unauthorized',
      instanceUri,
      undefined,
      undefined,
      authErrorHeaders(auth)
    );
  }

  if (!jobId) {
    return createProblemDetailsResponse(
      400,
      'Missing job ID in request path.',
      instanceUri,
      'Bad Request'
    );
  }

  const job = await conversionQueue.getJob(jobId);
  if (!job) {
    return createProblemDetailsResponse(
      404,
      `Job with ID "${jobId}" not found.`,
      instanceUri,
      'Not Found'
    );
  }

  // Enforce tenant boundary: user can only inspect their own jobs
  if (!job.data?.userId || job.data.userId !== auth.user.id) {
    return createProblemDetailsResponse(
      403,
      'Access denied to this conversion job.',
      instanceUri,
      'Forbidden'
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
    tasks: job.data?.tasks,
    logs: job.logs,
  });
}

export async function DELETE(req: NextRequest, context: RouteContext) {
  const resolvedParams = await Promise.resolve(context.params);
  const jobId = resolvedParams.id;
  const instanceUri = req.nextUrl?.pathname || `/api/v1/jobs/${jobId || ''}`;

  // Require write access to cancel conversion job
  const auth = await validateApiAccess(req, { requiredUnits: 0, requiredScope: 'convert:write' });
  if (!auth.authorized || !auth.user) {
    return createProblemDetailsResponse(
      auth.status ?? 401,
      auth.error ?? 'Unauthorized',
      instanceUri,
      undefined,
      undefined,
      authErrorHeaders(auth)
    );
  }

  if (!jobId) {
    return createProblemDetailsResponse(
      400,
      'Missing job ID in request path.',
      instanceUri,
      'Bad Request'
    );
  }

  const job = await conversionQueue.getJob(jobId);
  if (!job) {
    return createProblemDetailsResponse(
      404,
      `Job with ID "${jobId}" not found.`,
      instanceUri,
      'Not Found'
    );
  }

  // Enforce tenant boundary: user can only cancel their own jobs
  if (!job.data?.userId || job.data.userId !== auth.user.id) {
    return createProblemDetailsResponse(
      403,
      'Access denied to cancel this conversion job.',
      instanceUri,
      'Forbidden'
    );
  }

  if (job.state === 'completed') {
    return createProblemDetailsResponse(
      409,
      'Job has already completed and cannot be cancelled.',
      instanceUri,
      'Conflict'
    );
  }

  const cancelled = conversionQueue.cancelJob ? await conversionQueue.cancelJob(jobId, 'Cancelled by user') : false;
  if (!cancelled) {
    return createProblemDetailsResponse(
      409,
      `Unable to cancel job in state "${job.state}".`,
      instanceUri,
      'Conflict'
    );
  }

  // Rollback reserved quota unit upon cancellation
  if (job.data?.reservationId) {
    await redisKeyStore.rollbackQuota(job.data.reservationId);
  }

  return NextResponse.json({
    success: true,
    jobId,
    status: 'failed',
    cancelled: true,
    message: 'Job was successfully cancelled and quota reservation was refunded.',
  });
}

