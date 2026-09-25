import { NextRequest, NextResponse } from 'next/server';
import { convertFile } from '@/lib/conversions';
import { detectFormatFromFilename } from '@/lib/registry';
import { ConversionOptions } from '@/lib/types';

export const dynamic = 'force-dynamic';

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
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error during conversion';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
