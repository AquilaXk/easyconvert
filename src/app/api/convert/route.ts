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
  ConversionFailedError,
  EngineUnavailableError,
  isUnprocessableInputError,
  PdfPostprocessError,
  WorkerOutputMissingError,
  WORKER_OUTPUT_MISSING_DETAIL,
} from '@/lib/types';
import { validateApiAccess, authErrorHeaders, reserveConversionUnit, withReservedUnit, type ReservedUnit } from '@/lib/api-keys/guard';
import { conversionRefusalResponse } from '@/lib/api/conversion-refusal-response';
import type { User } from '@/lib/auth/types';
import { validateTierPageLimit } from '@/lib/conversions';
import { tierMaxPages, withTierPageCap } from '@/lib/conversions/page-range';
import {
  codedRefusal,
  createProblemDetailsResponse,
  createEngineUnavailableResponse,
  createPdfPostprocessResponse,
  serverFault,
} from '@/lib/api/problem-details';
import { frameMetadataHeaders } from '@/lib/api/frame-headers';
import { conversionWarningsHeaders } from '@/lib/api/conversion-warnings';
import { droppedStreamsHeaders } from '@/lib/api/dropped-streams';
import { isConversionOptionsObject } from '@/lib/conversions/options-guard';
import { legacyOptionsProblem } from '@/lib/api/legacy-request-validation';
import { refusalCodeOf, type ConversionRefusalCode } from '@/lib/refusal-codes';

export const dynamic = 'force-dynamic';

const UNCLASSIFIED_FAILURE = 'The conversion failed on the server.';

const refusal = codedRefusal<ConversionRefusalCode>;

const HTTP_UNSUPPORTED_MEDIA_TYPE = 415;
const HTTP_UNPROCESSABLE_CONTENT = 422;

/** The archive refusals answered as a coded 422 by the code their class declares: an entry name collision, a missing volume, an encrypted header. */
const CODED_ARCHIVE_REFUSALS: ReadonlySet<ConversionRefusalCode> = new Set(['archive_entry_collision', 'missing_volume', 'encrypted_input']);

const isMultipartBody = (req: NextRequest): boolean => (req.headers.get('content-type') ?? '').toLowerCase().includes('multipart/form-data');

/** Whether a failed conversion was refused for its input (400) rather than failed on the server (500). */
function isValidationError(error: unknown, message: string): boolean {
  return (
    error instanceof ConversionFailedError ||
    message.includes('payload is empty') ||
    message.includes('Cannot convert') ||
    message.includes('Unsupported') ||
    message.includes('Failed to parse') ||
    message.includes('OCR failed') ||
    message.includes('PDF OCR') ||
    message.includes('compression') ||
    message.includes('Fail-Closed')
  );
}

