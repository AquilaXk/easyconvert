import fs from 'node:fs';
import { NextRequest, NextResponse } from 'next/server';
import { admittingNewFiles } from '@/lib/api/storage-full-response';
import { conversionQueue } from '@/lib/queue/conversion-queue';
import { handOffConversionJob, trustedInputBytes } from '@/lib/queue/enqueue';
import { stripEngineControls } from '@/lib/conversions/job-time';
import { concurrencyLimitResponse, mayEnqueue } from '@/lib/queue/concurrency-limit';
import { detectFormatFromFilename } from '@/lib/registry';
import { ConversionOptions } from '@/lib/types';
import { storageProvider } from '@/lib/storage';
import { readObjectHeader } from '@/lib/storage/object-header';
import { assertNotSpoofedFile, assertNotSpoofedFilePath, assertNotSpoofedObject, spoofCheckRefusal } from '@/lib/security/file-guard';
import { readMultipartForm } from '@/lib/api/multipart-body';
import { validateApiAccess, authErrorHeaders, reserveConversionUnit, withReservedUnit } from '@/lib/api-keys/guard';
import type { ReservedUnit } from '@/lib/api-keys/hand-off';
import { conversionRefusalResponse } from '@/lib/api/conversion-refusal-response';
import { mayUseStorageKeyAsJobInput, STORAGE_OBJECT_NOT_FOUND } from '@/lib/api-keys/owner-access';
import type { JobState } from '@/lib/queue/bullmq-engine';
import { storageErrorResponse } from '@/lib/api/storage-error-response';
import { queueErrorResponse, withQueueErrors } from '@/lib/api/queue-error-response';
import { redactText } from '@/lib/security/redact';
import { isConversionOptionsObject } from '@/lib/conversions/options-guard';
import { createProblemDetailsResponse, serverFault } from '@/lib/api/problem-details';
import { fileSizeLimitProblem, withinSingleRequest } from '@/lib/api/file-size-limit';
import { respondOnce } from '@/lib/api/with-idempotency';
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
  uploadedInline?: boolean;
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

  // The caller is authenticated without a unit: a repeat answered from its Idempotency-Key costs nothing, and a request
  // that runs reserves its unit when it starts.
  const auth = await validateApiAccess(req, {
    requiredUnits: 0,
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

  // An Idempotency-Key makes the request safe to send again: a repeat answers with the job the first one queued. Keys
  // are scoped to the caller, an account or the address bucket of an anonymous caller. When the answer cannot be recorded
  // the lock stays: a repeat gets 409 until it ends, since running the request again would queue a second job.
  return respondOnce(req, user.id, instanceUri, () => startJob(req, user, instanceUri), { afterFailedRecord: 'keep-lock' });
}));

/** Reserves the caller's conversion unit and queues the job; the unit is given back whenever no job was queued. */
async function startJob(req: NextRequest, user: User, instanceUri: string): Promise<Response> {
  const unit = await reserveConversionUnit(user);
  if (!unit.reserved) return conversionRefusalResponse(unit.refusal, instanceUri);
  return withReservedUnit(unit.reservationId, (reserved) => queueJob(req, user, reserved, instanceUri));
}

function failJson(status: number, error: string): Response {
  return NextResponse.json({ success: false, error }, { status });
}

/** The refusal for a spoofed input, or a rethrow of any other error. */
function spoofRefusalOrThrow(err: unknown): Response {
  const refusal = spoofCheckRefusal(err);
  if (!refusal) throw err;
  return failJson(refusal.status, err instanceof Error ? err.message : String(err));
}

/** Refuses a missing remote object or one whose bytes do not match the format; null when it passes. */
async function remoteObjectProblem(storageKey: string, sourceFormat: string, originalFilename: string): Promise<Response | null> {
  const info = await storageProvider.stat(storageKey);
  if (!info) return failJson(404, STORAGE_OBJECT_NOT_FOUND);
  const header = await readObjectHeader(storageProvider, storageKey);
  if (!header) return failJson(400, 'Stored object is unavailable.');
  await assertNotSpoofedObject(storageProvider, storageKey, info.size, header, sourceFormat, originalFilename);
  return null;
}

