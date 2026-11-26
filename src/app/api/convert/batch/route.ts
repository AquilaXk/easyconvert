import { NextRequest, NextResponse } from 'next/server';
import { admittingNewFiles } from '@/lib/api/storage-full-response';
import { createZipArchive } from '@/lib/conversions';
import { canConvertPair } from '@/lib/conversions/dispatch';
import { dispatchSyncRouteConversion } from '@/lib/queue/wait-for-job';
import { conversionDeadlineMs, syncDeadlineMs, tierMaxDeadlineMs } from '@/lib/queue/job-deadline';
import { acquireSyncSlot, concurrencyLimitResponse } from '@/lib/queue/concurrency-limit';
import { bindJobLimits } from '@/lib/conversions/job-time';
import { deadlineErrorResponse, runUnderDeadline } from '@/lib/api/sync-deadline';
import { payloadLimitStatus } from '@/lib/api/payload-limit';
import { fileSizeLimitProblem, withinSingleRequest } from '@/lib/api/file-size-limit';
import { getFormatByExtension } from '@/lib/registry';
import { detectUploadedSourceFormat } from '@/lib/uploaded-source-format';
import { assertNotSpoofedFile, spoofCheckRefusal } from '@/lib/security/file-guard';
import { maskServerText } from '@/lib/security/server-paths';
import { refusalCodeOf, type ConversionRefusalCode } from '@/lib/refusal-codes';
import {
  ConversionOptions,
  ArchiveEntryCollisionError,
  PdfPostprocessError,
  UnsupportedTargetError,
  WorkerOutputMissingError,
  WORKER_OUTPUT_MISSING_DETAIL,
  typedFailureOf,
} from '@/lib/types';
import { validateApiAccess, authErrorHeaders, reserveConversionUnit, withReservedUnit } from '@/lib/api-keys/guard';
import { baseCredits } from '@/lib/billing/credits';
import type { ReservedUnit } from '@/lib/api-keys/hand-off';
import { conversionRefusalResponse } from '@/lib/api/conversion-refusal-response';
import type { User } from '@/lib/auth/types';
import { codedRefusal, createProblemDetailsResponse, createPdfPostprocessResponse } from '@/lib/api/problem-details';
import { DOWNLOAD_SECURITY_HEADERS } from '@/lib/api/content-disposition';
import { loggingOutcomes, type ConversionTrace } from '@/lib/api/conversion-outcome-log';
import { typedFailureProblem } from '@/lib/api/typed-failure-response';
import { isConversionOptionsObject } from '@/lib/conversions/options-guard';
import { legacyOptionsProblem } from '@/lib/api/legacy-request-validation';
import { boundedJsonFieldProblem, parseBoundedJsonField } from '@/lib/api/json-body-bounds';
import { isMultipartBody, readMultipartForm, releaseMultipartForm } from '@/lib/api/multipart-body';

export const dynamic = 'force-dynamic';

/**
 * The options every file of the batch is converted with, from the multipart `options` field, or the 400 that refuses
 * them: JSON that is not an object, or an object the options schema rejects (a server-only key among them).
 */
function parseBatchOptions(optionsRaw: string | null, instanceUri: string): { options: ConversionOptions } | { problem: NextResponse } {
  if (!optionsRaw) return { options: {} };
  const parsed = parseBoundedJsonField(optionsRaw);
  if (!parsed.ok) {
    return {
      problem:
        parsed.kind === 'invalid_json'
          ? NextResponse.json({ success: false, error: 'Invalid JSON for options.' }, { status: 400 })
          : boundedJsonFieldProblem('options', parsed.kind, instanceUri),
    };
  }
  if (!isConversionOptionsObject(parsed.value)) {
    return { problem: NextResponse.json({ success: false, error: 'The "options" field must be a JSON object.' }, { status: 400 }) };
  }
  const problem = legacyOptionsProblem(parsed.value, instanceUri);
  return problem ? { problem } : { options: parsed.value };
}

