import { NextRequest, NextResponse } from 'next/server';
import { convertFile } from '@/lib/conversions';
import { detectFormatFromFilename } from '@/lib/registry';
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

    const detectedDef = detectFormatFromFilename(file.name);
    if (!detectedDef) {
      return NextResponse.json(
        {
          success: false,
          error: `Could not determine file format from filename "${file.name}". Ensure it has a valid extension.`,
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
      targetFormat,
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
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
