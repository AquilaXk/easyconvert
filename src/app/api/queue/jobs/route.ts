import { NextRequest, NextResponse } from 'next/server';
import { conversionQueue } from '@/lib/queue/conversion-queue';
import { detectFormatFromFilename } from '@/lib/registry';
import { ConversionOptions } from '@/lib/types';
import { storageProvider } from '@/lib/storage';
import { validateApiAccess, authErrorHeaders, commitQuota, rollbackQuota } from '@/lib/api-keys/guard';
import { mayUseStorageKeyAsJobInput, STORAGE_OBJECT_NOT_FOUND } from '@/lib/api-keys/owner-access';
import type { JobState } from '@/lib/queue/bullmq-engine';
import { storageErrorResponse } from '@/lib/api/storage-error-response';
import { queueErrorResponse, withQueueErrors } from '@/lib/api/queue-error-response';
import { redactText } from '@/lib/security/redact';
import { isConversionOptionsObject } from '@/lib/conversions/options-guard';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import { legacyOptionsProblem } from '@/lib/api/legacy-request-validation';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  // 1. Guard check: Authenticate API key/session or enforce anonymous IP rate limit & daily quota
  const auth = await validateApiAccess(req, {
    requiredUnits: 1,
    requiredScope: 'convert:write',
    allowAnonymous: true,
  });

  if (!auth.authorized || !auth.user) {
    return NextResponse.json(
      { success: false, error: auth.error ?? 'Unauthorized' },
      { status: auth.status ?? 401, headers: authErrorHeaders(auth) }
    );
  }

  const reservationId = auth.reservationId;

  const failWithRollback = async (status: number, error: string) => {
    if (reservationId) {
      await rollbackQuota(reservationId);
    }
    return NextResponse.json({ success: false, error }, { status });
  };

  const instanceUri = req.nextUrl?.pathname || '/api/queue/jobs';

  /** A 400 problem, after releasing the quota reservation, for a file name the registry has no format for. */
  const failUnknownSource = async (filename: string) => {
    if (reservationId) {
      await rollbackQuota(reservationId);
    }
    return createProblemDetailsResponse(400, `Could not identify source format for file "${filename}".`, instanceUri);
  };

  /** The 400 problem for options that break ConversionOptionsSchema, after releasing the quota reservation. */
  const rejectInvalidOptions = async (candidate: ConversionOptions) => {
    const problem = legacyOptionsProblem(candidate, instanceUri);
    if (problem && reservationId) {
      await rollbackQuota(reservationId);
    }
    return problem;
  };

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
        let parsed: unknown;
        try {
          parsed = JSON.parse(optionsRaw);
        } catch {
          return await failWithRollback(400, 'Invalid JSON format for "options" parameter.');
        }
        if (!isConversionOptionsObject(parsed)) {
          return await failWithRollback(400, 'The "options" field must be a JSON object.');
        }
        options = parsed;
        const optionsProblem = await rejectInvalidOptions(options);
        if (optionsProblem) return optionsProblem;
      }

      if (file) {
        if (!detectFormatFromFilename(file.name)) return await failUnknownSource(file.name);
        originalFilename = file.name;
        fileSize = file.size;
        const arrayBuffer = await file.arrayBuffer();
        // Save to S3 chunk storage directly
        const init = await storageProvider.initiateMultipartUpload(file.name, file.type, file.size);
        await storageProvider.uploadPart(init.uploadId, 1, Buffer.from(arrayBuffer));
        const completed = await storageProvider.completeMultipartUpload(init.uploadId);
        storageKey = completed.key;
      }
    } else {
      // JSON body
      const body = await req.json();
      originalFilename = body.filename || '';
      targetFormat = body.targetFormat || '';
      if (body.options !== undefined && !isConversionOptionsObject(body.options)) {
        return await failWithRollback(400, 'The "options" field must be a JSON object.');
      }
      options = body.options ?? {};
      const optionsProblem = await rejectInvalidOptions(options);
      if (optionsProblem) return optionsProblem;
      storageKey = body.storageKey;
      inputBufferBase64 = body.inputBufferBase64;
      fileSize = body.fileSize || 0;
    }

    // Authorize caller against storage key
    if (
      storageKey &&
      (typeof storageKey !== 'string' || !(await mayUseStorageKeyAsJobInput(storageKey, auth.user.id)))
    ) {
      return await failWithRollback(404, STORAGE_OBJECT_NOT_FOUND);
    }

    if (!originalFilename && storageKey) {
      originalFilename = storageKey.split('/').pop() || 'file';
    }

    if (!targetFormat) {
      return await failWithRollback(400, 'Missing required parameter: "targetFormat"');
    }

    const detected = detectFormatFromFilename(originalFilename);
    if (!detected) return await failUnknownSource(originalFilename);
    const sourceFormat = detected.extension;

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
        userId: auth.user.id,
        reservationId,
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
    if (reservationId) {
      await rollbackQuota(reservationId);
    }
    const queueProblem = queueErrorResponse(error, req.nextUrl?.pathname || '/api/queue/jobs');
    if (queueProblem) return queueProblem;
    const storageProblem = storageErrorResponse(error, req.nextUrl?.pathname || '/api/queue/jobs');
    if (storageProblem) return storageProblem;
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
  return withQueueErrors(req.nextUrl?.pathname || '/api/queue/jobs', () => listOwnJobs(req));
}

async function listOwnJobs(req: NextRequest) {
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

  const ownJobs = await conversionQueue.getJobsByUser(callerId, states, MAX_LISTED_JOBS, 0);
  const jobSummaries = ownJobs.map((j) => ({
    id: j.id,
    name: j.name,
    state: j.state,
    progress: j.progress,
    originalFilename: j.data.originalFilename,
    targetFormat: j.data.targetFormat,
    timestamp: j.timestamp,
    durationMs: j.finishedOn && j.processedOn ? j.finishedOn - j.processedOn : undefined,
    returnvalue: j.returnvalue,
    failedReason: j.failedReason === undefined ? undefined : redactText(j.failedReason),
    failedCode: j.failedCode,
    failedStatus: j.failedStatus,
  }));

  return NextResponse.json({
    success: true,
    total: jobSummaries.length,
    jobs: jobSummaries,
  });
}
