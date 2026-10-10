import { NextRequest, NextResponse } from 'next/server';
import { createZipArchive } from '@/lib/conversions';
import { dispatchConversion } from '@/lib/conversions/dispatch';
import { conversionDeadlineMs, syncDeadlineMs, tierMaxDeadlineMs } from '@/lib/queue/job-deadline';
import { acquireSyncSlot, concurrencyLimitResponse } from '@/lib/queue/concurrency-limit';
import { bindJobLimits } from '@/lib/conversions/job-time';
import { deadlineErrorResponse, runUnderDeadline } from '@/lib/api/sync-deadline';
import { payloadLimitStatus } from '@/lib/api/payload-limit';
import { detectFormatFromFilename } from '@/lib/registry';
import { tierMaxPages, withTierPageCap } from '@/lib/conversions/page-range';
import {
  ConversionOptions,
  ConversionFailedError,
  EngineUnavailableError,
  ArchiveEntryCollisionError,
  EncryptedOfficeDocumentError,
  PdfPostprocessError,
  WorkerOutputMissingError,
  WORKER_OUTPUT_MISSING_DETAIL,
} from '@/lib/types';
import { validateApiAccess, authErrorHeaders, commitQuota, rollbackQuota } from '@/lib/api-keys/guard';
import {
  createProblemDetailsResponse,
  createEngineUnavailableResponse,
  createPdfPostprocessResponse,
} from '@/lib/api/problem-details';
import { isConversionOptionsObject } from '@/lib/conversions/options-guard';

export const dynamic = 'force-dynamic';

// Maximum allowed payload for real-time zero-retention in-memory conversion
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

export async function POST(req: NextRequest) {
  const instanceUri = req.nextUrl?.pathname || '/api/convert/batch';
  let reservationId: string | undefined;
  // At most five conversions in flight for an anonymous or free caller (the slot is held until the request ends).
  let releaseSlot: (() => void) | undefined;

  /** The 429 of a caller over its concurrency limit, after releasing the quota reservation. */
  const failWithRollbackProblem = async (limit: number) => {
    if (reservationId) {
      await rollbackQuota(reservationId);
    }
    return concurrencyLimitResponse(limit, instanceUri);
  };

  const failWithRollback = async (status: number, error: string) => {
    if (reservationId) {
      await rollbackQuota(reservationId);
    }
    return NextResponse.json({ success: false, error }, { status });
  };

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

    // 1. Guard check: Authenticate API key/session or enforce anonymous IP rate limit & daily quota
    const auth = await validateApiAccess(req, {
      requiredUnits: files.length,
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

    reservationId = auth.reservationId;

    const slot = await acquireSyncSlot(auth.user.id, auth.user.tier);
    if (!slot.granted) {
      return await failWithRollbackProblem(slot.limit);
    }
    releaseSlot = slot.release;

    let totalBatchSize = 0;
    for (const f of files) {
      if (f.size === 0) {
        return await failWithRollback(400, `Batch payload contains empty file "${f.name}". File buffer has 0 bytes.`);
      }
      if (f.size > MAX_FILE_SIZE) {
        return await failWithRollback(
          400,
          `File "${f.name}" exceeds real-time in-memory conversion limit (100 MB). To ensure zero-retention privacy and instant processing without cloud storage footprint, files larger than 100 MB are not supported.`
        );
      }
      totalBatchSize += f.size;
    }

    if (totalBatchSize > MAX_FILE_SIZE) {
      return await failWithRollback(
        400,
        'Total batch payload size exceeds real-time in-memory conversion limit (100 MB). To ensure zero-retention privacy and instant processing without cloud storage footprint, batch conversions exceeding 100 MB are not supported.'
      );
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

    let defaultOptions: ConversionOptions = {};
    if (optionsRaw) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(optionsRaw);
      } catch {
        return NextResponse.json(
          { success: false, error: 'Invalid JSON for options.' },
          { status: 400 }
        );
      }
      if (!isConversionOptionsObject(parsed)) {
        return await failWithRollback(400, 'The "options" field must be a JSON object.');
      }
      defaultOptions = parsed;
    }

    const planned: Array<{ file: File; extension: string; targetFormat: string }> = [];
    for (const file of files) {
      const detected = detectFormatFromFilename(file.name);
      if (!detected) continue;
      const targetFormat = targetFormatsMap[file.name] || targetFormatsMap['default'] || detected.targetFormats[0];
      if (!targetFormat) continue;
      planned.push({ file, extension: detected.extension, targetFormat });
    }

    // One deadline for the whole batch: the files' deadlines added up, never above the maximum of the tier.
    const batchDeadlineMs = syncDeadlineMs(Math.min(
      planned.reduce(
        (total, item) =>
          total +
          conversionDeadlineMs({
            tier: auth.user?.tier,
            sourceFormat: item.extension,
            targetFormat: item.targetFormat,
            inputBytes: item.file.size,
          }),
        0
      ),
      tierMaxDeadlineMs(auth.user.tier)
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
          bindJobLimits(withTierPageCap(defaultOptions, tierMaxPages(auth.user?.tier)), limits),
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
      if (reservationId) {
        await rollbackQuota(reservationId);
      }
      return NextResponse.json(
        { success: false, error: 'No files were successfully converted in batch.' },
        { status: 400 }
      );
    }

    const zipResult = await createZipArchive(convertedFiles, defaultOptions, 'easyconvert_batch.zip');

    if (reservationId) {
      await commitQuota(reservationId);
    }

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
  } catch (error: unknown) {
    if (reservationId) {
      // Only a successful conversion is charged: a deadline or a departed client refunds the unit like any failure.
      await rollbackQuota(reservationId);
    }
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
    if (error instanceof EncryptedOfficeDocumentError) {
      // The file is intact but encrypted, password protected or DRM protected: 422, not the 400 of a malformed input.
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
}
