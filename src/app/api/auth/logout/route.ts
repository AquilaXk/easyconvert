import { NextRequest, NextResponse } from 'next/server';
import { clearSessionCookie, SESSION_COOKIE_NAME, revokeSession } from '@/lib/auth/session';
import { verifyJwt } from '@/lib/auth/jwt';
import type { SessionPayload } from '@/lib/auth/types';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  let token: string | null = null;
  const cookieHeader = req?.headers?.get('cookie');

  if (cookieHeader) {
    const cookies = cookieHeader.split(';').map((c) => c.trim());
    for (const c of cookies) {
      if (c.startsWith(`${SESSION_COOKIE_NAME}=`)) {
        token = c.substring(SESSION_COOKIE_NAME.length + 1);
        break;
      }
    }
  }

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
      await revokeSession(payload.jti, remainingSeconds);
    }
  }

  const response = NextResponse.json({
    success: true,
    message: 'Signed out successfully',
  });

  response.headers.set('Set-Cookie', clearSessionCookie());
  return response;
}