/** The target format of each file name (and of `default`) from the `targetFormats` field: a JSON object whose values are strings. */
function parseTargetFormats(raw: string | null, instanceUri: string): { map: Map<string, string> } | { problem: NextResponse } {
  if (!raw) return { map: new Map() };
  const parsed = parseBoundedJsonField(raw);
  if (!parsed.ok) {
    return {
      problem:
        parsed.kind === 'invalid_json'
          ? NextResponse.json({ success: false, error: 'Invalid JSON for targetFormats map.' }, { status: 400 })
          : boundedJsonFieldProblem('targetFormats', parsed.kind, instanceUri),
    };
  }
  const entries =
    parsed.value !== null && typeof parsed.value === 'object' && !Array.isArray(parsed.value)
      ? Object.entries(parsed.value)
      : undefined;
  if (!entries || entries.some(([, format]) => typeof format !== 'string')) {
    return { problem: NextResponse.json({ success: false, error: 'The "targetFormats" field must be a JSON object whose values are strings.' }, { status: 400 }) };
  }
  return { map: new Map(entries as Array<[string, string]>) };
}

const MAX_BATCH_FILES = 100;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const INTERNAL_ITEM_ERROR = 'Internal conversion error';

/** Masks server faults and untyped crashes on batch items while keeping masked 4xx client refusal details. */
function formatBatchItemError(error: unknown): string {
  if (payloadLimitStatus(error) !== null || spoofCheckRefusal(error)) {
    return maskServerText(error instanceof Error ? error.message : String(error));
  }
  const typed = typedFailureOf(error);
  if (typed && typed.status < HTTP_INTERNAL_SERVER_ERROR) {
    return maskServerText(error instanceof Error ? error.message : String(error));
  }
  return INTERNAL_ITEM_ERROR;
}

/** The files and fields of a batch request, or the refusal for a malformed body or an invalid file count. */
async function readBatchForm(
  req: NextRequest,
  instanceUri: string
): Promise<{ files: File[]; targetFormatsRaw: string | null; optionsRaw: string | null; onError: 'fail' | 'continue' } | { refusal: Response }> {
  const body = await readMultipartForm(req);
  if (body.malformed) {
    return { refusal: createProblemDetailsResponse(400, 'Invalid or malformed multipart/form-data body.', instanceUri, 'Bad Request') };
  }
  const files = body.form.getAll('files').filter((entry): entry is File => entry instanceof Blob);
  if (files.length === 0) {
    return { refusal: NextResponse.json({ success: false, error: 'No files provided for batch conversion.' }, { status: 400 }) };
  }
  if (files.length > MAX_BATCH_FILES) {
    return {
      refusal: codedRefusal<ConversionRefusalCode>(
        400,
        'too_many_files',
        `At most ${MAX_BATCH_FILES} files may be submitted in a single batch; the request has ${files.length}.`
      ),
    };
  }
  const onErrorRaw = body.form.get('onError');
  let onError: 'fail' | 'continue' = 'fail';
  if (onErrorRaw !== null) {
    const val = String(onErrorRaw).trim().toLowerCase();
    if (val === 'continue') {
      onError = 'continue';
    } else if (val === 'fail') {
      onError = 'fail';
    } else {
      return { refusal: NextResponse.json({ success: false, error: 'The "onError" field must be either "fail" or "continue".' }, { status: 400 }) };
    }
  }
  return {
    files,
    targetFormatsRaw: body.form.get('targetFormats') as string | null,
    optionsRaw: body.form.get('options') as string | null,
    onError,
  };
}

function normalizeTargetFormat(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/^\./, '').trim();
  if (!cleaned) return '';
  return getFormatByExtension(cleaned)?.extension ?? cleaned;
}

function validateBatchFileSizes(files: readonly File[], user: User, instanceUri: string): NextResponse | null {
  for (const file of files) {
    if (file.size === 0) {
      return NextResponse.json(
        { success: false, error: `Batch payload contains empty file "${file.name}". File buffer has 0 bytes.` },
        { status: 400 }
      );
    }
    const oversize = fileSizeLimitProblem(user, file.size, instanceUri);
    if (oversize) return oversize;
  }
  return null;
}

