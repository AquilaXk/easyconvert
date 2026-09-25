import { NextResponse } from 'next/server';
import { getAllFormats } from '@/lib/registry';

export const dynamic = 'force-dynamic';

export async function GET() {
  const formats = getAllFormats();
  return NextResponse.json({
    status: 'healthy',
    service: 'EasyConvert',
    version: '0.2.0',
    timestamp: new Date().toISOString(),
    supportedFormatsCount: formats.length,
    domainsCount: 9,
    features: {
      imageProcessing: true,
      documentProcessing: true,
      dataTransformation: true,
      archiveBundling: true,
      mediaProcessing: true,
      officeProcessing: true,
      ocrEngine: true,
      jobQueue: true,
      s3ChunkedStorage: true,
    },
  });
}
