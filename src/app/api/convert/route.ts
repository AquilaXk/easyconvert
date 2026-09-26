import { NextRequest, NextResponse } from 'next/server';
import { convertFile } from '@/lib/conversions';
import { detectFormatFromFilename, getFormatByExtension, FORMAT_REGISTRY } from '@/lib/registry';
import { ConversionOptions } from '@/lib/types';

export const dynamic = 'force-dynamic';

// Maximum allowed payload for real-time zero-retention in-memory conversion
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

export async function POST(req: NextRequest) {
  const startTime = Date.now();

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
        { success: false, error: 'Conversion payload is empty. File buffer has 0 bytes.' },
        { status: 400 }
      );
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
    if (!detectedDef.targetFormats.includes(tgt)) {
      return NextResponse.json(
        {
          success: false,
          error: `Cannot convert from ${detectedDef.name} (.${detectedDef.extension}) to target format .${tgt}. Available targets: ${detectedDef.targetFormats.join(
            ', '
          )}`,
        },
        { status: 400 }
      );
    }

    let options: ConversionOptions = {};
    if (optionsRaw) {
      try {
        options = JSON.parse(optionsRaw);
      } catch {
        return NextResponse.json(
          { success: false, error: 'Invalid JSON format for "options" parameter.' },
          { status: 400 }
        );
      }
    }

    const arrayBuffer = await file.arrayBuffer();
    const inputBuffer = Buffer.from(arrayBuffer);

    // Perform immediate in-memory / local ephemeral conversion
    const result = await convertFile(
      inputBuffer,
      detectedDef.extension,
      tgt,
      options,
      file.name
    );

    const duration = Date.now() - startTime;

    return new NextResponse(new Uint8Array(result.buffer), {
      status: 200,
      headers: {
        'Content-Type': result.mimeType,
        'Content-Disposition': `attachment; filename="${result.filename}"`,
        'Content-Length': result.size.toString(),
        'X-Conversion-Time-Ms': duration.toString(),
        'X-Zero-Data-Retention': 'true',
        'X-Storage-Footprint': '0-bytes',
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error during conversion';
    const isValidationError =
      message.includes('payload is empty') ||
      message.includes('Cannot convert') ||
      message.includes('Unsupported') ||
      message.includes('Failed to parse') ||
      message.includes('OCR failed') ||
      message.includes('PDF OCR') ||
      message.includes('compression');
    return NextResponse.json(
      { success: false, error: message },
      { status: isValidationError ? 400 : 500 }
    );
  }
}