/** Refuses a missing local object or one whose bytes do not match the format; null when it passes. */
async function localObjectProblem(storageKey: string, sourceFormat: string, originalFilename: string): Promise<Response | null> {
  const stored = await storageProvider.getObject(storageKey);
  if (!stored) return failJson(404, STORAGE_OBJECT_NOT_FOUND);
  if (stored.filePath && fs.existsSync(stored.filePath)) {
    assertNotSpoofedFilePath(stored.filePath, sourceFormat, originalFilename);
    return null;
  }
  if (stored.buffer && stored.buffer.length > 0) {
    assertNotSpoofedFile(stored.buffer, sourceFormat, originalFilename);
    return null;
  }
  return failJson(400, 'Stored object is unavailable.');
}

/** Holds inline bytes or a stored object to the format of its own name; null when it passes. A file stored by this request was checked on its way in. */
async function inputSpoofProblem(request: JobRequest, sourceFormat: string): Promise<Response | null> {
  const { inputBufferBase64, storageKey, originalFilename } = request;
  try {
    if (inputBufferBase64) {
      assertNotSpoofedFile(Buffer.from(inputBufferBase64, 'base64'), sourceFormat, originalFilename);
      return null;
    }
    if (!storageKey || request.uploadedInline) return null;
    return storageProvider.kind === 'remote'
      ? await remoteObjectProblem(storageKey, sourceFormat, originalFilename)
      : await localObjectProblem(storageKey, sourceFormat, originalFilename);
  } catch (err) {
    return spoofRefusalOrThrow(err);
  }
}

/** What the request resolves to once its input is authorized and checked. */
type PreparedJobInput = { refusal: Response } | { sourceFormat: string; inputBytes: number | undefined };

/** Authorizes the stored key, identifies the format, enforces the plan size limit and the spoof check. */
async function prepareJobInput(user: User, request: JobRequest, instanceUri: string): Promise<PreparedJobInput> {
  const { targetFormat, storageKey, inputBufferBase64 } = request;
  if (storageKey && (typeof storageKey !== 'string' || !(await mayUseStorageKeyAsJobInput(storageKey, user.id)))) {
    return { refusal: failJson(404, STORAGE_OBJECT_NOT_FOUND) };
  }
  if (!request.originalFilename && storageKey) {
    request.originalFilename = storageKey.split('/').pop() || 'file';
  }
  if (!targetFormat) {
    return { refusal: failJson(400, 'Missing required parameter: "targetFormat"') };
  }

  const detected = detectFormatFromFilename(request.originalFilename);
  if (!detected) return { refusal: unknownSourceProblem(request.originalFilename, instanceUri) };

  const inputBytes = await trustedInputBytes({ storageKey, inputBufferBase64 }, storageProvider);
  const oversize = fileSizeLimitProblem(user, inputBytes, instanceUri);
  if (oversize) return { refusal: oversize };

  const spoofed = await inputSpoofProblem(request, detected.extension);
  if (spoofed) return { refusal: spoofed };
  return { sourceFormat: detected.extension, inputBytes };
}