function planBatchFiles(
  files: readonly File[],
  targetFormatsMap: ReadonlyMap<string, string>,
  defaultOptions: ConversionOptions
): PlannedFile[] {
  const planned: PlannedFile[] = [];
  for (const file of files) {
    const detected = detectUploadedSourceFormat(file.name);
    if (!detected) continue;
    if (targetFormatsMap.has(file.name)) {
      const targetFormat = normalizeTargetFormat(targetFormatsMap.get(file.name) ?? '');
      if (!targetFormat || !canConvertPair(detected.extension, targetFormat, defaultOptions)) {
        throw new UnsupportedTargetError(
          `Unsupported conversion from .${detected.extension} to .${targetFormat || '(empty)'}: the pair is not offered`
        );
      }
      planned.push({ file, extension: detected.extension, targetFormat });
      continue;
    }
    const fallbackRaw = targetFormatsMap.get('default') ?? detected.targetFormats[0] ?? '';
    const targetFormat = normalizeTargetFormat(fallbackRaw);
    if (targetFormat && canConvertPair(detected.extension, targetFormat, defaultOptions)) {
      planned.push({ file, extension: detected.extension, targetFormat });
    }
  }
  return planned;
}

export const POST = withinSingleRequest(admittingNewFiles(loggingOutcomes('convert/batch', async function POST(req: NextRequest, trace: ConversionTrace) {
  const instanceUri = req.nextUrl?.pathname || '/api/convert/batch';
  // At most five conversions in flight for an anonymous or free caller (the slot is held until the request ends).
  let releaseSlot: (() => void) | undefined;
  let running: Promise<unknown> = Promise.resolve();

  try {
    // 1. Guard check: Authenticate API key/session or enforce the anonymous IP rate limit BEFORE reading the multipart body.
    const auth = await validateApiAccess(req, {
      requiredUnits: 0,
      requiredScope: 'convert:write',
      allowAnonymous: true,
    });

    if (!auth.authorized || !auth.user) {
      return createProblemDetailsResponse(
        auth.status ?? 401,
        auth.error ?? 'Unauthorized',
        instanceUri,
        undefined,
        auth.problemType,
        authErrorHeaders(auth)
      );
    }

    if (!isMultipartBody(req)) {
      return createProblemDetailsResponse(415, 'Content-Type must be multipart/form-data.', instanceUri, 'Unsupported Media Type');
    }

    const slot = await acquireSyncSlot(auth.user.id, auth.user.tier);
    if (!slot.granted) {
      return concurrencyLimitResponse(slot.limit, instanceUri);
    }
    let slotReleased = false;
    releaseSlot = () => {
      if (slotReleased) return;
      slotReleased = true;
      slot.release();
    };

    const form = await readBatchForm(req, instanceUri);
    if ('refusal' in form) {
      return form.refusal;
    }
    const { files, targetFormatsRaw, optionsRaw, onError } = form;
    trace.bytes = files.reduce((total, f) => total + f.size, 0);

    const sizeProblem = validateBatchFileSizes(files, auth.user, instanceUri);
    if (sizeProblem) return sizeProblem;

    const parsedTargets = parseTargetFormats(targetFormatsRaw, instanceUri);
    if ('problem' in parsedTargets) {
      return parsedTargets.problem;
    }

    const parsedOptions = parseBatchOptions(optionsRaw, instanceUri);
    if ('problem' in parsedOptions) {
      return parsedOptions.problem;
    }
    const defaultOptions = parsedOptions.options;
    trace.keepPrivate(files.map((f) => f.name), defaultOptions);

    const planned = planBatchFiles(files, parsedTargets.map, defaultOptions);
    if (planned.length === 0) {
      return NextResponse.json(
        { success: false, code: 'unsupported_pair', error: 'No convertible files matched the target format.' },
        { status: 400 }
      );
    }

    const unit = await reserveConversionUnit(auth.user, plannedCredits(planned));
    if (!unit.reserved) return conversionRefusalResponse(unit.refusal, instanceUri);
    const caller = auth.user;
    return await withReservedUnit(unit.reservationId, (reserved) =>
      convertPlanned({
        req,
        caller,
        planned,
        defaultOptions,
        unit: reserved,
        onErrorPolicy: onError,
        onRunningWork: (work) => {
          running = work.catch(() => undefined);
        },
      })
    );
  } catch (error: unknown) {
    trace.cause = error;
    return batchErrorResponse(error, instanceUri);
  } finally {
    if (releaseSlot) {
      void running.then(releaseSlot, releaseSlot);
    }
    await releaseMultipartForm(req);
  }
})));

