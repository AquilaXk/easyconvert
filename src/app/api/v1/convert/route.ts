import { NextRequest, NextResponse } from 'next/server';
import { validateApiAccess } from '@/lib/api-keys/guard';
import { keyStore } from '@/lib/api-keys/key-store';
import { convertFile } from '@/lib/conversions';
import { detectFormatFromFilename, getFormatByExtension } from '@/lib/registry';
import type { FormatDefinition, ConversionOptions } from '@/lib/types';

export const dynamic = 'force-dynamic';

const MAX_PROGRAMMATIC_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

interface ValidatedConvertInput {
  file: File;
  sourceDef: FormatDefinition;
  targetDef: FormatDefinition;
  options: ConversionOptions;
}

function parseConvertFormData(formData: FormData): { error?: string; status?: number; data?: ValidatedConvertInput } {
  const file = formData.get('file') as File | null;
  const targetFormat = formData.get('targetFormat') as string | null;
  const optionsRaw = formData.get('options') as string | null;

  if (!file) {
    return { error: 'Missing required "file" in multipart request.', status: 400 };
  }

  if (file.size === 0) {
    return { error: 'File payload is empty (0 bytes).', status: 400 };
  }

  if (file.size > MAX_PROGRAMMATIC_FILE_SIZE) {
    return { error: 'File size exceeds the 100 MB memory conversion boundary.', status: 400 };
  }

  if (!targetFormat) {
    return { error: 'Missing required "targetFormat" parameter.', status: 400 };
  }

  const sourceFormatParam = formData.get('sourceFormat') as string | null;
  let sourceDef = sourceFormatParam ? getFormatByExtension(sourceFormatParam) : undefined;
  sourceDef ??= detectFormatFromFilename(file.name);

  if (!sourceDef) {
    return { error: `Could not identify source format for file "${file.name}".`, status: 400 };
  }

  const tgt = targetFormat.toLowerCase().replace(/^\./, '').trim();
  const targetDef = getFormatByExtension(tgt);
  if (!targetDef) {
    return { error: `Unsupported target format "${targetFormat}".`, status: 400 };
  }

  if (!sourceDef.targetFormats.includes(tgt) && !sourceDef.targetFormats.includes(targetDef.id)) {
    return {
      error: `Conversion from ${sourceDef.id.toUpperCase()} to ${targetDef.id.toUpperCase()} is not currently supported.`,
      status: 400,
    };
  }

  let options: ConversionOptions = {};
  if (optionsRaw) {
    try {
      options = JSON.parse(optionsRaw);
    } catch {
      return { error: 'Invalid JSON string provided in "options" field.', status: 400 };
    }
  }

  return { data: { file, sourceDef, targetDef, options } };
}

export async function POST(req: NextRequest) {
  const startTime = Date.now();

  // 1. Guard check: Authenticate and check quota remaining (do not consume yet)
  const auth = await validateApiAccess(req, 0);
  if (!auth.authorized || !auth.user) {
    return NextResponse.json(
      {
        success: false,
        error: auth.error ?? 'Unauthorized',
      },
      { status: auth.status ?? 401 }
    );
  }

  try {
    const formData = await req.formData();
    const validation = parseConvertFormData(formData);
    if (validation.error || !validation.data) {
      return NextResponse.json(
        { success: false, error: validation.error },
        { status: validation.status ?? 400 }
      );
    }

    const { file, sourceDef, targetDef, options } = validation.data;
    const arrayBuffer = await file.arrayBuffer();
    const inputBuffer = Buffer.from(arrayBuffer);

    // Convert
    const conversionResult = await convertFile(
      inputBuffer,
      sourceDef.id,
      targetDef.id,
      options,
      file.name
    );

    // 2. Consume quota unit upon SUCCESSFUL conversion
    const quotaResult = await keyStore.recordUsage(auth.user.id, 1);
    if (!quotaResult.allowed) {
      return NextResponse.json(
        {
          success: false,
          error: `Daily conversion quota exceeded for tier '${auth.user.tier}'. Please upgrade or wait for the midnight UTC reset.`,
        },
        { status: 429 }
      );
    }

    const durationMs = Date.now() - startTime;
    const outputBuffer = conversionResult.buffer;
    const base64Data = outputBuffer.toString('base64');
    const dataUri = `data:${conversionResult.mimeType};base64,${base64Data}`;

    // Record in user's file conversion history
    const baseName = file.name.replace(/\.[^/.]+$/, '');
    const outFileName = `${baseName}.${targetDef.extension || targetDef.id}`;

    const userFile = await keyStore.recordUserFile({
      userId: auth.user.id,
      fileName: outFileName,
      fromFormat: sourceDef.id,
      toFormat: targetDef.id,
      size: outputBuffer.length,
      downloadUrl: dataUri,
    });

    // Check if raw binary is requested
    const wantsRaw = req.headers.get('accept') === 'application/octet-stream' || req.nextUrl.searchParams.get('raw') === 'true';
    if (wantsRaw) {
      return new NextResponse(new Uint8Array(outputBuffer), {
        status: 200,
        headers: {
          'Content-Type': conversionResult.mimeType,
          'Content-Disposition': `attachment; filename="${outFileName}"`,
          'X-Conversion-Time-Ms': durationMs.toString(),
          'X-File-Id': userFile.id,
        },
      });
    }

    return NextResponse.json({
      success: true,
      fileId: userFile.id,
      fileName: outFileName,
      sourceFormat: sourceDef.id,
      targetFormat: targetDef.id,
      mimeType: conversionResult.mimeType,
      size: outputBuffer.length,
      durationMs,
      dataUri,
      expiresAt: userFile.expiresAt,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal programmatic conversion error';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
