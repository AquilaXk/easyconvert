import { NextRequest, NextResponse } from 'next/server';
import { exchangeGoogleCode, validateOAuthState } from '@/lib/auth/oauth';
import { userStore } from '@/lib/auth/user-store';
import { createSessionToken, createSessionCookie } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const isMock = searchParams.get('mock') === 'true';

  const host = req.headers.get('host') || 'localhost:3000';
  const proto = req.headers.get('x-forwarded-proto') || 'http';
  const redirectUri = `${proto}://${host}/api/auth/google/callback`;

  if (!code) {
    return NextResponse.redirect(new URL('/auth?error=oauth_code_missing', req.url));
  }

  // State verification for CSRF mitigation (unless testing in explicit sandbox mock mode)
  if (!isMock && state && !validateOAuthState(state)) {
    return NextResponse.redirect(new URL('/auth?error=invalid_oauth_state', req.url));
  }

  try {
    const googleProfile = await exchangeGoogleCode(code, redirectUri);
    let userRecord = await userStore.findByEmail(googleProfile.email);

    if (!userRecord) {
      userRecord = await userStore.createUser({
        email: googleProfile.email,
        name: googleProfile.name,
        avatarUrl: googleProfile.picture,
        tier: 'free',
        provider: 'google',
      });
    } else if (googleProfile.picture && !userRecord.avatarUrl) {
      userRecord = (await userStore.updateUser(userRecord.id, {
        avatarUrl: googleProfile.picture,
      })) || userRecord;
    }

    const user = userStore.sanitizeUser(userRecord);
    const token = createSessionToken(user);
    const cookieHeader = createSessionCookie(token);

    const redirectResponse = NextResponse.redirect(new URL('/dashboard', req.url));
    redirectResponse.headers.set('Set-Cookie', cookieHeader);
    return redirectResponse;
  } catch (err: unknown) {
    const errorMsg = encodeURIComponent(err instanceof Error ? err.message : 'oauth_exchange_failed');
    return NextResponse.redirect(new URL(`/auth?error=${errorMsg}`, req.url));
  }
}
