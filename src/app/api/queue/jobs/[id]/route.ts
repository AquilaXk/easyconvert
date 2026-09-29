import { NextRequest, NextResponse } from 'next/server';
import { conversionQueue } from '@/lib/queue/conversion-queue';
import {
  subscribeToJobTelemetry,
  TERMINAL_JOB_STATES,
  TERMINAL_TELEMETRY_EVENTS,
} from '@/lib/queue/bullmq-engine';
import { validateApiAccess, authErrorHeaders } from '@/lib/api-keys/guard';

export const dynamic = 'force-dynamic';

/**
 * Jobs created through the authenticated API carry `userId` and are visible only to that user;
 * any other caller gets the route's regular not-found response so job ids cannot be probed.
 * Jobs without an owner (anonymous uploads) keep capability-URL access by job id.
 * Returns the response to send when access is denied, or null when the caller may proceed.
 */
async function denyUnlessJobOwner(
  req: NextRequest,
  ownerUserId: string | undefined,
  requiredScope: string,
  notFound: () => NextResponse
): Promise<NextResponse | null> {
  if (!ownerUserId) {
    return null;
  }

  const auth = await validateApiAccess(req, { requiredUnits: 0, requiredScope });
  if (auth.user?.id !== ownerUserId) {
    return notFound();
  }
  if (!auth.authorized) {
    return NextResponse.json(
      { success: false, error: auth.error ?? 'Unauthorized' },
      { status: auth.status ?? 401, headers: authErrorHeaders(auth) }
    );
  }
  return null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const notFound = () =>
    NextResponse.json(
      { success: false, error: `Job with ID "${params.id}" not found.` },
      { status: 404 }
    );

  const job = await conversionQueue.getJob(params.id);
  if (!job) {
    return notFound();
  }

  const denied = await denyUnlessJobOwner(req, job.data?.userId, 'convert:read', notFound);
  if (denied) {
    return denied;
  }

  const streamParam = req.nextUrl.searchParams.get('stream') === 'true';
  const acceptsStream = req.headers.get('accept')?.includes('text/event-stream');

  if (streamParam || acceptsStream) {
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      start(controller) {
        // Send initial state snapshot
        const initialPayload = JSON.stringify({
          jobId: job.id,
          state: job.state,
          progress: job.progress,
          result: job.returnvalue,
          error: job.failedReason,
        });
        controller.enqueue(encoder.encode(`event: initial\ndata: ${initialPayload}\n\n`));

        if (TERMINAL_JOB_STATES.has(job.state)) {
          controller.close();
          return;
        }

        const unsubscribe = subscribeToJobTelemetry(conversionQueue, params.id, (event) => {
          try {
            const dataStr = JSON.stringify(event.data);
            controller.enqueue(encoder.encode(`event: ${event.event}\ndata: ${dataStr}\n\n`));

            if (TERMINAL_TELEMETRY_EVENTS.has(event.event)) {
              unsubscribe();
              controller.close();
            }
          } catch {
            unsubscribe();
          }
        });

        req.signal.addEventListener('abort', () => {
          unsubscribe();
          try {
            controller.close();
          } catch {
            // Already closed
          }
        });
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
      },
    });
  }

  return NextResponse.json({
    success: true,
    id: job.id,
    state: job.state,
    progress: job.progress,
    timestamp: job.timestamp,
    processedOn: job.processedOn,
    finishedOn: job.finishedOn,
    attemptsMade: job.attemptsMade,
    data: {
      originalFilename: job.data.originalFilename,
      sourceFormat: job.data.sourceFormat,
      targetFormat: job.data.targetFormat,
    },
    returnvalue: job.returnvalue,
    failedReason: job.failedReason,
    logs: job.logs,
  });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const notFound = () => NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 });

  const job = await conversionQueue.getJob(params.id);
  if (!job) {
    return notFound();
  }

  const denied = await denyUnlessJobOwner(req, job.data?.userId, 'convert:write', notFound);
  if (denied) {
    return denied;
  }

  const cancelled = await conversionQueue.cancelJob(params.id, 'Job was cancelled by client request.');
  if (!cancelled) {
    return NextResponse.json(
      { success: false, error: `Job in state "${job.state}" cannot be cancelled.` },
      { status: 409 }
    );
  }

  return NextResponse.json({ success: true, message: 'Job cancelled successfully.' });
}
