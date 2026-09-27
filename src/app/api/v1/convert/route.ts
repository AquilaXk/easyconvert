import { NextRequest, NextResponse } from 'next/server';
import { validateApiAccess } from '@/lib/api-keys/guard';
import { keyStore } from '@/lib/api-keys/key-store';
import { convertFile } from '@/lib/conversions';
import { detectFormatFromFilename, getFormatByExtension } from '@/lib/registry';
import type { ConversionOptions } from '@/lib/types';

export const dynamic = 'force-dynamic';

const MAX_PROGRAMMATIC_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

export async function POST(req: NextRequest) {
  const startTime = Date.now();

  // 1. Guard check (API key verification + daily quota decrement)
  const auth = await validateApiAccess(req, 1);
  if (!auth.authorized || !auth.user) {
    return NextResponse.json(
      {
        success: false,
        error: auth.error || 'Unauthorized',
      },
      { status: auth.status || 401 }
    );
  }

  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const targetFormat = formData.get('targetFormat') as string | null;
    const optionsRaw = formData.get('options') as string | null;

    if (!file) {
      return NextResponse.json(
        { success: false, error: 'Missing required "file" in multipart request.' },
        { status: 400 }
      );
    }

    if (file.size === 0) {
      return NextResponse.json(
        { success: false, error: 'File payload is empty (0 bytes).' },
        { status: 400 }
      );
    }

    if (file.size > MAX_PROGRAMMATIC_FILE_SIZE) {
      return NextResponse.json(
        {
          success: false,
          error: `File size exceeds the 100 MB memory conversion boundary.`,
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

    // Determine input format
    const sourceFormatParam = formData.get('sourceFormat') as string | null;
    let sourceDef = sourceFormatParam ? getFormatByExtension(sourceFormatParam) : undefined;
    if (!sourceDef) {
      sourceDef = detectFormatFromFilename(file.name);
    }

    if (!sourceDef) {
      return NextResponse.json(
        { success: false, error: `Could not identify source format for file "${file.name}".` },
        { status: 400 }
      );
    }

    const tgt = targetFormat.toLowerCase().replace(/^\./, '').trim();
    const targetDef = getFormatByExtension(tgt);
    if (!targetDef) {
      return NextResponse.json(
        { success: false, error: `Unsupported target format "${targetFormat}".` },
        { status: 400 }
      );
    }

    if (!sourceDef.targetFormats.includes(tgt) && !sourceDef.targetFormats.includes(targetDef.id)) {
      return NextResponse.json(
        {
          success: false,
          error: `Conversion from ${sourceDef.id.toUpperCase()} to ${targetDef.id.toUpperCase()} is not currently supported.`,
        },
        { status: 400 }
      );
    }

    // Parse options
    let options: ConversionOptions = {};
    if (optionsRaw) {
      try {
        options = JSON.parse(optionsRaw);
      } catch {
        return NextResponse.json(
          { success: false, error: 'Invalid JSON string provided in "options" field.' },
          { status: 400 }
        );
      }
    }

    // Convert
    const arrayBuffer = await file.arrayBuffer();
    const inputBuffer = Buffer.from(arrayBuffer);

    const conversionResult = await convertFile(
      inputBuffer,
      sourceDef.id,
      targetDef.id,
      options,
      file.name
    );

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
