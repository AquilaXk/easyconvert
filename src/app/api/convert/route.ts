import { NextRequest, NextResponse } from 'next/server';
import { admittingNewFiles } from '@/lib/api/storage-full-response';
import { dispatchConversion } from '@/lib/conversions/dispatch';
import { conversionDeadlineMs, syncDeadlineMs } from '@/lib/queue/job-deadline';
import { acquireSyncSlot, concurrencyLimitResponse } from '@/lib/queue/concurrency-limit';
import { bindJobLimits } from '@/lib/conversions/job-time';
import { deadlineErrorResponse, runUnderDeadline } from '@/lib/api/sync-deadline';
import { payloadLimitStatus } from '@/lib/api/payload-limit';
import { withinSingleRequest } from '@/lib/api/file-size-limit';
import { detectFormatFromFilename, getFormatByExtension, FORMAT_REGISTRY, getAvailableTargetFormats } from '@/lib/registry';
import { assertNotSpoofedFile, spoofCheckStatus } from '@/lib/security/file-guard';
import {
  ConversionOptions,
  EngineMissingError,
  type FormatDefinition,
  isUnprocessableInputError,
  PdfPostprocessError,
  typedFailureOf,
  WorkerOutputMissingError,
  WORKER_OUTPUT_MISSING_DETAIL,
} from '@/lib/types';
import { validateApiAccess, authErrorHeaders, reserveConversionUnit, withReservedUnit } from '@/lib/api-keys/guard';
import type { ReservedUnit } from '@/lib/api-keys/hand-off';
import { conversionRefusalResponse } from '@/lib/api/conversion-refusal-response';
import { attachmentContentDisposition } from '@/lib/api/content-disposition';
import { loggingOutcomes, type ConversionTrace } from '@/lib/api/conversion-outcome-log';
import { fileSentAsText, formText, isMultipartBody, readMultipartForm } from '@/lib/api/multipart-body';
import type { User } from '@/lib/auth/types';
import { validatePageRangeSyntax } from '@/lib/conversions';
import {
  codedRefusal,
  createProblemDetailsResponse,
  createEngineUnavailableResponse,
  createPdfPostprocessResponse,
} from '@/lib/api/problem-details';
import { frameMetadataHeaders } from '@/lib/api/frame-headers';
import { conversionWarningsHeaders } from '@/lib/api/conversion-warnings';
import { droppedStreamsHeaders } from '@/lib/api/dropped-streams';
import { isConversionOptionsObject } from '@/lib/conversions/options-guard';
import { legacyOptionsProblem } from '@/lib/api/legacy-request-validation';
import { HTTP_SERVICE_UNAVAILABLE, refusalCodeOf, type ConversionRefusalCode } from '@/lib/refusal-codes';

export const dynamic = 'force-dynamic';

const UNCLASSIFIED_FAILURE = 'The conversion failed on the server.';

const refusal = codedRefusal<ConversionRefusalCode>;

const HTTP_UNSUPPORTED_MEDIA_TYPE = 415;
const HTTP_INTERNAL_SERVER_ERROR = 500;
/** The fields read as text that change the conversion; neither may be sent as a file, which would drop it and convert without it. */
const TEXT_FIELDS = ['sourceFormat', 'options'] as const;
const TEXT_FIELD_CODES: Record<(typeof TEXT_FIELDS)[number], ConversionRefusalCode> = { sourceFormat: 'unknown_format', options: 'invalid_options' };
const MULTIPART_REQUIRED = 'The request body must be multipart/form-data.';

/** The answer for a fault of the server (500, or the 5xx its class declares): a fixed sentence, since the error can name a path or a program's output; the outcome line carries the error. */
function serverFaultAnswer(status = HTTP_INTERNAL_SERVER_ERROR): NextResponse {
  return codedRefusal(status, undefined, UNCLASSIFIED_FAILURE);
}

