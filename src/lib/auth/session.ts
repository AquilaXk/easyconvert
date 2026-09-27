import { signJwt, verifyJwt } from './jwt';
import { userStore } from './user-store';
import type { SessionPayload, User } from './types';

export const SESSION_COOKIE_NAME = 'easyconvert_session';
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60; // 7 days

/**
 * Creates an RFC 7519 JWT session token for an authenticated user.
 */
export function createSessionToken(user: User): string {
  const payload: Omit<SessionPayload, 'iat' | 'exp'> = {
    sub: user.id,
    email: user.email,
    name: user.name,
    tier: user.tier,
  };
  return signJwt(payload, undefined, SESSION_MAX_AGE_SECONDS);
}

/**
 * Formats a Set-Cookie header string for the session token.
 */
export function createSessionCookie(token: string): string {
  const isProd = process.env.NODE_ENV === 'production';
  const cookieParts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    'Path=/',
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
    'HttpOnly',
    'SameSite=Lax',
  ];

  if (isProd) {
    cookieParts.push('Secure');
  }

  return cookieParts.join('; ');
}

/**
 * Formats a Set-Cookie header string to invalidate/clear the session cookie.
 */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

/**
 * Extracts and verifies the authenticated user from an incoming Request.
 * Supports HttpOnly session cookie and Authorization: Bearer <jwt> header.
 */
export async function getSessionFromRequest(request: Request): Promise<User | null> {
  let token: string | null = null;

  // 1. Check Cookie header
  const cookieHeader = request.headers.get('cookie');
  if (cookieHeader) {
    const cookies = cookieHeader.split(';').map((c) => c.trim());
    for (const c of cookies) {
      if (c.startsWith(`${SESSION_COOKIE_NAME}=`)) {
        token = c.substring(SESSION_COOKIE_NAME.length + 1);
        break;
      }
    }
  }

  // 2. Check Authorization header
  if (!token) {
    const authHeader = request.headers.get('authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    }
  }

  if (!token) {
    return null;
  }

  const payload = verifyJwt<SessionPayload>(token);
  if (!payload || !payload.sub) {
    return null;
  }

  const userRecord = await userStore.findById(payload.sub);
  if (!userRecord) {
    return null;
  }

  return userStore.sanitizeUser(userRecord);
}
