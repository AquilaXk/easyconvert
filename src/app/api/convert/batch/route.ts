import { NextRequest, NextResponse } from 'next/server';
import { convertFile, createZipArchive } from '@/lib/conversions';
import { detectFormatFromFilename } from '@/lib/registry';
import { ConversionOptions } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
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
      try {
        defaultOptions = JSON.parse(optionsRaw);
      } catch {
        return NextResponse.json(
          { success: false, error: 'Invalid JSON for options.' },
          { status: 400 }
        );
      }
    }

    const convertedFiles: { filename: string; buffer: Buffer }[] = [];
    const usedNames = new Set<string>();

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const detected = detectFormatFromFilename(file.name);
      if (!detected) continue;

      const targetFormat = targetFormatsMap[file.name] || targetFormatsMap['default'] || detected.targetFormats[0];
      if (!targetFormat) continue;

      const arrayBuffer = await file.arrayBuffer();
      const inputBuffer = Buffer.from(arrayBuffer);

      const result = await convertFile(
        inputBuffer,
        detected.extension,
        targetFormat,
        defaultOptions,
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

    if (convertedFiles.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No files were successfully converted in batch.' },
        { status: 400 }
      );
    }

    const zipResult = await createZipArchive(convertedFiles, defaultOptions, 'easyconvert_batch.zip');

    return new NextResponse(new Uint8Array(zipResult.buffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="easyconvert_batch.zip"',
        'Content-Length': zipResult.size.toString(),
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Batch conversion failed';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