/** The answer for an error a conversion threw: its problem type, or the status and code its class declares. */
function conversionErrorResponse(error: unknown, instanceUri: string): NextResponse {
  const deadlineProblem = deadlineErrorResponse(error, instanceUri);
  if (deadlineProblem) return deadlineProblem;
  if (error instanceof PdfPostprocessError) {
    return createPdfPostprocessResponse(error, instanceUri);
  }
  const limitStatus = payloadLimitStatus(error);
  if (limitStatus !== null) {
    // A stream decodes past a size limit, an image declares more pixels than allowed, or a WOFF2 passes the codec limits: 413.
    return createProblemDetailsResponse(limitStatus, error instanceof Error ? error.message : String(error), instanceUri, undefined, undefined, undefined, undefined, {
      code: refusalCodeOf(error),
    });
  }
  if (error instanceof WorkerOutputMissingError) {
    // A server fault, not a verdict on the input: answer 500 without the worker's file name; the outcome line carries the error.
    return NextResponse.json({ success: false, error: WORKER_OUTPUT_MISSING_DETAIL }, { status: error.status });
  }
  const typed = typedFailureOf(error);
  if (typed === undefined) return serverFaultAnswer();
  if (error instanceof EngineMissingError && typed.status === HTTP_SERVICE_UNAVAILABLE) return createEngineUnavailableResponse(error, instanceUri);
  if (typed.status >= HTTP_INTERNAL_SERVER_ERROR) return serverFaultAnswer(typed.status);
  const message = error instanceof Error ? error.message : String(error);
  if (isUnprocessableInputError(error)) {
    // The file is intact but encrypted, password protected, DRM protected or coded with a method this engine does not
    // decode (an archive's password and method errors included), a DWG release or drawing the DWG reader refuses, or a font FontForge
    // cannot read in full: 422, not the 400 of a malformed input.
    return createProblemDetailsResponse(typed.status, message, instanceUri, undefined, undefined, undefined, undefined, { code: typed.code });
  }
  return refusal(typed.status, typed.code, message);
}

/** The format of the uploaded file: the `sourceFormat` the request names, else the one its file name's extension names. */
function sourceFormatOf(fileName: string, sourceFormatParam: string | undefined): FormatDefinition | undefined {
  const named = sourceFormatParam ? getFormatByExtension(sourceFormatParam) : undefined;
  const detected = named ?? detectFormatFromFilename(fileName);
  if (detected || !fileName.toLowerCase().endsWith('.tar.bz2')) return detected;
  return FORMAT_REGISTRY['tar.bz2'] || FORMAT_REGISTRY['bz2'];
}

export const POST = withinSingleRequest(admittingNewFiles(loggingOutcomes('convert', async function POST(req: NextRequest, trace: ConversionTrace) {
  const startTime = Date.now();
  const instanceUri = req.nextUrl?.pathname || '/api/convert';

  // 1. Guard check: Authenticate API key/session or enforce the anonymous IP rate limit, then reserve the conversion
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

  const caller = auth.user;
  const unit = await reserveConversionUnit(caller);
  if (!unit.reserved) return conversionRefusalResponse(unit.refusal, instanceUri);
  return withReservedUnit(unit.reservationId, (reserved) => convertFile(req, caller, reserved, instanceUri, startTime, trace));
})));

