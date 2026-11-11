import { NextRequest, NextResponse } from 'next/server';
import {
  getGoogleOAuthUrl,
  createOAuthSession,
  getAppOrigin,
  offeredLocale,
  OAUTH_STATE_COOKIE_NAME,
  OAUTH_STATE_TTL_SECONDS,
} from '@/lib/auth/oauth';
import { authStoreUnavailableRefusal, codedRefusal } from '@/lib/api/problem-details';
import { AuthStoreUnavailableError } from '@/lib/auth/store-unavailable';
import type { AuthErrorCode } from '@/lib/refusal-codes';
import { TERMS_VERSION, termsRefusal, termsRefusalText } from '@/lib/legal/documents';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const origin = getAppOrigin();
  const redirectUri = `${origin}/api/auth/google/callback`;

  try {
    const { searchParams } = req.nextUrl;
    const sentVersion = searchParams.get('acceptedTermsVersion');
    if (sentVersion !== null && termsRefusal(sentVersion) === 'terms_outdated') {
      return codedRefusal<AuthErrorCode>(400, 'terms_outdated', termsRefusalText('terms_outdated'));
    }
    const session = await createOAuthSession({
      locale: offeredLocale(searchParams.get('locale')),
      acceptedTermsVersion: sentVersion === TERMS_VERSION ? sentVersion : undefined,
    });
    const url = getGoogleOAuthUrl(redirectUri, session);

    const res = NextResponse.json({
      success: true,
      url,
    });

    const isProd = process.env.NODE_ENV === 'production';
    const cookieParts = [
      `${OAUTH_STATE_COOKIE_NAME}=${session.state}`,
      'Path=/api/auth/google',
      `Max-Age=${OAUTH_STATE_TTL_SECONDS}`,
      'HttpOnly',
      'SameSite=Lax',
    ];
    if (isProd) {
      cookieParts.push('Secure');
    }

    res.headers.set('Set-Cookie', cookieParts.join('; '));
    return res;
  } catch (err: unknown) {
    if (err instanceof AuthStoreUnavailableError) return authStoreUnavailableRefusal(err);
    const message = err instanceof Error ? err.message : 'Failed to generate OAuth URL';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}

