import { NextRequest, NextResponse } from 'next/server';
import { validateApiAccess, authErrorHeaders } from '@/lib/api-keys/guard';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import { listOcrLanguages } from '@/lib/conversions/ocr-language-data';
import { OCR_MAX_LANGUAGES_PER_REQUEST } from '@/lib/conversions/ocr-languages';

export const dynamic = 'force-dynamic';

const LANGUAGES_PATH = '/api/v1/ocr/languages';
/** The installed set is read once at start and changes only with a restart, so a short private cache is safe. */
const LANGUAGES_CACHE_CONTROL = 'private, max-age=300';

/** The OCR languages with their codes, scripts and whether this server has the data. */
export async function GET(req: NextRequest) {
  const auth = await validateApiAccess(req, { requiredUnits: 0, requiredScope: 'convert:read' });
  if (!auth.authorized || !auth.user) {
    return createProblemDetailsResponse(
      auth.status ?? 401,
      auth.error ?? 'Unauthorized',
      req.nextUrl?.pathname || LANGUAGES_PATH,
      undefined,
      auth.problemType,
      authErrorHeaders(auth)
    );
  }
  return NextResponse.json(
    { success: true, languages: listOcrLanguages(), maxLanguagesPerRequest: OCR_MAX_LANGUAGES_PER_REQUEST },
    { status: 200, headers: { 'Cache-Control': LANGUAGES_CACHE_CONTROL } }
  );
}