/** The answer for an error a conversion threw: its problem type or status, and the code of its cause. */
function conversionErrorResponse(error: unknown, instanceUri: string): NextResponse {
  const deadlineProblem = deadlineErrorResponse(error, instanceUri);
  if (deadlineProblem) return deadlineProblem;
  if (error instanceof EngineUnavailableError) {
    return createEngineUnavailableResponse(error, instanceUri);
  }
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
  if (isUnprocessableInputError(error)) {
    // The file is intact but encrypted, password protected, DRM protected or coded with a method this engine does not
    // decode (an archive's password and method errors included), a DWG release or drawing the DWG reader refuses, or a font FontForge
    // cannot read in full: 422, not the 400 of a malformed input.
    return createProblemDetailsResponse(error.status, error.message, instanceUri, undefined, undefined, undefined, undefined, {
      code: error.refusalCode,
    });
  }
  const code = refusalCodeOf(error);
  if (error instanceof Error && (error as { status?: unknown }).status === HTTP_UNPROCESSABLE_CONTENT && code && CODED_ARCHIVE_REFUSALS.has(code)) {
    return refusal(HTTP_UNPROCESSABLE_CONTENT, code, error.message);
  }
  if (error instanceof WorkerOutputMissingError) {
    // A server fault, not a verdict on the input: answer 500 without the worker's file name.
    console.error('[convert] Worker output vanished before it was read:', error);
    return NextResponse.json({ success: false, error: WORKER_OUTPUT_MISSING_DETAIL }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : UNCLASSIFIED_FAILURE;
  if (isValidationError(error, message)) return refusal(400, code ?? 'conversion_failed', message);
  return serverFault('convert', error, UNCLASSIFIED_FAILURE);
}

export const POST = withinSingleRequest(admittingNewFiles(async function POST(req: NextRequest) {
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
  return withReservedUnit(unit.reservationId, (reserved) => convertFile(req, caller, reserved, instanceUri, startTime));
}));

/** Converts the file of an authenticated request whose unit is reserved; the unit is charged only once the conversion succeeded. */
async function convertFile(req: NextRequest, caller: User, unit: ReservedUnit, instanceUri: string, startTime: number): Promise<NextResponse> {
  // At most five conversions in flight for an anonymous or free caller (the slot is held until the request ends).
  let releaseSlot: (() => void) | undefined;
  try {
    if (!isMultipartBody(req)) {
      return refusal(HTTP_UNSUPPORTED_MEDIA_TYPE, 'multipart_required', 'The request body must be multipart/form-data.');
    }

    const slot = await acquireSyncSlot(caller.id, caller.tier);
    if (!slot.granted) {
      return concurrencyLimitResponse(slot.limit, instanceUri);
    }
    releaseSlot = slot.release;
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const targetFormat = formData.get('targetFormat') as string | null;
    const optionsRaw = formData.get('options') as string | null;

    if (!file) {
      return refusal(400, 'file_required', 'Missing required "file" in multipart request.');
    }

    if (file.size === 0) {
      return refusal(400, 'empty_file', 'Conversion payload is empty. File buffer has 0 bytes.');
    }

    if (!targetFormat) {
      return refusal(400, 'target_required', 'Missing required "targetFormat" parameter.');
    }

    const sourceFormatParam = formData.get('sourceFormat') as string | null;
    let detectedDef = sourceFormatParam ? getFormatByExtension(sourceFormatParam) : undefined;
    if (!detectedDef) {
      detectedDef = detectFormatFromFilename(file.name);
    }
    if (!detectedDef && file.name.toLowerCase().endsWith('.tar.bz2')) {
      detectedDef = FORMAT_REGISTRY['tar.bz2'] || FORMAT_REGISTRY['bz2'];
    }

    if (!detectedDef) {
      return refusal(400, 'unknown_format', `Could not determine file format from filename "${file.name}". Ensure it has a valid extension.`);
    }

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

    if (!options.pages && options.page) {
      options.pages = String(options.page);
    }
    if (options.pages) {
      try {
        validateTierPageLimit(options.pages, caller.tier);
      } catch (err: unknown) {
        return refusal(422, refusalCodeOf(err), err instanceof Error ? err.message : String(err));
      }
    }

    const arrayBuffer = await file.arrayBuffer();
    const inputBuffer = Buffer.from(arrayBuffer);

    // Validate file integrity against spoofed extensions fail-closed
    try {
      assertNotSpoofedFile(inputBuffer, detectedDef.extension, file.name);
    } catch (err: unknown) {
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
    const result = await runUnderDeadline(req, deadlineMs, (limits) =>
      dispatchConversion(
        inputBuffer,
        detectedDef.extension,
        tgt,
        bindJobLimits(withTierPageCap(options, tierMaxPages(caller.tier)), limits),
        file.name
      )
    );

    const duration = Date.now() - startTime;

    await unit.commit();

    return new NextResponse(new Uint8Array(result.buffer), {
      status: 200,
      headers: {
        'Content-Type': result.mimeType,
        'Content-Disposition': `attachment; filename="${result.filename}"`,
        'Content-Length': result.size.toString(),
        'X-Conversion-Time-Ms': duration.toString(),
        'X-Engine-Used': result.engineUsed,
        'X-Zero-Data-Retention': 'true',
        'X-Storage-Footprint': '0-bytes',
        ...frameMetadataHeaders(result),
        ...droppedStreamsHeaders(result),
        ...conversionWarningsHeaders(result),
      },
    });
  } catch (error: unknown) {
    return conversionErrorResponse(error, instanceUri);
  } finally {
    releaseSlot?.();
  }
}
