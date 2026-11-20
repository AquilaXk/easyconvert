import { NextRequest, NextResponse } from 'next/server';
import { renderOgCardPng } from '@/lib/og/render-card';
import { isValidOgLocale, resolveOgCardSpec, validateOgPathname } from '@/lib/og/resolve-card';
import { PROBLEM_TYPE_BASE } from '@/lib/refusal-codes';

export const runtime = 'nodejs';

const OG_CACHE_CONTROL = 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400';
const MAX_CACHED_OG_CARDS = 64;
const renderedCardCache = new Map<string, Uint8Array>();

function getCachedCard(key: string): Uint8Array | undefined {
  const hit = renderedCardCache.get(key);
  if (!hit) return undefined;
  renderedCardCache.delete(key);
  renderedCardCache.set(key, hit);
  return hit;
}

function putCachedCard(key: string, png: Uint8Array): void {
  renderedCardCache.delete(key);
  renderedCardCache.set(key, png);
  while (renderedCardCache.size > MAX_CACHED_OG_CARDS) {
    const oldest = renderedCardCache.keys().next().value;
    if (oldest === undefined) break;
    renderedCardCache.delete(oldest);
  }
}

function errorResponse(status: 400 | 404, detail: string): NextResponse {
  return NextResponse.json(
    {
      type:
        status === 400
          ? `${PROBLEM_TYPE_BASE}bad-request`
          : `${PROBLEM_TYPE_BASE}not-found`,
      title: status === 400 ? 'Bad Request' : 'Not Found',
      status,
      detail,
    },
    { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } }
  );
}

export async function GET(request: NextRequest): Promise<Response> {
  const rawLocale = request.nextUrl.searchParams.get('locale') ?? 'en';
  if (!isValidOgLocale(rawLocale)) {
    return errorResponse(400, 'Unsupported social preview locale.');
  }

  const rawPath = request.nextUrl.searchParams.get('path') ?? '/';
  const pathname = validateOgPathname(rawPath);
  if (!pathname) {
    return errorResponse(400, 'Invalid social preview path.');
  }

  const spec = await resolveOgCardSpec(rawLocale, pathname);
  if (!spec) {
    return errorResponse(404, 'No public page exists at the requested social preview path.');
  }

  const cacheKey = `${spec.locale}:${spec.pathname}`;
  let png = getCachedCard(cacheKey);
  if (!png) {
    png = await renderOgCardPng(spec);
    putCachedCard(cacheKey, png);
  }

  return new Response(png as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': String(png.byteLength),
      'Cache-Control': OG_CACHE_CONTROL,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
