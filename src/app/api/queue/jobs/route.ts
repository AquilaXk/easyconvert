import fs from 'node:fs';
import { NextRequest, NextResponse } from 'next/server';
import { admittingNewFiles } from '@/lib/api/storage-full-response';
import { getQueueForResourceClass } from '@/lib/queue/conversion-queue';
import { handOffConversionJob, trustedInputBytes } from '@/lib/queue/enqueue';
import { resolveResourceClass, tierToPriority } from '@/lib/queue/resource-class';
import { stripEngineControls } from '@/lib/conversions/job-time';
import { concurrencyLimitResponse, mayEnqueue } from '@/lib/queue/concurrency-limit';
import { detectUploadedSourceFormat, getAvailableTargetFormats, getFormatByExtension } from '@/lib/registry';
import { ALTO_SNIFF_BYTES, promoteAltoXmlSource } from '@/lib/conversions/ocr-alto-sniff';
import { ConversionOptions, type FormatDefinition } from '@/lib/types';
import { storageProvider } from '@/lib/storage';
import { deleteResult } from '@/lib/storage/retention-service';
import { storeUploadedBuffer } from '@/lib/api/completed-upload';
import { readObjectHeader } from '@/lib/storage/object-header';
import { assertNotSpoofedFile, assertNotSpoofedFilePath, assertNotSpoofedObject, spoofCheckRefusal } from '@/lib/security/file-guard';
import { fileSentAsText, formText, isMultipartBody, readMultipartForm, releaseMultipartForm } from '@/lib/api/multipart-body';
import { payloadLimitStatus } from '@/lib/api/payload-limit';
import { deadlineErrorResponse } from '@/lib/api/sync-deadline';
import { refusalCodeOf } from '@/lib/refusal-codes';
import { validateApiAccess, authErrorHeaders, holdBaseCredits, reserveConversionUnit, withReservedUnit } from '@/lib/api-keys/guard';
import { baseCredits } from '@/lib/billing/credits';
import type { ReservedUnit } from '@/lib/api-keys/hand-off';
import { conversionRefusalResponse } from '@/lib/api/conversion-refusal-response';
import { mayUseStorageKeyAsJobInput, STORAGE_OBJECT_NOT_FOUND } from '@/lib/api-keys/owner-access';
import type { JobState } from '@/lib/queue/bullmq-engine';
import { storageErrorResponse } from '@/lib/api/storage-error-response';
import { queueErrorResponse, withQueueErrors } from '@/lib/api/queue-error-response';
import { withoutEngineTrace } from '@/lib/api/engine-trace';
import { redactText } from '@/lib/security/redact';
import { validatePageRangeSyntax } from '@/lib/conversions';
import { isConversionOptionsObject } from '@/lib/conversions/options-guard';
import { createProblemDetailsResponse, serverFault } from '@/lib/api/problem-details';
import { fileSizeLimitProblem, withinSingleRequest } from '@/lib/api/file-size-limit';
import { graphJobState, graphProcessedOn, listVisibleWork } from '@/lib/queue/user-jobs';
import { graphProgress } from '@/lib/queue/graph/graph-progress';
import { respondOnce } from '@/lib/api/with-idempotency';
import type { User } from '@/lib/auth/types';
import { INLINE_JOB_PAYLOAD_MAX_BYTES, INLINE_JSON_BODY_MAX_BYTES } from '@/lib/plan-limits';
import { boundedJsonFieldProblem, parseBoundedJsonField, readBoundedJsonText } from '@/lib/api/json-body-bounds';
import { formatBytes } from '@/lib/format-bytes';
import { legacyOptionsProblem } from '@/lib/api/legacy-request-validation';

export const dynamic = 'force-dynamic';

const MAX_NAME_OR_KEY_CHARS = 1024;
const MAX_SOURCE_FORMAT_CHARS = 64;
const MULTIPART_TEXT_FIELDS = ['targetFormat', 'storageKey', 'sourceFormat', 'options'] as const;

