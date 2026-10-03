import { NextRequest, NextResponse } from 'next/server';
import {
  exchangeGoogleCode,
  consumeOAuthSession,
  getAppOrigin,
  OAUTH_STATE_COOKIE_NAME,
} from '@/lib/auth/oauth';
import { redisUserStore } from '@/lib/auth/redis-user-store';
import { createSessionToken, createSessionCookie, getSessionFromRequest } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');

  const origin = getAppOrigin(req);
  const redirectUri = `${origin}/api/auth/google/callback`;

  if (!code) {
    return NextResponse.redirect(new URL('/auth?error=oauth_code_missing', req.url));
  }

  // 1. Validate state parameter exists
  if (!state) {
    return NextResponse.redirect(new URL('/auth?error=invalid_oauth_state', req.url));
  }

  // 2. Cookie-to-state binding verification (Login CSRF Defense)
  const stateCookie = req.cookies.get(OAUTH_STATE_COOKIE_NAME)?.value;
  if (stateCookie && stateCookie !== state) {
    return NextResponse.redirect(new URL('/auth?error=invalid_oauth_state', req.url));
  }

  // 3. Atomically consume OAuth state from Redis or local cache
  const oauthSession = await consumeOAuthSession(state);
  if (!oauthSession) {
    return NextResponse.redirect(new URL('/auth?error=invalid_oauth_state', req.url));
  }

  try {
    const googleProfile = await exchangeGoogleCode(code, redirectUri, oauthSession.codeVerifier);
    let userRecord = await redisUserStore.findByEmail(googleProfile.email);

    if (!userRecord) {
      userRecord = await redisUserStore.createUser({
        email: googleProfile.email,
        name: googleProfile.name,
        avatarUrl: googleProfile.picture,
        tier: 'free',
        provider: 'google',
      });
    } else if (userRecord.provider === 'google') {
      if (googleProfile.picture && !userRecord.avatarUrl) {
        userRecord = (await redisUserStore.updateUser(userRecord.id, {
          avatarUrl: googleProfile.picture,
        })) || userRecord;
      }
    } else {
      // Pre-account hijacking protection: prevent silent takeover of email/password accounts
      const currentSessionUser = await getSessionFromRequest(req);
      if (currentSessionUser && currentSessionUser.id === userRecord.id) {
        userRecord = (await redisUserStore.updateUser(userRecord.id, {
          avatarUrl: googleProfile.picture || userRecord.avatarUrl,
          provider: 'google',
        })) || userRecord;
      } else {
        return NextResponse.redirect(
          new URL(`/auth?error=account_linking_required&email=${encodeURIComponent(googleProfile.email)}`, req.url)
        );
      }
    }

    const user = redisUserStore.sanitizeUser(userRecord);
    const token = createSessionToken(user);
    const sessionCookieHeader = createSessionCookie(token);

    const redirectResponse = NextResponse.redirect(new URL('/dashboard', req.url));
    redirectResponse.headers.append('Set-Cookie', sessionCookieHeader);

    // Clear the OAuth state cookie
    const isProd = process.env.NODE_ENV === 'production';
    const clearStateCookie = `${OAUTH_STATE_COOKIE_NAME}=; Path=/api/auth/google; Max-Age=0; HttpOnly; SameSite=Lax; ${isProd ? 'Secure;' : ''}`;
    redirectResponse.headers.append('Set-Cookie', clearStateCookie);

    return redirectResponse;
  } catch (err: unknown) {
    const errorMsg = encodeURIComponent(err instanceof Error ? err.message : 'oauth_exchange_failed');
    return NextResponse.redirect(new URL(`/auth?error=${errorMsg}`, req.url));
  }
}

