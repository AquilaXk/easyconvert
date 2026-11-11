import { NextRequest, NextResponse } from 'next/server';
import { clearSessionCookies, revokeSession } from '@/lib/auth/session';
import { sessionTokenFromCookieHeader } from '@/lib/auth/session-cookie';
import { verifyJwt } from '@/lib/auth/jwt';
import type { SessionPayload } from '@/lib/auth/types';
import { AuthStoreUnavailableError } from '@/lib/auth/store-unavailable';
import { authStoreUnavailableRefusal } from '@/lib/api/problem-details';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  let token = sessionTokenFromCookieHeader(req?.headers?.get('cookie'));

  if (!token && req?.headers) {
    const authHeader = req.headers.get('authorization');
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    }
  }


  if (token) {
    const payload = verifyJwt<SessionPayload>(token);
    if (payload?.jti) {
      const now = Math.floor(Date.now() / 1000);
      const remainingSeconds = payload.exp ? Math.max(1, payload.exp - now) : 7 * 86400;
      try {
        await revokeSession(payload.jti, remainingSeconds);
      } catch (error) {
        // The session is still valid when its revocation was not stored: say so, and keep the cookie so the sign-out is tried again.
        if (error instanceof AuthStoreUnavailableError) return authStoreUnavailableRefusal(error);
        throw error;
      }
    }
  }

  const response = NextResponse.json({
    success: true,
    message: 'Signed out successfully',
  });

  for (const cleared of clearSessionCookies()) response.headers.append('Set-Cookie', cleared);
  return response;
}

