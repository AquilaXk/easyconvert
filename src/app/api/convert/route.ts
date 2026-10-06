import { NextRequest, NextResponse } from 'next/server';
import { dispatchConversion } from '@/lib/conversions/dispatch';
import { InputPixelLimitError } from '@/lib/conversions/image-input-limits';
import { detectFormatFromFilename, getFormatByExtension, FORMAT_REGISTRY, assertNotSpoofedFile, getAvailableTargetFormats } from '@/lib/registry';
import {
  ConversionOptions,
  ConversionFailedError,
  EngineUnavailableError,
  ArchiveEntryCollisionError,
} from '@/lib/types';
import { validateApiAccess, authErrorHeaders, commitQuota, rollbackQuota } from '@/lib/api-keys/guard';
import { validateTierPageLimit } from '@/lib/conversions';
import { createProblemDetailsResponse, createEngineUnavailableResponse } from '@/lib/api/problem-details';
import { isConversionOptionsObject } from '@/lib/conversions/options-guard';

export const dynamic = 'force-dynamic';

// Maximum allowed payload for real-time zero-retention in-memory conversion
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

export async function POST(req: NextRequest) {
  const startTime = Date.now();
  const instanceUri = req.nextUrl?.pathname || '/api/convert';

  // 1. Guard check: Authenticate API key/session or enforce anonymous IP rate limit & daily quota
  const auth = await validateApiAccess(req, {
    requiredUnits: 1,
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

  const reservationId = auth.reservationId;

  const failWithRollback = async (status: number, error: string) => {
    if (reservationId) {
      await rollbackQuota(reservationId);
    }
    return NextResponse.json({ success: false, error }, { status });
  };

  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const targetFormat = formData.get('targetFormat') as string | null;
    const optionsRaw = formData.get('options') as string | null;

    if (!file) {
      return await failWithRollback(400, 'Missing required "file" in multipart request.');
    }

    if (file.size === 0) {
      return await failWithRollback(400, 'Conversion payload is empty. File buffer has 0 bytes.');
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        {
          success: false,
          error:
            'File size exceeds real-time in-memory conversion limit (100 MB). To ensure zero-retention privacy and instant processing without cloud storage footprint, files larger than 100 MB are not supported.',
        },
        { status: 400 }
      );
    }

    if (!targetFormat) {
      return NextResponse.json(
        { success: false, error: 'Missing required "targetFormat" parameter.' },
        { status: 400 }
      );
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
      return NextResponse.json(
        {
          success: false,
          error: `Could not determine file format from filename "${file.name}". Ensure it has a valid extension.`,
        },
        { status: 400 }
      );
    }

    const tgt = targetFormat.toLowerCase().replace(/^\./, '').trim();
    const availableTargets = getAvailableTargetFormats(detectedDef.extension).map((d) => d.extension);
    if (!availableTargets.includes(tgt)) {
      return NextResponse.json(
        {
          success: false,
          error: `Cannot convert from ${detectedDef.name} (.${detectedDef.extension}) to target format .${tgt}. Available targets: ${availableTargets.join(
            ', '
          )}`,
        },
        { status: 400 }
      );
    }

    let options: ConversionOptions = {};
    if (optionsRaw) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(optionsRaw);
      } catch {
        return NextResponse.json(
          { success: false, error: 'Invalid JSON format for "options" parameter.' },
          { status: 400 }
        );
      }
      if (!isConversionOptionsObject(parsed)) {
        return await failWithRollback(400, 'The "options" field must be a JSON object.');
      }
      options = parsed;
    }

    if (options) {
      if (!options.pages && options.page) {
        options.pages = String(options.page);
      }
      if (options.pages) {
        try {
          validateTierPageLimit(options.pages, auth.user?.tier || 'free');
        } catch (err: any) {
          return await failWithRollback(422, err.message);
        }
      }
    }

    const arrayBuffer = await file.arrayBuffer();
    const inputBuffer = Buffer.from(arrayBuffer);

    // Validate file integrity against spoofed extensions fail-closed
    try {
      assertNotSpoofedFile(inputBuffer, detectedDef.extension, file.name);
    } catch (err: any) {
      return NextResponse.json(
        { success: false, error: err.message || 'File spoofing detected.' },
        { status: 400 }
      );
    }

    // Perform conversion via the shared dispatcher (native engines first, in-process where valid)
    const result = await dispatchConversion(
      inputBuffer,
      detectedDef.extension,
      tgt,
      options,
      file.name
    );

    const duration = Date.now() - startTime;

    if (reservationId) {
      await commitQuota(reservationId);
    }

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
      },
    });
  } catch (error: unknown) {
    if (reservationId) {
      await rollbackQuota(reservationId);
    }
    if (error instanceof EngineUnavailableError) {
      return createEngineUnavailableResponse(error, instanceUri);
    }
    if (error instanceof ArchiveEntryCollisionError) {
      return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    }
    if (error instanceof InputPixelLimitError) {
      return createProblemDetailsResponse(error.status, error.message, instanceUri);
    }
    const message = error instanceof Error ? error.message : 'Internal server error during conversion';
    const isValidationError =
      error instanceof ConversionFailedError ||
      message.includes('payload is empty') ||
      message.includes('Cannot convert') ||
      message.includes('Unsupported') ||
      message.includes('Failed to parse') ||
      message.includes('OCR failed') ||
      message.includes('PDF OCR') ||
      message.includes('compression') ||
      message.includes('Fail-Closed');
    return NextResponse.json(
      { success: false, error: message },
      { status: isValidationError ? 400 : 500 }
    );
  }
}
