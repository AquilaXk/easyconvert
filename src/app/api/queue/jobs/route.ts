import { NextRequest, NextResponse } from 'next/server';
import { admittingNewFiles } from '@/lib/api/storage-full-response';
import { conversionQueue } from '@/lib/queue/conversion-queue';
import { enqueueConversionJob, trustedInputBytes } from '@/lib/queue/enqueue';
import { stripEngineControls } from '@/lib/conversions/job-time';
import { JobDeadlineError } from '@/lib/queue/job-deadline';
import { concurrencyLimitResponse, mayEnqueue } from '@/lib/queue/concurrency-limit';
import { detectFormatFromFilename } from '@/lib/registry';
import { ConversionOptions } from '@/lib/types';
import { storageProvider } from '@/lib/storage';
import { validateApiAccess, authErrorHeaders, rollbackQuota } from '@/lib/api-keys/guard';
import { mayUseStorageKeyAsJobInput, STORAGE_OBJECT_NOT_FOUND } from '@/lib/api-keys/owner-access';
import type { JobState } from '@/lib/queue/bullmq-engine';
import { storageErrorResponse } from '@/lib/api/storage-error-response';
import { queueErrorResponse, withQueueErrors } from '@/lib/api/queue-error-response';
import { redactText } from '@/lib/security/redact';
import { isConversionOptionsObject } from '@/lib/conversions/options-guard';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import { refuseOversizeFile, withinSingleRequest } from '@/lib/api/file-size-limit';
import { respondOnce } from '@/lib/api/with-idempotency';
import { uploadOwnerOf } from '@/lib/auth/anonymous-identity';
import type { User } from '@/lib/auth/types';
import { INLINE_JOB_PAYLOAD_MAX_BYTES } from '@/lib/plan-limits';
import { formatBytes } from '@/lib/format-bytes';
import { legacyOptionsProblem } from '@/lib/api/legacy-request-validation';

export const dynamic = 'force-dynamic';

/** The options object of a multipart `options` field, or the message that names what is wrong with it. */
function parseOptionsField(raw: string): { options: ConversionOptions } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: 'Invalid JSON format for "options" parameter.' };
  }
  return isConversionOptionsObject(parsed) ? { options: parsed } : { error: 'The "options" field must be a JSON object.' };
}

/** What a job request names: the input (a stored key, inline bytes or none yet), the target and the options. */
interface JobRequest {
  originalFilename: string;
  targetFormat: string;
  options: ConversionOptions;
  storageKey?: string;
  inputBufferBase64?: string;
  fileSize: number;
}

type ParsedJobRequest = { request: JobRequest } | { refusal: Response };

/** The bytes a base64 text decodes to, near enough to hold it to a limit (padding and line breaks ignored). */
function decodedBase64Bytes(text: string): number {
  return Math.floor((text.length * 3) / 4);
}

const INLINE_PAYLOAD_DETAIL =
  `A file sent inside a job request may be at most ${formatBytes(INLINE_JOB_PAYLOAD_MAX_BYTES)}, as it is copied into the job. ` +
  'Upload a larger file through /api/storage/multipart and start the job on its stored key.';

export const POST = withinSingleRequest(admittingNewFiles(async function POST(req: NextRequest) {
  const instanceUri = req.nextUrl?.pathname || '/api/queue/jobs';

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
  const user = auth.user;
  const reservationId = auth.reservationId;

  // An Idempotency-Key makes the request safe to send again: a repeat answers with the job the first one queued, and
  // the unit the repeat reserved is given back, since no second job runs.
  let queuedHere = false;
  const res = await respondOnce(req, uploadOwnerOf(user.id), instanceUri, () => {
    queuedHere = true;
    return queueJob(req, user, reservationId, instanceUri);
  });
  if (!queuedHere && reservationId) await rollbackQuota(reservationId);
  return res;
}));