/** Checks options schema, prototype keys, and page-range syntax before quota reservation. */
function validateJobOptions(rawOptions: unknown, instanceUri: string): { options: ConversionOptions } | { refusal: Response } {
  if (!isConversionOptionsObject(rawOptions)) {
    return { refusal: failJson(400, 'The "options" field must be a JSON object.') };
  }
  const optionsProblem = legacyOptionsProblem(rawOptions, instanceUri);
  if (optionsProblem) return { refusal: optionsProblem };

  const options: ConversionOptions = rawOptions;
  if (!options.pages && options.page !== undefined) {
    options.pages = String(options.page);
  }
  if (options.pages) {
    try {
      validatePageRangeSyntax(options.pages);
    } catch (err: unknown) {
      return { refusal: failJson(400, err instanceof Error ? err.message : String(err), refusalCodeOf(err)) };
    }
  }
  return { options };
}

/** The options object of a multipart `options` field, or the refusal for a malformed or unbounded field. */
function parseOptionsField(raw: string, instanceUri: string): { options: ConversionOptions } | { refusal: Response } {
  const parsed = parseBoundedJsonField(raw);
  if (!parsed.ok) {
    return {
      refusal:
        parsed.kind === 'invalid_json'
          ? failJson(400, 'Invalid JSON format for "options" parameter.')
          : boundedJsonFieldProblem('options', parsed.kind, instanceUri),
    };
  }
  return validateJobOptions(parsed.value, instanceUri);
}

/** What a job request names: the input (a stored key, inline base64, or a lazy multipart File), the target, and options. */
interface JobRequest {
  originalFilename: string;
  targetFormat: string;
  sourceFormat?: string;
  options: ConversionOptions;
  storageKey?: string;
  inputBufferBase64?: string;
  inlineFile?: File;
  fileSize: number;
}

type ParsedJobRequest = { request: JobRequest } | { refusal: Response };

/** The bytes a base64 text decodes to, holding it to the inline payload limit without decoding. */
function decodedBase64Bytes(text: string): number {
  let padding = 0;
  if (text.endsWith('==')) padding = 2;
  else if (text.endsWith('=')) padding = 1;
  return Math.floor((text.length * 3) / 4) - padding;
}

const INLINE_PAYLOAD_DETAIL =
  `A file sent inside a job request may be at most ${formatBytes(INLINE_JOB_PAYLOAD_MAX_BYTES)}, as it is copied into the job. ` +
  'Upload a larger file through /api/storage/multipart and start the job on its stored key.';

export const POST = withinSingleRequest(admittingNewFiles(async function POST(req: NextRequest) {
  const instanceUri = req.nextUrl?.pathname || '/api/queue/jobs';

  // The caller is authenticated without a unit: a repeat answered from its Idempotency-Key costs nothing, and a request
  // that runs reserves its unit after admission validation passes.
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
  try {
    return await respondOnce(req, user.id, instanceUri, () => startJob(req, user, instanceUri), { afterFailedRecord: 'keep-lock' });
  } finally {
    await releaseMultipartForm(req);
  }
}));

function queueJobErrorResponse(error: unknown, instanceUri: string): Response {
  const deadlineProblem = deadlineErrorResponse(error, instanceUri);
  if (deadlineProblem) return deadlineProblem;
  const limitStatus = payloadLimitStatus(error);
  if (limitStatus !== null) {
    return createProblemDetailsResponse(limitStatus, error instanceof Error ? error.message : String(error), instanceUri, undefined, undefined, undefined, undefined, {
      code: refusalCodeOf(error),
    });
  }
  const queueProblem = queueErrorResponse(error, instanceUri);
  if (queueProblem) return queueProblem;
  const storageProblem = storageErrorResponse(error, instanceUri);
  if (storageProblem) return storageProblem;
  return serverFault('queue/jobs', error, 'Job enqueue error');
}

