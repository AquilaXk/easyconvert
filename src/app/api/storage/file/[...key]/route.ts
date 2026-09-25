import { NextRequest, NextResponse } from 'next/server';
import { s3Storage } from '@/lib/storage/s3-storage';

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: { key: string[] } }
) {
  const rawKey = Array.isArray(params.key) ? params.key.join('/') : params.key;
  const fullKey = decodeURIComponent(rawKey);

  const stored = s3Storage.getObject(fullKey) || s3Storage.getObject(rawKey);
  if (!stored) {
    return NextResponse.json(
      { success: false, error: `Object not found for key: "${fullKey}"` },
      { status: 404 }
    );
  }

  // Support HTTP Range requests
  const range = req.headers.get('range');
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stored.size - 1;
    const chunkSize = end - start + 1;
    const chunkBuffer = stored.buffer.subarray(start, end + 1);

    return new NextResponse(new Uint8Array(chunkBuffer), {
      status: 206,
      headers: {
        'Content-Range': `bytes ${start}-${end}/${stored.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize.toString(),
        'Content-Type': stored.mimeType,
        'ETag': stored.etag,
      },
    });
  }

  return new NextResponse(new Uint8Array(stored.buffer), {
    status: 200,
    headers: {
      'Content-Type': stored.mimeType,
      'Content-Disposition': `attachment; filename="${stored.filename}"`,
      'Content-Length': stored.size.toString(),
      'ETag': stored.etag,
      'Cache-Control': 'public, max-age=86400, immutable',
    },
  });
}