async function queueJob(req: NextRequest, user: User, reservationId: string | undefined, instanceUri: string): Promise<Response> {
  const failWithRollback = async (status: number, error: string) => {
    if (reservationId) {
      await rollbackQuota(reservationId);
    }
    return NextResponse.json({ success: false, error }, { status });
  };

  /** A problem answer, after releasing the quota reservation. */
  const refuse = async (problem: Response) => {
    if (reservationId) await rollbackQuota(reservationId);
    return problem;
  };

  try {
    // At most five conversions in flight (queued plus running) for an anonymous or free caller.
    const room = await mayEnqueue(user.id, user.tier);
    if (!room.allowed) return await refuse(concurrencyLimitResponse(room.limit, instanceUri));

    const parsed = await readJobRequest(req, instanceUri);
    if ('refusal' in parsed) return await refuse(parsed.refusal);
    const { targetFormat, options, storageKey, inputBufferBase64, fileSize } = parsed.request;
    let { originalFilename } = parsed.request;

    // Authorize caller against storage key
    if (
      storageKey &&
      (typeof storageKey !== 'string' || !(await mayUseStorageKeyAsJobInput(storageKey, user.id)))
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
    if (!detected) return await refuse(unknownSourceProblem(originalFilename, instanceUri));
    const sourceFormat = detected.extension;

    const inputBytes = await trustedInputBytes({ storageKey, inputBufferBase64 }, storageProvider);
    const oversize = await refuseOversizeFile(user, inputBytes, instanceUri, reservationId);
    if (oversize) return oversize;

    // Add conversion task to BullMQ Distributed Queue
    const job = await enqueueConversionJob(
      conversionQueue,
      'convert',
      {
        jobId: '',
        originalFilename,
        sourceFormat,
        targetFormat,
        fileSize,
        storageKey,
        inputBufferBase64,
        options: stripEngineControls(options),
        userId: user.id,
        reservationId,
      },
      {
        attempts: 2,
        backoff: { type: 'fixed', delay: 1500 },
      },
      { tier: user.tier, inputBytes }
    );

    return NextResponse.json({
      success: true,
      jobId: job.id,
      status: job.state,
      progress: job.progress,
      createdAt: job.timestamp,
      queue: conversionQueue.name,
    });
  } catch (error: unknown) {
    if (reservationId) {
      await rollbackQuota(reservationId);
    }
    const queueProblem = queueErrorResponse(error, instanceUri);
    if (queueProblem) return queueProblem;
    const storageProblem = storageErrorResponse(error, instanceUri);
    if (storageProblem) return storageProblem;
    if (error instanceof JobDeadlineError) {
      // The detail names a deadline setting, so it stays in the server log.
      console.error('[queue/jobs] Invalid deadline setting or input:', error);
      return NextResponse.json({ success: false, error: 'Job enqueue error' }, { status: 500 });
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Job enqueue error' },
      { status: 500 }
    );
  }
}

/** The 400 problem for a file name the registry has no format for. */
function unknownSourceProblem(filename: string, instanceUri: string): Response {
  return createProblemDetailsResponse(400, `Could not identify source format for file "${filename}".`, instanceUri);
}

function inlinePayloadProblem(instanceUri: string): Response {
  return createProblemDetailsResponse(413, INLINE_PAYLOAD_DETAIL, instanceUri);
}

/** A job request from a multipart form: a file in it is stored first and held to the inline limit. */
async function readFormJobRequest(req: NextRequest, instanceUri: string): Promise<ParsedJobRequest> {
  const formData = await req.formData();
  const file = formData.get('file') as File | null;
  const optionsRaw = formData.get('options') as string | null;
  const request: JobRequest = {
    originalFilename: '',
    targetFormat: (formData.get('targetFormat') as string) || '',
    options: {},
    storageKey: (formData.get('storageKey') as string) || undefined,
    fileSize: 0,
  };

  if (optionsRaw) {
    const parsed = parseOptionsField(optionsRaw);
    if ('error' in parsed) return { refusal: NextResponse.json({ success: false, error: parsed.error }, { status: 400 }) };
    const optionsProblem = legacyOptionsProblem(parsed.options, instanceUri);
    if (optionsProblem) return { refusal: optionsProblem };
    request.options = parsed.options;
  }

  if (file) {
    if (!detectFormatFromFilename(file.name)) return { refusal: unknownSourceProblem(file.name, instanceUri) };
    if (file.size > INLINE_JOB_PAYLOAD_MAX_BYTES) return { refusal: inlinePayloadProblem(instanceUri) };
    request.originalFilename = file.name;
    request.fileSize = file.size;
    const init = await storageProvider.initiateMultipartUpload(file.name, file.type, file.size);
    await storageProvider.uploadPart(init.uploadId, 1, Buffer.from(await file.arrayBuffer()));
    request.storageKey = (await storageProvider.completeMultipartUpload(init.uploadId)).key;
  }
  return { request };
}

/** A job request from a JSON body: inline bytes are held to the inline limit. */
async function readJsonJobRequest(req: NextRequest, instanceUri: string): Promise<ParsedJobRequest> {
  const body = await req.json();
  if (body.options !== undefined && !isConversionOptionsObject(body.options)) {
    return { refusal: NextResponse.json({ success: false, error: 'The "options" field must be a JSON object.' }, { status: 400 }) };
  }
  const options: ConversionOptions = body.options ?? {};
  const optionsProblem = legacyOptionsProblem(options, instanceUri);
  if (optionsProblem) return { refusal: optionsProblem };
  const inputBufferBase64: unknown = body.inputBufferBase64;
  if (typeof inputBufferBase64 === 'string' && decodedBase64Bytes(inputBufferBase64) > INLINE_JOB_PAYLOAD_MAX_BYTES) {
    return { refusal: inlinePayloadProblem(instanceUri) };
  }
  return {
    request: {
      originalFilename: body.filename || '',
      targetFormat: body.targetFormat || '',
      options,
      storageKey: body.storageKey,
      inputBufferBase64: body.inputBufferBase64,
      fileSize: body.fileSize || 0,
    },
  };
}

function readJobRequest(req: NextRequest, instanceUri: string): Promise<ParsedJobRequest> {
  const contentType = req.headers.get('content-type') || '';
  return contentType.includes('multipart/form-data') ? readFormJobRequest(req, instanceUri) : readJsonJobRequest(req, instanceUri);
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