/** Validates concurrency, inputs, formats, size limits, and spoofing before reserving quota or persisting uploads. */
async function startJob(req: NextRequest, user: User, instanceUri: string): Promise<Response> {
  let spilledKey: string | undefined;
  try {
    // At most five conversions in flight (queued plus running) for an anonymous or free caller.
    const room = await mayEnqueue(user.id, user.tier);
    if (!room.allowed) return concurrencyLimitResponse(room.limit, instanceUri);

    const parsed = await readJobRequest(req, instanceUri);
    if ('refusal' in parsed) return parsed.refusal;
    const request = parsed.request;

    const prepared = await prepareJobInput(user, request, instanceUri);
    if ('refusal' in prepared) return prepared.refusal;

    const unit = await reserveConversionUnit(user);
    if (!unit.reserved) return conversionRefusalResponse(unit.refusal, instanceUri);

    return await withReservedUnit(unit.reservationId, (reserved) =>
      enqueuePreparedJob(user, reserved, request, prepared, instanceUri, (key) => {
        spilledKey = key;
      })
    );
  } catch (error: unknown) {
    if (spilledKey) await deleteResult(storageProvider, spilledKey).catch(() => undefined);
    return queueJobErrorResponse(error, instanceUri);
  }
}

function failJson(status: number, error: string, code?: string): Response {
  return NextResponse.json({ success: false, ...(code ? { code } : {}), error }, { status });
}

/** The refusal for a spoofed input, or a rethrow of any other error. */
function spoofRefusalOrThrow(err: unknown): Response {
  const refusal = spoofCheckRefusal(err);
  if (!refusal) throw err;
  return failJson(refusal.status, err instanceof Error ? err.message : String(err), refusal.code);
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
  try {
    if (stored.filePath && fs.existsSync(stored.filePath)) {
      assertNotSpoofedFilePath(stored.filePath, sourceFormat, originalFilename);
      return null;
    }
    if (stored.buffer && stored.buffer.length > 0) {
      assertNotSpoofedFile(stored.buffer, sourceFormat, originalFilename);
      return null;
    }
    return failJson(400, 'Stored object is unavailable.');
  } finally {
    await stored.release?.().catch(() => undefined);
  }
}

/** Holds inline bytes or a stored object to the format of its own name; null when it passes. */
async function inputSpoofProblem(request: JobRequest, sourceFormat: string, inlineBuffer: Buffer | undefined): Promise<Response | null> {
  const { storageKey, originalFilename } = request;
  try {
    // Check storageKey first whenever present, matching enqueue, so inline decoy bytes cannot hide a spoofed stored key.
    if (storageKey) {
      return storageProvider.kind === 'remote'
        ? await remoteObjectProblem(storageKey, sourceFormat, originalFilename)
        : await localObjectProblem(storageKey, sourceFormat, originalFilename);
    }
    if (inlineBuffer) {
      assertNotSpoofedFile(inlineBuffer, sourceFormat, originalFilename);
    }
    return null;
  } catch (err) {
    return spoofRefusalOrThrow(err);
  }
}

/** What the request resolves to once its input is authorized and checked. */
type PreparedJobInput =
  | { refusal: Response }
  | { sourceFormat: string; inputBytes: number | undefined; inlineUploadBuffer?: Buffer };

async function readQueueJobXmlPrefix(request: JobRequest): Promise<Uint8Array | undefined> {
  if (request.storageKey) {
    return readObjectHeader(storageProvider, request.storageKey)
      .then((header) => header?.subarray(0, ALTO_SNIFF_BYTES))
      .catch(() => undefined);
  }
  if (request.inlineFile) {
    return new Uint8Array(await request.inlineFile.slice(0, ALTO_SNIFF_BYTES).arrayBuffer());
  }
  if (request.inputBufferBase64) return Buffer.from(request.inputBufferBase64.slice(0, 5600), 'base64');
  return undefined;
}