/** Converts the file of an authenticated request whose unit is reserved; the unit is charged only once the conversion succeeded. */
async function convertFile(req: NextRequest, caller: User, unit: ReservedUnit, instanceUri: string, startTime: number, trace: ConversionTrace): Promise<NextResponse> {
  // At most five conversions in flight for an anonymous or free caller (the slot is held until the request ends).
  let releaseSlot: (() => void) | undefined;
  try {
    if (!isMultipartBody(req)) {
      return refusal(HTTP_UNSUPPORTED_MEDIA_TYPE, 'multipart_required', MULTIPART_REQUIRED);
    }

    const slot = await acquireSyncSlot(caller.id, caller.tier);
    if (!slot.granted) {
      return concurrencyLimitResponse(slot.limit, instanceUri);
    }
    releaseSlot = slot.release;
    const body = await readMultipartForm(req);
    if (body.malformed) {
      trace.cause = body.malformed;
      return refusal(400, 'multipart_required', MULTIPART_REQUIRED);
    }
    const formData = body.form;
    const file = formData.get('file');
    const targetFormat = formText(formData, 'targetFormat');
    const optionsRaw = formText(formData, 'options');

    trace.target = targetFormat ? getFormatByExtension(targetFormat)?.extension : undefined;
    if (!(file instanceof File)) {
      return refusal(400, 'file_required', 'Missing required "file" in multipart request.');
    }
    trace.bytes = file.size;

    if (file.size === 0) {
      return refusal(400, 'empty_file', 'Conversion payload is empty. File buffer has 0 bytes.');
    }

    const sentAsFile = fileSentAsText(formData, TEXT_FIELDS);
    if (sentAsFile) {
      return refusal(400, TEXT_FIELD_CODES[sentAsFile], `The "${sentAsFile}" field must be text, not a file.`);
    }

    if (!targetFormat) {
      return refusal(400, 'target_required', 'Missing required "targetFormat" parameter.');
    }

    const detectedDef = sourceFormatOf(file.name, formText(formData, 'sourceFormat'));
    if (!detectedDef) {
      return refusal(400, 'unknown_format', `Could not determine file format from filename "${file.name}". Ensure it has a valid extension.`);
    }
    trace.source = detectedDef.extension;

    const tgt = targetFormat.toLowerCase().replace(/^\./, '').trim();
    const availableTargets = getAvailableTargetFormats(detectedDef.extension).map((d) => d.extension);
    if (!availableTargets.includes(tgt)) {
      return refusal(
        400,
        'unsupported_pair',
        `Cannot convert from ${detectedDef.name} (.${detectedDef.extension}) to target format .${tgt}. Available targets: ${availableTargets.join(', ')}`
      );
    }

    let options: ConversionOptions = {};
    if (optionsRaw) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(optionsRaw);
      } catch {
        return refusal(400, 'invalid_options', 'Invalid JSON format for "options" parameter.');
      }
      if (!isConversionOptionsObject(parsed)) {
        return refusal(400, 'invalid_options', 'The "options" field must be a JSON object.');
      }
      options = parsed;
      const optionsProblem = legacyOptionsProblem(options, instanceUri);
      if (optionsProblem) {
        return optionsProblem;
      }
    }

    trace.keepPrivate(file.name, options);

    if (!options.pages && options.page) {
      options.pages = String(options.page);
    }
    if (options.pages) {
      try {
        validatePageRangeSyntax(options.pages);
      } catch (err: unknown) {
        trace.cause = err;
        return refusal(422, refusalCodeOf(err), err instanceof Error ? err.message : String(err));
      }
    }

    const arrayBuffer = await file.arrayBuffer();
    const inputBuffer = Buffer.from(arrayBuffer);

    // Validate file integrity against spoofed extensions fail-closed
    try {
      assertNotSpoofedFile(inputBuffer, detectedDef.extension, file.name);
    } catch (err: unknown) {
      trace.cause = err;
      return refusal(spoofCheckStatus(err), refusalCodeOf(err) ?? 'spoofed_file', (err instanceof Error && err.message) || 'File spoofing detected.');
    }

    // Perform conversion via the shared dispatcher (native engines first, in-process where valid)
    const deadlineMs = syncDeadlineMs(
      conversionDeadlineMs({
        tier: caller.tier,
        sourceFormat: detectedDef.extension,
        targetFormat: tgt,
        inputBytes: inputBuffer.length,
      })
    );
    let result: Awaited<ReturnType<typeof dispatchConversion>>;
    try {
      result = await runUnderDeadline(req, deadlineMs, (limits) =>
        dispatchConversion(
          inputBuffer,
          detectedDef.extension,
          tgt,
          bindJobLimits(options, limits),
          file.name
        )
      );
    } catch (error: unknown) {
      trace.cause = error;
      return conversionErrorResponse(error, instanceUri);
    }

    // Past the conversion every error is a fault of the server, whatever its words say. The answer is built before the unit is
    // committed, so an answer that cannot be built is not charged.
    const answer = new NextResponse(new Uint8Array(result.buffer), {
      status: 200,
      headers: {
        'Content-Type': result.mimeType,
        'Content-Disposition': attachmentContentDisposition(result.filename),
        'Content-Length': result.size.toString(),
        'X-Conversion-Time-Ms': (Date.now() - startTime).toString(),
        ...frameMetadataHeaders(result),
        ...droppedStreamsHeaders(result),
        ...conversionWarningsHeaders(result),
      },
    });
    await unit.commit();
    return answer;
  } catch (error: unknown) {
    trace.cause = error;
    return deadlineErrorResponse(error, instanceUri) ?? serverFaultAnswer();
  } finally {
    releaseSlot?.();
  }
}