/** Queues the job, which then owns the unit: the worker commits it or gives it back when the job ends. */
async function queueJob(req: NextRequest, user: User, unit: ReservedUnit, instanceUri: string): Promise<Response> {
  try {
    // At most five conversions in flight (queued plus running) for an anonymous or free caller.
    const room = await mayEnqueue(user.id, user.tier);
    if (!room.allowed) return concurrencyLimitResponse(room.limit, instanceUri);

    const parsed = await readJobRequest(req, instanceUri);
    if ('refusal' in parsed) return parsed.refusal;
    const request = parsed.request;

    const prepared = await prepareJobInput(user, request, instanceUri);
    if ('refusal' in prepared) return prepared.refusal;

    const job = await handOffConversionJob(
      unit,
      conversionQueue,
      {
        jobId: '',
        originalFilename: request.originalFilename,
        sourceFormat: prepared.sourceFormat,
        targetFormat: request.targetFormat,
        fileSize: request.fileSize,
        storageKey: request.storageKey,
        inputBufferBase64: request.inputBufferBase64,
        options: stripEngineControls(request.options),
        userId: user.id,
      },
      {
        attempts: 2,
        backoff: { type: 'fixed', delay: 1500 },
      },
      { tier: user.tier, inputBytes: prepared.inputBytes }
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
    const queueProblem = queueErrorResponse(error, instanceUri);
    if (queueProblem) return queueProblem;
    const storageProblem = storageErrorResponse(error, instanceUri);
    if (storageProblem) return storageProblem;
    return serverFault('queue/jobs', error, 'Job enqueue error');
  }
}

/** The 400 problem for a file name the registry has no format for. */
function unknownSourceProblem(filename: string, instanceUri: string): Response {
  return createProblemDetailsResponse(400, `Could not identify source format for file "${filename}".`, instanceUri);
}

function inlinePayloadProblem(instanceUri: string): Response {
  return createProblemDetailsResponse(413, INLINE_PAYLOAD_DETAIL, instanceUri);
}

/** Stores an uploaded form file as the job's input, held to the inline limit and checked against its format; null when it passes. */
async function storeFormFile(file: File, request: JobRequest, instanceUri: string): Promise<Response | null> {
  const detected = detectFormatFromFilename(file.name);
  if (!detected) return unknownSourceProblem(file.name, instanceUri);
  if (file.size > INLINE_JOB_PAYLOAD_MAX_BYTES) return inlinePayloadProblem(instanceUri);
  const buffer = Buffer.from(await file.arrayBuffer());
  try {
    assertNotSpoofedFile(buffer, detected.extension, file.name);
  } catch (err) {
    return spoofRefusalOrThrow(err);
  }
  request.originalFilename = file.name;
  request.fileSize = file.size;
  const init = await storageProvider.initiateMultipartUpload(file.name, file.type, file.size);
  await storageProvider.uploadPart(init.uploadId, 1, buffer);
  request.storageKey = (await storageProvider.completeMultipartUpload(init.uploadId)).key;
  request.uploadedInline = true;
  return null;
}

/** Reads the `options` form field into the request; a refusal when it is malformed or names a removed option. */
function applyFormOptions(optionsRaw: string, request: JobRequest, instanceUri: string): Response | null {
  const parsed = parseOptionsField(optionsRaw);
  if ('error' in parsed) return failJson(400, parsed.error);
  const optionsProblem = legacyOptionsProblem(parsed.options, instanceUri);
  if (optionsProblem) return optionsProblem;
  request.options = parsed.options;
  return null;
}

/** A job request from a multipart form: a file in it is stored first and held to the inline limit. */
async function readFormJobRequest(req: NextRequest, instanceUri: string): Promise<ParsedJobRequest> {
  const multipart = await readMultipartForm(req);
  if (multipart.malformed) {
    return { refusal: failJson(400, 'Invalid or malformed multipart/form-data body.') };
  }
  const formData = multipart.form;
  const file = formData.get('file') as File | null;
  const optionsRaw = formData.get('options') as string | null;
  const request: JobRequest = {
    originalFilename: '',
    targetFormat: (formData.get('targetFormat') as string) || '',
    options: {},
    storageKey: (formData.get('storageKey') as string) || undefined,
    fileSize: 0,
  };

  const optionsRefusal = optionsRaw ? applyFormOptions(optionsRaw, request, instanceUri) : null;
  if (optionsRefusal) return { refusal: optionsRefusal };
  const fileRefusal = file ? await storeFormFile(file, request, instanceUri) : null;
  if (fileRefusal) return { refusal: fileRefusal };
  return { request };
}

/** The parsed JSON object of a request, or null when the body is not valid JSON or not an object. */
async function readJsonObject(req: NextRequest) {
  try {
    const parsed = await req.json();
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** A job request from a JSON body: inline bytes are held to the inline limit. */
async function readJsonJobRequest(req: NextRequest, instanceUri: string): Promise<ParsedJobRequest> {
  const body = await readJsonObject(req);
  if (!body) {
    return { refusal: NextResponse.json({ success: false, error: 'Invalid JSON body provided in request.' }, { status: 400 }) };
  }
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
      originalFilename: body.filename || body.originalFilename || '',
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