function batchErrorResponse(error: unknown, instanceUri: string): NextResponse {
  const deadlineProblem = deadlineErrorResponse(error, instanceUri);
  if (deadlineProblem) return deadlineProblem;
  const spoofRefusal = spoofCheckRefusal(error);
  if (spoofRefusal) {
    return createProblemDetailsResponse(
      spoofRefusal.status,
      error instanceof Error ? error.message : String(error),
      instanceUri,
      spoofRefusal.title,
      undefined,
      undefined,
      undefined,
      { code: refusalCodeOf(error) ?? 'spoofed_file' }
    );
  }
  if (error instanceof PdfPostprocessError) {
    return createPdfPostprocessResponse(error, instanceUri);
  }
  if (error instanceof ArchiveEntryCollisionError) {
    return createProblemDetailsResponse(error.status, error.message, instanceUri, 'Archive Entry Collision', undefined, undefined, undefined, { code: error.refusalCode });
  }
  const limitStatus = payloadLimitStatus(error);
  if (limitStatus !== null) {
    return createProblemDetailsResponse(limitStatus, error instanceof Error ? error.message : String(error), instanceUri);
  }
  if (error instanceof WorkerOutputMissingError) {
    return createProblemDetailsResponse(error.status, WORKER_OUTPUT_MISSING_DETAIL, instanceUri, 'Internal Server Error');
  }
  return typedFailureProblem(error, instanceUri);
}

interface PlannedFile {
  file: File;
  extension: string;
  targetFormat: string;
}

type FileConversionResult =
  | { status: 'success'; filename: string; buffer: Buffer; durationMs: number }
  | { status: 'failed'; filename: string; error: string };

const BATCH_CONCURRENCY = 4;

/** The credits a batch reserves: the cost of the class of each planned file. */
function plannedCredits(planned: readonly PlannedFile[]): number {
  return planned.reduce((total, item) => total + baseCredits(item.extension, item.targetFormat), 0);
}

interface ConvertPlannedContext {
  req: NextRequest;
  caller: User;
  planned: PlannedFile[];
  defaultOptions: ConversionOptions;
  unit: ReservedUnit;
  onErrorPolicy: 'fail' | 'continue';
  onRunningWork?: (work: Promise<unknown>) => void;
}

/**
 * Converts the planned files under one deadline and answers the archive of the converted ones. The batch is charged the credits of
 * the class of each file in the archive, and the minutes each file ran beyond the first; a file of an unknown format was never
 * planned, so it reserved nothing.
 */
