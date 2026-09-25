import { NextRequest, NextResponse } from 'next/server';
import { conversionQueue } from '@/lib/queue/conversion-queue';

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
