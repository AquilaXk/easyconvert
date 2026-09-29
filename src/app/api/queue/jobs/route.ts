import { NextRequest, NextResponse } from 'next/server';
import { conversionQueue } from '@/lib/queue/conversion-queue';
import { detectFormatFromFilename } from '@/lib/registry';
import { ConversionOptions } from '@/lib/types';
import { s3Storage } from '@/lib/storage/s3-storage';
import { validateApiAccess, authErrorHeaders } from '@/lib/api-keys/guard';
import type { JobState } from '@/lib/queue/bullmq-engine';

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

const LISTABLE_JOB_STATES: ReadonlySet<JobState> = new Set<JobState>(['waiting', 'active', 'completed', 'failed', 'delayed', 'cancelled']);
const DEFAULT_LISTED_STATES: JobState[] = ['waiting', 'active', 'completed', 'failed', 'cancelled'];
const MAX_LISTED_JOBS = 50;

function isListableJobState(value: string): value is JobState {
  return LISTABLE_JOB_STATES.has(value as JobState);
}

/**
 * Lists the caller's own jobs. Requires a session or an API key with `convert:read`;
 * anonymous jobs are reachable only through their capability URL and are never listed.
 */
export async function GET(req: NextRequest) {
  const auth = await validateApiAccess(req, { requiredUnits: 0, requiredScope: 'convert:read' });
  if (!auth.authorized || !auth.user) {
    return NextResponse.json(
      { success: false, error: auth.error ?? 'Unauthorized: Sign in or valid API key required.' },
      { status: auth.status ?? 401, headers: authErrorHeaders(auth) }
    );
  }
  const callerId = auth.user.id;

  const statusFilter = new URL(req.url).searchParams.get('status');
  let states = DEFAULT_LISTED_STATES;
  if (statusFilter !== null) {
    if (!isListableJobState(statusFilter)) {
      return NextResponse.json(
        { success: false, error: `Unsupported status filter '${statusFilter}'.` },
        { status: 400 }
      );
    }
    states = [statusFilter];
  }

  const ownJobs = (await conversionQueue.getJobs(states)).filter((j) => j.data?.userId === callerId);
  const jobSummaries = ownJobs.slice(0, MAX_LISTED_JOBS).map((j) => ({
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
    total: jobSummaries.length,
    jobs: jobSummaries,
  });
}
