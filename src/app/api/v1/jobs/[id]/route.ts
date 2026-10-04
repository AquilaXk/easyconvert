import { NextRequest, NextResponse } from 'next/server';
import { validateApiAccess, authErrorHeaders } from '@/lib/api-keys/guard';
import { conversionQueue } from '@/lib/queue/conversion-queue';
import { graphScheduler } from '@/lib/queue/graph';
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
      auth.problemType,
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

  const graphState = await graphScheduler.getGraphState(jobId);
  const nodesResponse = graphState
    ? Object.fromEntries(
        Object.entries(graphState.nodes).map(([nid, ns]) => [
          nid,
          { status: ns.status, outputs: ns.outputs || [], error: ns.error },
        ])
      )
    : undefined;

  return NextResponse.json({
    success: true,
    jobId: job.id,
    status: graphState ? graphState.status : job.state,
    progress: job.progress,
    sourceFormat: job.data?.sourceFormat,
    targetFormat: job.data?.targetFormat,
    originalFilename: job.data?.originalFilename,
    fileSize: job.data?.fileSize,
    createdAt: job.timestamp,
    processedOn: job.processedOn,
    finishedOn: job.finishedOn,
    attemptsMade: job.attemptsMade,
    failedReason: graphState?.failedReason || job.failedReason,
    result: job.returnvalue,
    tasks: job.data?.tasks,
    graph: graphState?.graph || job.data?.graph,
    nodes: nodesResponse,
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
      auth.problemType,
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

  // Also cancel graph if this was a graph execution
  await graphScheduler.cancelGraph(jobId, 'Cancelled by user').catch(() => {});

  // The queue's cancellation listener refunds the reserved quota unit exactly once.
  const cancelled = await conversionQueue.cancelJob(jobId, 'Cancelled by user');
  if (!cancelled) {
    return createProblemDetailsResponse(
      409,
      `Unable to cancel job in state "${job.state}".`,
      instanceUri,
      'Conflict'
    );
  }

  return NextResponse.json({
    success: true,
    jobId,
    status: 'cancelled',
    cancelled: true,
    message: 'Job was successfully cancelled and quota reservation was refunded.',
  });
}

