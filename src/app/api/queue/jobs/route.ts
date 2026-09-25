import { NextRequest, NextResponse } from 'next/server';
import { conversionQueue } from '@/lib/queue/conversion-queue';
import { detectFormatFromFilename } from '@/lib/registry';
import { ConversionOptions } from '@/lib/types';
import { s3Storage } from '@/lib/storage/s3-storage';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get('content-type') || '';

    let originalFilename = '';
    let targetFormat = '';
    let options: ConversionOptions = {};
    let storageKey: string | undefined;
    let inputBufferBase64: string | undefined;
    let fileSize = 0;

    if (contentType.includes('multipart/form-data')) {
      const formData = await req.formData();
      const file = formData.get('file') as File | null;
      targetFormat = (formData.get('targetFormat') as string) || '';
      const optionsRaw = formData.get('options') as string | null;
      storageKey = (formData.get('storageKey') as string) || undefined;

      if (optionsRaw) {
        try {
          options = JSON.parse(optionsRaw);
        } catch {
          // ignore
        }
      }

      if (file) {
        originalFilename = file.name;
        fileSize = file.size;
        const arrayBuffer = await file.arrayBuffer();
        // Save to S3 chunk storage directly
        const init = s3Storage.initiateMultipartUpload(file.name, file.type, file.size);
        s3Storage.uploadPart(init.uploadId, 1, Buffer.from(arrayBuffer));
        const completed = s3Storage.completeMultipartUpload(init.uploadId);
        storageKey = completed.key;
      }
    } else {
      // JSON body
      const body = await req.json();
      originalFilename = body.filename || '';
      targetFormat = body.targetFormat || '';
      options = body.options || {};
      storageKey = body.storageKey;
      inputBufferBase64 = body.inputBufferBase64;
      fileSize = body.fileSize || 0;
    }

    if (!originalFilename && storageKey) {
      originalFilename = storageKey.split('/').pop() || 'file';
    }

    if (!targetFormat) {
      return NextResponse.json(
        { success: false, error: 'Missing required parameter: "targetFormat"' },
        { status: 400 }
      );
    }

    const detected = detectFormatFromFilename(originalFilename);
    const sourceFormat = detected ? detected.extension : originalFilename.split('.').pop() || 'bin';

    // Add conversion task to BullMQ Distributed Queue
    const job = await conversionQueue.add(
      'convert',
      {
        jobId: '',
        originalFilename,
        sourceFormat,
        targetFormat,
        fileSize,
        storageKey,
        inputBufferBase64,
        options,
      },
      {
        attempts: 2,
        backoff: { type: 'fixed', delay: 1500 },
      }
    );

    return NextResponse.json({
      success: true,
      jobId: job.id,
      status: job.state,
      progress: job.progress,
      createdAt: job.timestamp,
      queue: conversionQueue.name,
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Job enqueue error' },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const statusFilter = searchParams.get('status');

  const counts = await conversionQueue.getJobCounts();

  let jobs = [];
  if (statusFilter) {
    jobs = await conversionQueue.getJobs([statusFilter as any]);
  } else {
    jobs = await conversionQueue.getJobs(['waiting', 'active', 'completed', 'failed']);
  }

  const jobSummaries = jobs.slice(0, 50).map((j) => ({
    id: j.id,
    name: j.name,
    state: j.state,
    progress: j.progress,
    originalFilename: j.data.originalFilename,
    targetFormat: j.data.targetFormat,
    timestamp: j.timestamp,
    durationMs: j.finishedOn && j.processedOn ? j.finishedOn - j.processedOn : undefined,
    returnvalue: j.returnvalue,
    failedReason: j.failedReason,
  }));

  return NextResponse.json({
    success: true,
    counts,
    total: jobSummaries.length,
    jobs: jobSummaries,
  });
}