function resolveSupportedTarget(detected: FormatDefinition, targetFormat: string): { targetFormat: string } | { refusal: Response } {
  const tgt = targetFormat.toLowerCase().replace(/^\./, '').trim();
  const targetDef = getFormatByExtension(tgt);
  const availableDefs = getAvailableTargetFormats(detected.id);
  if (!targetDef || !availableDefs.some((d) => d.id === targetDef.id || d.extension === tgt)) {
    return {
      refusal: failJson(400, `Cannot convert from ${detected.name} (.${detected.extension}) to target format .${tgt}.`, 'unsupported_pair'),
    };
  }
  return { targetFormat: tgt };
}

async function resolveInlineBuffer(request: JobRequest, instanceUri: string): Promise<{ buffer?: Buffer } | { refusal: Response }> {
  if (request.inputBufferBase64) {
    const decoded = Buffer.from(request.inputBufferBase64, 'base64');
    if (decoded.length === 0) {
      return { refusal: failJson(400, 'Invalid "inputBufferBase64" parameter: decoded payload is empty.') };
    }
    if (decoded.length > INLINE_JOB_PAYLOAD_MAX_BYTES) {
      return { refusal: inlinePayloadProblem(instanceUri) };
    }
    return { buffer: decoded };
  }
  if (!request.storageKey && request.inlineFile) {
    const buffer = Buffer.from(await request.inlineFile.arrayBuffer());
    if (buffer.length === 0) {
      return { refusal: failJson(400, 'Conversion payload is empty. File buffer has 0 bytes.') };
    }
    if (buffer.length > INLINE_JOB_PAYLOAD_MAX_BYTES) {
      return { refusal: inlinePayloadProblem(instanceUri) };
    }
    return { buffer };
  }
  return { buffer: undefined };
}

/** Authorizes the stored key, validates the format pair, enforces the plan size limit, and runs the spoof check. */
async function prepareJobInput(user: User, request: JobRequest, instanceUri: string): Promise<PreparedJobInput> {
  const { storageKey, inputBufferBase64 } = request;
  if (storageKey && !(await mayUseStorageKeyAsJobInput(storageKey, user.id))) {
    return { refusal: failJson(404, STORAGE_OBJECT_NOT_FOUND) };
  }
  if (!request.originalFilename && storageKey) {
    request.originalFilename = storageKey.split('/').pop() || 'file';
  }

  let detected = detectUploadedSourceFormat(request.originalFilename, request.sourceFormat);
  if (!detected) return { refusal: unknownSourceProblem(request.originalFilename, instanceUri) };
  if (!request.sourceFormat && detected.id === 'xml') {
    const prefix = await readQueueJobXmlPrefix(request);
    detected = promoteAltoXmlSource(detected, undefined, request.targetFormat, prefix) ?? detected;
  }

  const targetCheck = resolveSupportedTarget(detected, request.targetFormat);
  if ('refusal' in targetCheck) return targetCheck;
  request.targetFormat = targetCheck.targetFormat;

  const inputBytes =
    !storageKey && request.inlineFile
      ? request.inlineFile.size
      : await trustedInputBytes({ storageKey, inputBufferBase64 }, storageProvider);
  const oversize = fileSizeLimitProblem(user, inputBytes, instanceUri);
  if (oversize) return { refusal: oversize };

  const inline = await resolveInlineBuffer(request, instanceUri);
  if ('refusal' in inline) return inline;

  const spoofed = await inputSpoofProblem(request, detected.id, inline.buffer);
  if (spoofed) return { refusal: spoofed };
  const resolvedBytes = !storageKey && inline.buffer ? inline.buffer.length : inputBytes;
  return { sourceFormat: detected.id, inputBytes: resolvedBytes, inlineUploadBuffer: inline.buffer };
}

type EnqueuedPreparedJob = Exclude<PreparedJobInput, { refusal: Response }>;

