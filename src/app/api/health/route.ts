import { NextResponse } from 'next/server';
import { getAllFormats } from '@/lib/registry';

export async function GET() {
  const formats = getAllFormats();
  return NextResponse.json({
    status: 'healthy',
    service: 'EasyConvert',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
    supportedFormatsCount: formats.length,
    features: {
      imageProcessing: true,
      documentProcessing: true,
      dataTransformation: true,
      archiveBundling: true,
    },
  });
}
