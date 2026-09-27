import { NextRequest, NextResponse } from 'next/server';
import { conversionQueue } from '@/lib/queue/conversion-queue';
import { subscribeToJobTelemetry } from '@/lib/queue/bullmq-engine';

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const job = await conversionQueue.getJob(params.id);
  if (!job) {
    return NextResponse.json(
      { success: false, error: `Job with ID "${params.id}" not found.` },
      { status: 404 }
    );
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

        if (job.state === 'completed' || job.state === 'failed') {
          controller.close();
          return;
        }

        const unsubscribe = subscribeToJobTelemetry(conversionQueue, params.id, (event) => {
          try {
            const dataStr = JSON.stringify(event.data);
            controller.enqueue(encoder.encode(`event: ${event.event}\ndata: ${dataStr}\n\n`));

            if (event.event === 'completed' || event.event === 'failed') {
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
  const job = await conversionQueue.getJob(params.id);
  if (!job) {
    return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 });
  }

  job.state = 'failed';
  job.failedReason = 'Job was cancelled by client request.';
  job.finishedOn = Date.now();

  return NextResponse.json({ success: true, message: 'Job cancelled successfully.' });
}
