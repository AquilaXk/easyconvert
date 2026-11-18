import { NextResponse } from 'next/server';
import { buildPublicOpenApiDocument } from '@/lib/api/openapi';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(buildPublicOpenApiDocument(), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
