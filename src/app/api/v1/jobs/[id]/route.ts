import { NextRequest, NextResponse } from 'next/server';
import { validateApiAccess, authErrorHeaders } from '@/lib/api-keys/guard';
import { conversionQueue } from '@/lib/queue/conversion-queue';
import { graphScheduler, type GraphExecutionState, type NodeExecutionStatus } from '@/lib/queue/graph';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import { redactForOutput, redactText } from '@/lib/security/redact';

export const dynamic = 'force-dynamic';

const PERCENT = 100;
const TERMINAL_NODE_STATUSES: ReadonlySet<NodeExecutionStatus> = new Set<NodeExecutionStatus>([
  'completed',
  'failed',
  'cancelled',
  'skipped',
]);

/** Stored text is masked again on the way out: rows written by older versions may still quote a secret. */
function maskedText(text: string | undefined): string | undefined {
  return text === undefined ? undefined : redactText(text);
}

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
  const graphState = await graphScheduler.getGraphState(jobId);
  if (!job && !graphState) {
    return createProblemDetailsResponse(
      404,
      `Job with ID "${jobId}" not found.`,
      instanceUri,
      'Not Found'
    );
  }

  // Enforce tenant boundary: user can only inspect their own jobs
  const ownerId = job ? job.data?.userId : graphState?.ownerUserId;
  if (!ownerId || ownerId !== auth.user.id) {
    return createProblemDetailsResponse(
      403,
      'Access denied to this conversion job.',
      instanceUri,
      'Forbidden'
    );
  }

  const nodesResponse = graphState
    ? Object.fromEntries(
        Object.entries(graphState.nodes).map(([nid, ns]) => [
          nid,
          { status: ns.status, outputs: ns.outputs || [], error: maskedText(ns.error) },
        ])
      )
    : undefined;

  if (!job) {
    // A graph job has no queue job of its own; the 404 check above guarantees its state.
    const state = graphState as GraphExecutionState;
    return NextResponse.json({
      success: true,
      jobId,
      status: state.status,
      progress: graphProgress(state),
      sourceFormat: state.sourceFormat,
      targetFormat: state.targetFormat,
      originalFilename: state.originalFilename,
      createdAt: state.createdAt,
      finishedOn: state.finishedAt,
      failedReason: maskedText(state.failedReason),
      tasks: redactForOutput(state.tasks),
      graph: redactForOutput(state.graph),
      nodes: nodesResponse,
    });
  }

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
    failedReason: maskedText(graphState?.failedReason || job.failedReason),
    result: job.returnvalue,
    tasks: redactForOutput(job.data?.tasks),
    graph: redactForOutput(graphState?.graph || job.data?.graph),
    nodes: nodesResponse,
    logs: job.logs?.map(redactText),
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
    return cancelGraphJob(jobId, auth.user.id, instanceUri);
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


/** Percentage of graph nodes that reached a terminal state. */
function graphProgress(state: GraphExecutionState): number {
  if (state.totalNodes === 0) {
    return 0;
  }
  const finished = Object.values(state.nodes).filter((n) => TERMINAL_NODE_STATUSES.has(n.status)).length;
  return Math.round((finished / state.totalNodes) * PERCENT);
}

/** Cancels a graph job, which has no queue job of its own. */
async function cancelGraphJob(jobId: string, userId: string, instanceUri: string) {
  const state = await graphScheduler.getGraphState(jobId);
  if (!state) {
    return createProblemDetailsResponse(404, `Job with ID "${jobId}" not found.`, instanceUri, 'Not Found');
  }
  if (state.ownerUserId !== userId) {
    return createProblemDetailsResponse(403, 'Access denied to cancel this conversion job.', instanceUri, 'Forbidden');
  }
  // cancelGraph cancels every node job and refunds the graph's quota reservation.
  if (state.status !== 'running' || !(await graphScheduler.cancelGraph(jobId, 'Cancelled by user'))) {
    return createProblemDetailsResponse(
      409,
      `Unable to cancel job in state "${state.status}".`,
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