async function convertPlanned(ctx: ConvertPlannedContext): Promise<NextResponse> {
  const { req, caller, planned, defaultOptions, unit, onErrorPolicy, onRunningWork } = ctx;
  // One deadline for the whole batch: the files' deadlines added up, never above the maximum of the tier.
  const batchDeadlineMs = syncDeadlineMs(Math.min(
    planned.reduce(
      (total, item) =>
        total +
        conversionDeadlineMs({
          tier: caller.tier,
          sourceFormat: item.extension,
          targetFormat: item.targetFormat,
          inputBytes: item.file.size,
        }),
      0
    ),
    tierMaxDeadlineMs(caller.tier)
  ));

  const results: FileConversionResult[] = new Array(planned.length);

  // Nothing to convert needs no deadline, and the route answers it below.
  await runUnderDeadline(req, Math.max(batchDeadlineMs, 1), async (limits) => {
    let nextIndex = 0;
    let abortError: unknown = null;

    const worker = async () => {
      while (nextIndex < planned.length) {
        if (abortError !== null) return;
        limits.signal.throwIfAborted();
        const idx = nextIndex++;
        const { file, extension, targetFormat } = planned[idx];

        try {
          const arrayBuffer = await file.arrayBuffer();
          const inputBuffer = Buffer.from(arrayBuffer);

          assertNotSpoofedFile(inputBuffer, extension, file.name);

          const startedAt = Date.now();
          const result = await dispatchSyncRouteConversion({
            inputBuffer,
            sourceFormat: extension,
            targetFormat,
            options: bindJobLimits(defaultOptions, limits),
            originalFilename: file.name,
            userId: caller.id,
            tier: caller.tier,
          });
          results[idx] = {
            status: 'success',
            filename: result.filename,
            buffer: result.buffer,
            durationMs: Date.now() - startedAt,
          };
        } catch (itemErr: unknown) {
          if (onErrorPolicy === 'fail') {
            abortError = itemErr;
            throw itemErr;
          }
          results[idx] = {
            status: 'failed',
            filename: file.name,
            error: formatBatchItemError(itemErr),
          };
        }
      }
    };

    const desiredExtra = Math.max(0, Math.min(BATCH_CONCURRENCY, planned.length) - 1);
    const extraReleases: Array<() => void> = [];
    let workStarted = false;
    let extrasReleased = false;
    const releaseExtras = () => {
      if (extrasReleased) return;
      extrasReleased = true;
      while (extraReleases.length > 0) extraReleases.pop()!();
    };

    try {
      for (let i = 0; i < desiredExtra; i++) {
        limits.signal.throwIfAborted();
        const extra = await acquireSyncSlot(caller.id, caller.tier);
        if (!extra.granted) break;
        extraReleases.push(extra.release);
        limits.signal.throwIfAborted();
      }
      limits.signal.throwIfAborted();

      const workerCount = 1 + extraReleases.length;
      const work = Promise.all(Array.from({ length: workerCount }, () => worker()));
      workStarted = true;
      void work.then(releaseExtras, releaseExtras);
      onRunningWork?.(work);
      try {
        await work;
      } finally {
        releaseExtras();
      }
    } finally {
      if (!workStarted) releaseExtras();
    }
  });

  const convertedFiles: { filename: string; buffer: Buffer }[] = [];
  const failures: { filename: string; error: string }[] = [];
  const usedNames = new Set<string>();
  const processingMs: number[] = [];
  const successfulPlanned: PlannedFile[] = [];

  for (let i = 0; i < planned.length; i++) {
    const res = results[i];
    if (!res) continue;
    if (res.status === 'success') {
      let finalName = res.filename;
      let counter = 1;
      while (usedNames.has(finalName)) {
        const ext = finalName.includes('.') ? `.${finalName.split('.').pop()}` : '';
        const nameWithoutExt = finalName.replace(/\.[^/.]+$/, '');
        finalName = `${nameWithoutExt} (${counter})${ext}`;
        counter++;
      }
      usedNames.add(finalName);

      convertedFiles.push({ filename: finalName, buffer: res.buffer });
      successfulPlanned.push(planned[i]);
      processingMs.push(res.durationMs);
    } else {
      failures.push({ filename: res.filename, error: res.error });
    }
  }

  if (convertedFiles.length === 0) {
    return NextResponse.json(
      { success: false, error: 'No files were successfully converted in batch.', failures },
      { status: 400 }
    );
  }

  if (failures.length > 0) {
    convertedFiles.push({
      filename: '_failures.json',
      buffer: Buffer.from(JSON.stringify(failures, null, 2)),
    });
  }

  const zipResult = await createZipArchive(convertedFiles, defaultOptions, 'easyconvert_batch.zip');

  // Charge credits only for successfully converted files (refunding unused held units on partial failures)
  const batchCharge = { kind: 'batch' as const, base: plannedCredits(successfulPlanned), processingMs };
  if (failures.length > 0) {
    await unit.settle(batchCharge);
  } else {
    await unit.commit(batchCharge);
  }

  const headers = new Headers({
    'Content-Type': 'application/zip',
    ...DOWNLOAD_SECURITY_HEADERS,
    'Content-Disposition': 'attachment; filename="easyconvert_batch.zip"',
    'Content-Length': zipResult.size.toString(),
  });
  if (failures.length > 0) {
    headers.set('X-Batch-Failed-Count', String(failures.length));
  }

  return new NextResponse(new Uint8Array(zipResult.buffer), {
    status: 200,
    headers,
  });
}
