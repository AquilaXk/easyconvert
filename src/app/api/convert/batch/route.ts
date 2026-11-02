import { NextRequest, NextResponse } from 'next/server';
import { admittingNewFiles } from '@/lib/api/storage-full-response';
import { createZipArchive } from '@/lib/conversions';
import { dispatchConversion } from '@/lib/conversions/dispatch';
import { conversionDeadlineMs, syncDeadlineMs, tierMaxDeadlineMs } from '@/lib/queue/job-deadline';
import { acquireSyncSlot, concurrencyLimitResponse } from '@/lib/queue/concurrency-limit';
import { bindJobLimits } from '@/lib/conversions/job-time';
import { deadlineErrorResponse, runUnderDeadline } from '@/lib/api/sync-deadline';
import { payloadLimitStatus } from '@/lib/api/payload-limit';
import { withinSingleRequest } from '@/lib/api/file-size-limit';
import { detectFormatFromFilename } from '@/lib/registry';
import { tierMaxPages, withTierPageCap } from '@/lib/conversions/page-range';
import {
  ConversionOptions,
  ConversionFailedError,
  EngineUnavailableError,
  ArchiveEntryCollisionError,
  isUnprocessableInputError,
  PdfPostprocessError,
  WorkerOutputMissingError,
  WORKER_OUTPUT_MISSING_DETAIL,
} from '@/lib/types';
import { validateApiAccess, authErrorHeaders, reserveConversionUnit, withReservedUnit, type ReservedUnit } from '@/lib/api-keys/guard';
import type { User } from '@/lib/auth/types';
import {
  createProblemDetailsResponse,
  createEngineUnavailableResponse,
  createPdfPostprocessResponse,
} from '@/lib/api/problem-details';
import { isConversionOptionsObject } from '@/lib/conversions/options-guard';
import { legacyOptionsProblem } from '@/lib/api/legacy-request-validation';

export const dynamic = 'force-dynamic';

/**
 * The options every file of the batch is converted with, from the multipart `options` field, or the 400 that refuses
 * them: JSON that is not an object, or an object the options schema rejects (a server-only key among them).
 */
function parseBatchOptions(optionsRaw: string | null, instanceUri: string): { options: ConversionOptions } | { problem: NextResponse } {
  if (!optionsRaw) return { options: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(optionsRaw);
  } catch {
    return { problem: NextResponse.json({ success: false, error: 'Invalid JSON for options.' }, { status: 400 }) };
  }
  if (!isConversionOptionsObject(parsed)) {
    return { problem: NextResponse.json({ success: false, error: 'The "options" field must be a JSON object.' }, { status: 400 }) };
  }
  const problem = legacyOptionsProblem(parsed, instanceUri);
  return problem ? { problem } : { options: parsed };
}

