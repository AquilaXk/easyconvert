import { NextRequest, NextResponse } from 'next/server';
import {
  getGoogleOAuthUrl,
  createOAuthSession,
  getAppOrigin,
  OAUTH_STATE_COOKIE_NAME,
  OAUTH_STATE_TTL_SECONDS,
} from '@/lib/auth/oauth';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const origin = getAppOrigin(req);
  const redirectUri = `${origin}/api/auth/google/callback`;

  try {
    const session = await createOAuthSession();
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
    const message = err instanceof Error ? err.message : 'Failed to generate OAuth URL';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}

