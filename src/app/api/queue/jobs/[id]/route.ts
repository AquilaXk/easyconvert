import { NextRequest, NextResponse } from 'next/server';
import { conversionQueue } from '@/lib/queue/conversion-queue';
import {
  subscribeToJobTelemetry,
  TERMINAL_JOB_STATES,
  TERMINAL_TELEMETRY_EVENTS,
} from '@/lib/queue/bullmq-engine';
import { denyUnlessOwner } from '@/lib/api-keys/owner-access';

export const dynamic = 'force-dynamic';

// Next.js 15 passes route params as a promise.
interface JobRouteContext {
  params: Promise<{ id: string }>;
}

// Jobs created through the authenticated API carry `userId` and are visible only to that user;
// jobs without an owner (anonymous uploads) keep capability-URL access by job id.

export async function GET(
  req: NextRequest,
  { params }: JobRouteContext
) {
  const { id: jobId } = await params;
  const notFound = () =>
    NextResponse.json(
      { success: false, error: `Job with ID "${jobId}" not found.` },
      { status: 404 }
    );

  const job = await conversionQueue.getJob(jobId);
  if (!job) {
    return notFound();
  }

  const denied = await denyUnlessOwner(req, job.data?.userId, 'convert:read', notFound);
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

        const unsubscribe = subscribeToJobTelemetry(conversionQueue, jobId, (event) => {
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
    failedCode: job.failedCode,
    failedStatus: job.failedStatus,
    logs: job.logs,
  });
}

export async function DELETE(
  req: NextRequest,
  { params }: JobRouteContext
) {
  const { id: jobId } = await params;
  const notFound = () => NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 });

  const job = await conversionQueue.getJob(jobId);
  if (!job) {
    return notFound();
  }

  const denied = await denyUnlessOwner(req, job.data?.userId, 'convert:write', notFound);
  if (denied) {
    return denied;
  }

  const cancelled = await conversionQueue.cancelJob(jobId, 'Job was cancelled by client request.');
  if (!cancelled) {
    return NextResponse.json(
      { success: false, error: `Job in state "${job.state}" cannot be cancelled.` },
      { status: 409 }
    );
  }

  return NextResponse.json({ success: true, message: 'Job cancelled successfully.' });
}