/** Holds pair credits, persists inline payloads if needed, and hands the job off to the target queue. */
async function enqueuePreparedJob(
  user: User,
  unit: ReservedUnit,
  request: JobRequest,
  prepared: EnqueuedPreparedJob,
  instanceUri: string,
  onSpilledKey: (key: string) => void
): Promise<Response> {
  // The unit was reserved for one credit; the rest of the cost of this pair is held now.
  const short = await holdBaseCredits(unit, user, baseCredits(prepared.sourceFormat, request.targetFormat));
  if (short) return conversionRefusalResponse(short, instanceUri);

  let storageKey = request.storageKey;
  if (!storageKey && prepared.inlineUploadBuffer) {
    const mimeType =
      request.inlineFile?.type ||
      detectUploadedSourceFormat(request.originalFilename, request.sourceFormat)?.mimeType ||
      'application/octet-stream';
    storageKey = await storeUploadedBuffer(
      storageProvider,
      prepared.inlineUploadBuffer,
      { name: request.originalFilename || 'input', type: mimeType, size: prepared.inlineUploadBuffer.length },
      user.id
    );
    onSpilledKey(storageKey);
  }

  const routedBytes = prepared.inputBytes ?? request.fileSize;
  const cleanOptions = stripEngineControls(request.options);
  const resClass = resolveResourceClass(prepared.sourceFormat, request.targetFormat, routedBytes, cleanOptions);
  const targetQueue = getQueueForResourceClass(resClass);

  const job = await handOffConversionJob(
    unit,
    targetQueue,
    {
      jobId: '',
      originalFilename: request.originalFilename,
      sourceFormat: prepared.sourceFormat,
      targetFormat: request.targetFormat,
      fileSize: routedBytes,
      storageKey,
      options: cleanOptions,
      userId: user.id,
      resourceClass: resClass,
    },
    {
      attempts: 2,
      backoff: { type: 'fixed', delay: 1500 },
      priority: tierToPriority(user.tier),
    },
    { tier: user.tier, inputBytes: prepared.inputBytes }
  );

  return NextResponse.json({
    success: true,
    jobId: job.id,
    status: job.state,
    progress: job.progress,
    createdAt: job.timestamp,
    queue: targetQueue.name,
  });
}

/** The 400 problem for a file name the registry has no format for. */
function unknownSourceProblem(filename: string, instanceUri: string): Response {
  return createProblemDetailsResponse(400, `Could not identify source format for file "${filename}".`, instanceUri);
}

function inlinePayloadProblem(instanceUri: string): Response {
  return createProblemDetailsResponse(413, INLINE_PAYLOAD_DETAIL, instanceUri);
}

function validateInlineFormFile(file: File, explicitSource: string | undefined, instanceUri: string): Response | null {
  if (file.size === 0) {
    return failJson(400, 'Conversion payload is empty. File buffer has 0 bytes.');
  }
  if (!detectUploadedSourceFormat(file.name, explicitSource)) {
    return unknownSourceProblem(file.name, instanceUri);
  }
  if (file.size > INLINE_JOB_PAYLOAD_MAX_BYTES) {
    return inlinePayloadProblem(instanceUri);
  }
  return null;
}