export const POST = withinSingleRequest(admittingNewFiles(async function POST(req: NextRequest) {
  const instanceUri = req.nextUrl?.pathname || '/api/convert/batch';
  // At most five conversions in flight for an anonymous or free caller (the slot is held until the request ends).
  let releaseSlot: (() => void) | undefined;

  try {
    const formData = await req.formData();
    const files = formData.getAll('files') as File[];
    const targetFormatsRaw = formData.get('targetFormats') as string | null;
    const optionsRaw = formData.get('options') as string | null;

    if (!files || files.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No files provided for batch conversion.' },
        { status: 400 }
      );
    }

    // 1. Guard check: Authenticate API key/session or enforce the anonymous IP rate limit. The units are reserved once
    // the files to convert are known, one for each.
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

    const slot = await acquireSyncSlot(auth.user.id, auth.user.tier);
    if (!slot.granted) {
      return concurrencyLimitResponse(slot.limit, instanceUri);
    }
    releaseSlot = slot.release;

    for (const f of files) {
      if (f.size === 0) {
        return NextResponse.json(
          { success: false, error: `Batch payload contains empty file "${f.name}". File buffer has 0 bytes.` },
          { status: 400 }
        );
      }
    }

    let targetFormatsMap: Record<string, string> = {};
    if (targetFormatsRaw) {
      try {
        targetFormatsMap = JSON.parse(targetFormatsRaw);
      } catch {
        return NextResponse.json(
          { success: false, error: 'Invalid JSON for targetFormats map.' },
          { status: 400 }
        );
      }
    }

    const parsedOptions = parseBatchOptions(optionsRaw, instanceUri);
    if ('problem' in parsedOptions) {
      return parsedOptions.problem;
    }
    const defaultOptions = parsedOptions.options;

    const planned: PlannedFile[] = [];
    for (const file of files) {
      const detected = detectFormatFromFilename(file.name);
      if (!detected) continue;
      const targetFormat = targetFormatsMap[file.name] || targetFormatsMap['default'] || detected.targetFormats[0];
      if (!targetFormat) continue;
      planned.push({ file, extension: detected.extension, targetFormat });
    }

    const unit = await reserveConversionUnit(auth.user, planned.length);
    if (!unit.reserved) {
      return createProblemDetailsResponse(unit.status, unit.error, instanceUri, undefined, unit.problemType);
    }
    const caller = auth.user;
    return await withReservedUnit(unit.reservationId, (reserved) => convertPlanned(req, caller, planned, defaultOptions, reserved));
  } catch (error: unknown) {
    const deadlineProblem = deadlineErrorResponse(error, instanceUri);
    if (deadlineProblem) return deadlineProblem;
    if (error instanceof EngineUnavailableError) {
      return createEngineUnavailableResponse(error, instanceUri);
    }
    if (error instanceof PdfPostprocessError) {
      return createPdfPostprocessResponse(error, instanceUri);
    }
    if (error instanceof ArchiveEntryCollisionError) {
      return createProblemDetailsResponse(error.status, error.message, instanceUri, 'Archive Entry Collision');
    }
    const limitStatus = payloadLimitStatus(error);
    if (limitStatus !== null) {
      // A stream decodes past a size limit, an image declares more pixels than allowed, or a WOFF2 passes the codec limits: 413.
      return createProblemDetailsResponse(limitStatus, error instanceof Error ? error.message : String(error), instanceUri);
    }
    if (isUnprocessableInputError(error)) {
      // The file is intact but encrypted, password protected, DRM protected or coded with a method this engine does not
      // decode (an archive's password and method errors included), a DWG release or drawing the DWG reader refuses, or a font FontForge
      // cannot read in full: 422, not the 400 of a malformed input.
      return createProblemDetailsResponse(error.status, error.message, instanceUri);
    }
    if (error instanceof WorkerOutputMissingError) {
      // A server fault, not a verdict on the input: answer 500 without the worker's file name.
      console.error('[convert/batch] Worker output vanished before it was read:', error);
      return createProblemDetailsResponse(error.status, WORKER_OUTPUT_MISSING_DETAIL, instanceUri, 'Internal Server Error');
    }
    if (error instanceof ConversionFailedError) {
      // Typed input rejection (spoofed signature, unsupported pair, malformed input): fail closed with 400.
      return createProblemDetailsResponse(400, error.message, instanceUri);
    }
    const message = error instanceof Error ? error.message : 'Batch conversion failed';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  } finally {
    releaseSlot?.();
  }
}));

interface PlannedFile {
  file: File;
  extension: string;
  targetFormat: string;
}

/**
 * Converts the planned files under one deadline and answers the archive of the converted ones. The batch is charged one
 * conversion for each file in the archive; a file of an unknown format was never planned, so it reserved nothing.
 */
async function convertPlanned(
  req: NextRequest,
  caller: User,
  planned: PlannedFile[],
  defaultOptions: ConversionOptions,
  unit: ReservedUnit
): Promise<NextResponse> {
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

  const convertedFiles: { filename: string; buffer: Buffer }[] = [];
  const usedNames = new Set<string>();

  // Nothing to convert needs no deadline, and the route answers it below.
  await runUnderDeadline(req, Math.max(batchDeadlineMs, 1), async (limits) => {
    for (const { file, extension, targetFormat } of planned) {
      limits.signal.throwIfAborted();
      const arrayBuffer = await file.arrayBuffer();
      const inputBuffer = Buffer.from(arrayBuffer);

      const result = await dispatchConversion(
        inputBuffer,
        extension,
        targetFormat,
        bindJobLimits(withTierPageCap(defaultOptions, tierMaxPages(caller.tier)), limits),
        file.name
      );

      let finalName = result.filename;
      let counter = 1;
      while (usedNames.has(finalName)) {
        const ext = finalName.includes('.') ? `.${finalName.split('.').pop()}` : '';
        const nameWithoutExt = finalName.replace(/\.[^/.]+$/, '');
        finalName = `${nameWithoutExt} (${counter})${ext}`;
        counter++;
      }
      usedNames.add(finalName);

      convertedFiles.push({
        filename: finalName,
        buffer: result.buffer,
      });
    }
  });

  if (convertedFiles.length === 0) {
    return NextResponse.json(
      { success: false, error: 'No files were successfully converted in batch.' },
      { status: 400 }
    );
  }

  const zipResult = await createZipArchive(convertedFiles, defaultOptions, 'easyconvert_batch.zip');

  await unit.settle(convertedFiles.length);

  return new NextResponse(new Uint8Array(zipResult.buffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="easyconvert_batch.zip"',
      'Content-Length': zipResult.size.toString(),
      'X-Zero-Data-Retention': 'true',
      'X-Storage-Footprint': '0-bytes',
    },
  });
}
