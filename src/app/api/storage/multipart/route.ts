import { NextRequest, NextResponse } from 'next/server';
import { s3Storage } from '@/lib/storage/s3-storage';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get('action') || 'initiate';

  try {
    // 1. Initiate Multipart Upload
    if (action === 'initiate') {
      const body = await req.json();
      const { filename, mimeType, totalSize } = body;

      if (!filename || typeof totalSize !== 'number') {
        return NextResponse.json(
          { success: false, error: 'Missing "filename" or "totalSize" in initiation payload.' },
          { status: 400 }
        );
      }

      const initResult = s3Storage.initiateMultipartUpload(filename, mimeType || 'application/octet-stream', totalSize);
      return NextResponse.json({ success: true, ...initResult });
    }

    // 2. Upload Chunk Part
    if (action === 'chunk') {
      const uploadId = req.headers.get('x-upload-id') || searchParams.get('uploadId');
      const partNumberStr = req.headers.get('x-part-number') || searchParams.get('partNumber');

      if (!uploadId || !partNumberStr) {
        return NextResponse.json(
          { success: false, error: 'Missing "uploadId" or "partNumber" headers.' },
          { status: 400 }
        );
      }

      const partNumber = parseInt(partNumberStr, 10);
      const arrayBuffer = await req.arrayBuffer();
      const chunkBuffer = Buffer.from(arrayBuffer);

      if (chunkBuffer.length === 0) {
        return NextResponse.json(
          { success: false, error: 'Chunk payload is empty (0 bytes).' },
          { status: 400 }
        );
      }

      const partResult = s3Storage.uploadPart(uploadId, partNumber, chunkBuffer);
      return NextResponse.json({ success: true, ...partResult });
    }

    // 3. Complete Multipart Upload
    if (action === 'complete') {
      const body = await req.json();
      const { uploadId, parts } = body;

      if (!uploadId) {
        return NextResponse.json(
          { success: false, error: 'Missing required "uploadId" in complete request.' },
          { status: 400 }
        );
      }

      const completeResult = s3Storage.completeMultipartUpload(uploadId, parts);
      return NextResponse.json({ success: true, ...completeResult });
    }

    // 4. Abort Multipart Upload
    if (action === 'abort') {
      const body = await req.json();
      const { uploadId } = body;
      if (!uploadId) {
        return NextResponse.json({ success: false, error: 'Missing "uploadId"' }, { status: 400 });
      }

      const aborted = s3Storage.abortMultipartUpload(uploadId);
      return NextResponse.json({ success: aborted });
    }

    return NextResponse.json(
      { success: false, error: `Unknown multipart action: "${action}"` },
      { status: 400 }
    );
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Storage operation error' },
      { status: 500 }
    );
  }
}