/** A job request from a multipart form: keeps the file lazy without buffering or writing to storage yet. */
async function readFormJobRequest(req: NextRequest, instanceUri: string): Promise<ParsedJobRequest> {
  const multipart = await readMultipartForm(req);
  if (multipart.malformed) {
    return { refusal: failJson(400, 'Invalid or malformed multipart/form-data body.') };
  }
  const formData = multipart.form;
  const sentAsFile = fileSentAsText(formData, MULTIPART_TEXT_FIELDS);
  if (sentAsFile) {
    return { refusal: failJson(400, `The "${sentAsFile}" field must be text, not a file.`) };
  }
  const rawFile = formData.get('file');
  if (rawFile !== null && !(rawFile instanceof File)) {
    return { refusal: failJson(400, 'Invalid "file" field: expected an uploaded file.') };
  }

  let options: ConversionOptions = {};
  const optionsRaw = formText(formData, 'options');
  if (optionsRaw) {
    const parsedOptions = parseOptionsField(optionsRaw, instanceUri);
    if ('refusal' in parsedOptions) return parsedOptions;
    options = parsedOptions.options;
  }

  const sourceFormatRaw = formText(formData, 'sourceFormat');
  if (sourceFormatRaw !== undefined && sourceFormatRaw.length > MAX_SOURCE_FORMAT_CHARS) {
    return { refusal: failJson(400, 'Invalid "sourceFormat" parameter: must be a string.') };
  }
  const sourceFormat = sourceFormatRaw?.trim() || undefined;

  const file = rawFile ?? undefined;
  if (file) {
    const fileProblem = validateInlineFormFile(file, sourceFormat, instanceUri);
    if (fileProblem) return { refusal: fileProblem };
  }

  const targetFormat = formText(formData, 'targetFormat')?.trim() || '';
  if (!targetFormat) {
    return { refusal: failJson(400, 'Missing required parameter: "targetFormat"') };
  }

  const storageKeyRaw = formText(formData, 'storageKey');
  if (storageKeyRaw !== undefined && storageKeyRaw.length > MAX_NAME_OR_KEY_CHARS) {
    return { refusal: failJson(400, 'Invalid "storageKey" parameter: must be a non-empty string.') };
  }
  const storageKey = storageKeyRaw?.trim() || undefined;

  if (!file && !storageKey) {
    return { refusal: failJson(400, 'Missing required input: provide "file" or "storageKey".') };
  }

  return {
    request: {
      originalFilename: file ? file.name : '',
      targetFormat,
      sourceFormat,
      options,
      storageKey,
      inlineFile: file,
      fileSize: file ? file.size : 0,
    },
  };
}

/** The parsed plain JSON object of a request (null when invalid JSON or non-object/array), or the 413 of a body that is too large. */
async function readJsonObject(req: NextRequest, instanceUri: string): Promise<{ body: Record<string, unknown> | null } | { refusal: Response }> {
  const read = await readBoundedJsonText(req, INLINE_JSON_BODY_MAX_BYTES, instanceUri, INLINE_JOB_PAYLOAD_MAX_BYTES);
  if ('refusal' in read) return read;
  try {
    const parsed: unknown = JSON.parse(read.text);
    const body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    return { body };
  } catch {
    return { body: null };
  }
}

function isOptionalStringWithin(value: unknown, maxLength: number): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length <= maxLength);
}

function validateJsonTextFields(body: Record<string, unknown>): Response | null {
  if (!isOptionalStringWithin(body.filename, MAX_NAME_OR_KEY_CHARS) || !isOptionalStringWithin(body.originalFilename, MAX_NAME_OR_KEY_CHARS)) {
    return failJson(400, 'Invalid "filename" parameter: must be a string.');
  }
  if (typeof body.targetFormat !== 'string' || body.targetFormat.trim().length === 0) {
    return failJson(400, 'Missing required parameter: "targetFormat"');
  }
  if (!isOptionalStringWithin(body.sourceFormat, MAX_SOURCE_FORMAT_CHARS)) {
    return failJson(400, 'Invalid "sourceFormat" parameter: must be a string.');
  }
  return null;
}

