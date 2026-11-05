import { NextRequest, NextResponse } from 'next/server';
import { EdgeOcrError } from '@/lib/edge-ocr';
import {
  OCR_ASSET_CACHE_CONTROL,
  OCR_ASSET_CSP,
  loadVerifiedOcrAsset,
} from '@/lib/edge-ocr/assets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HTTP_NOT_FOUND = 404;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const PROBLEM_NOT_FOUND = 'https://api.easyconvert.io/problems/not-found';
const PROBLEM_OCR_ASSET_INTEGRITY = 'https://api.easyconvert.io/problems/ocr-asset-integrity-failed';

function problemJson(status: number, type: string, title: string, detail: string, instance: string): NextResponse {
  return new NextResponse(
    JSON.stringify({
      type,
      title,
      status,
      detail,
      instance,
    }),
    {
      status,
      headers: {
        'Content-Type': 'application/problem+json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    }
  );
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ version: string; asset: string[] }> }
): Promise<NextResponse> {
  const { version, asset } = await params;
  const segments = Array.isArray(asset) ? asset : [asset];
  try {
    const res = loadVerifiedOcrAsset(version, segments);
    if (res.status === HTTP_NOT_FOUND) {
      return problemJson(HTTP_NOT_FOUND, PROBLEM_NOT_FOUND, 'Not Found', res.detail, request.nextUrl.pathname);
    }
    return new NextResponse(new Uint8Array(res.body), {
      status: 200,
      headers: {
        'Content-Type': res.contentType,
        'Content-Length': String(res.body.byteLength),
        'Cache-Control': OCR_ASSET_CACHE_CONTROL,
        'Content-Security-Policy': OCR_ASSET_CSP,
        'X-Content-Type-Options': 'nosniff',
        ETag: `"sha256-${res.sha256}"`,
      },
    });
  } catch (err: unknown) {
    const detail = err instanceof EdgeOcrError ? err.message : 'Failed to load verified OCR asset.';
    return problemJson(
      HTTP_INTERNAL_SERVER_ERROR,
      PROBLEM_OCR_ASSET_INTEGRITY,
      'OCR Asset Integrity Error',
      detail,
      request.nextUrl.pathname
    );
  }
}