function validateJsonInputFields(body: Record<string, unknown>, instanceUri: string): Response | null {
  if (
    body.storageKey !== undefined &&
    (typeof body.storageKey !== 'string' || body.storageKey.trim().length === 0 || body.storageKey.length > MAX_NAME_OR_KEY_CHARS)
  ) {
    return failJson(400, 'Invalid "storageKey" parameter: must be a non-empty string.');
  }
  if (body.inputBufferBase64 !== undefined && (typeof body.inputBufferBase64 !== 'string' || body.inputBufferBase64.length === 0)) {
    return failJson(400, 'Invalid "inputBufferBase64" parameter: must be a non-empty base64 string.');
  }
  if (typeof body.inputBufferBase64 === 'string' && decodedBase64Bytes(body.inputBufferBase64) > INLINE_JOB_PAYLOAD_MAX_BYTES) {
    return inlinePayloadProblem(instanceUri);
  }
  if (body.fileSize !== undefined && (typeof body.fileSize !== 'number' || !Number.isFinite(body.fileSize) || body.fileSize < 0)) {
    return failJson(400, 'Invalid "fileSize" parameter: must be a non-negative number.');
  }
  return null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function parseJsonJobFields(body: Record<string, unknown>, instanceUri: string): ParsedJobRequest {
  let options: ConversionOptions = {};
  if (body.options !== undefined) {
    const checked = validateJobOptions(body.options, instanceUri);
    if ('refusal' in checked) return checked;
    options = checked.options;
  }

  const textRefusal = validateJsonTextFields(body);
  if (textRefusal) return { refusal: textRefusal };

  const inputRefusal = validateJsonInputFields(body, instanceUri);
  if (inputRefusal) return { refusal: inputRefusal };

  const storageKey = nonEmptyString(body.storageKey);
  const inputBufferBase64 = typeof body.inputBufferBase64 === 'string' ? body.inputBufferBase64 : undefined;
  if (!storageKey && !inputBufferBase64) {
    return { refusal: failJson(400, 'Missing required input: provide "storageKey" or "inputBufferBase64".') };
  }

  const originalFilename = nonEmptyString(body.filename) ?? nonEmptyString(body.originalFilename) ?? '';
  return {
    request: {
      originalFilename,
      targetFormat: (body.targetFormat as string).trim(),
      sourceFormat: nonEmptyString(body.sourceFormat),
      options,
      storageKey,
      inputBufferBase64,
      fileSize: typeof body.fileSize === 'number' ? body.fileSize : 0,
    },
  };
}

/** A job request from a JSON body: field types, options, and inline limits are checked before reserving quota. */
async function readJsonJobRequest(req: NextRequest, instanceUri: string): Promise<ParsedJobRequest> {
  const read = await readJsonObject(req, instanceUri);
  if ('refusal' in read) return read;
  if (!read.body) {
    return { refusal: failJson(400, 'Invalid JSON body provided in request.') };
  }
  return parseJsonJobFields(read.body, instanceUri);
}

function readJobRequest(req: NextRequest, instanceUri: string): Promise<ParsedJobRequest> {
  return isMultipartBody(req) ? readFormJobRequest(req, instanceUri) : readJsonJobRequest(req, instanceUri);
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

  const ownWork = await listVisibleWork(callerId, states, MAX_LISTED_JOBS);
  const jobSummaries = ownWork.map((work) => {
    if (work.kind === 'graph') {
      const g = work.graph;
      const processedOn = graphProcessedOn(g);
      return {
        id: g.graphId,
        name: 'graph',
        state: graphJobState(g.status),
        progress: graphProgress(g),
        originalFilename: g.originalFilename,
        targetFormat: g.targetFormat,
        timestamp: g.createdAt,
        durationMs: g.finishedAt && processedOn ? g.finishedAt - processedOn : undefined,
        returnvalue: undefined,
        failedReason: g.failedReason === undefined ? undefined : redactText(g.failedReason),
        failedCode: undefined,
        failedStatus: undefined,
      };
    }
    const j = work.job;
    return {
      id: j.id,
      name: j.name,
      state: j.state,
      progress: j.progress,
      originalFilename: j.data.originalFilename,
      targetFormat: j.data.targetFormat,
      timestamp: j.timestamp,
      durationMs: j.finishedOn && j.processedOn ? j.finishedOn - j.processedOn : undefined,
      returnvalue: withoutEngineTrace(j.returnvalue),
      failedReason: j.failedReason === undefined ? undefined : redactText(j.failedReason),
      failedCode: j.failedCode,
      failedStatus: j.failedStatus,
    };
  });

  return NextResponse.json({
    success: true,
    total: jobSummaries.length,
    jobs: jobSummaries,
  });
}
